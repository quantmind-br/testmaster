/// <reference lib="dom" />

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Locator as LocatorSpec,
  type PlanStep,
  patternMaxLength,
  validate,
} from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Download,
  errors,
  type Frame,
  type Locator,
  type Page,
} from "playwright-core";
import {
  denialDisposition,
  deniedOrigin,
  deniedSubrequestMessage,
  EgressDenials,
  isIgnoredRequest,
  webSocketRequestUrl,
} from "./egress.js";
import { authorizeUrl, canonicalUrl, HttpEngine, readAuthorizedArtifact } from "./http.js";
import { type ObservedPage, observePage } from "./observation.js";
import {
  ARTIFACT_BYTES,
  DOM_BYTES,
  pageMarkup,
  redactMarkup,
  screenshotPage,
} from "./page-evidence.js";
import {
  abortVerdict,
  type RunnerResult,
  type Runtime,
  RuntimeError,
  stepTimeoutMs,
  storageStateRefusal,
} from "./runtime.js";

type Scope = Page | Frame;
type AssertionStep = Extract<PlanStep, { operation: "assert" }>;
interface DownloadOutput {
  sizeBytes: number;
  mimeType: string;
  sha256: string;
}
const SETTLE_INTERVAL_MS = 500;
const SETTLE_LIMIT_MS = 5_000;
const LOG_BYTES = 1024 * 1024;

/**
 * Expected URL of a `urlEquals` assertion as a full href. A relative value ("/dashboard") resolves
 * against the environment base URL exactly as a navigate path does; an absolute one is kept.
 */
export function resolveExpectedUrl(expected: string, baseUrl: string | undefined): string {
  try {
    return new URL(expected, baseUrl).href;
  } catch {
    throw new RuntimeError(
      "security_precondition_failed",
      baseUrl === undefined && !/^[a-z][a-z0-9+.-]*:/iu.test(expected)
        ? "A relative expected URL requires an environment base URL"
        : "Expected URL is invalid",
    );
  }
}
/** Page URL as the same normalized href the expected value resolves to. */
function normalizedUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}
/** What a URL assertion waits for, the expectation it records, and the text of its mismatch. */
interface UrlTarget {
  holds(href: string): boolean;
  expected: string | { matches: string };
  mismatch(observed: string): string;
}
function exactUrl(expected: string): UrlTarget {
  return {
    holds: (href) => href === expected,
    expected,
    mismatch: (observed) => `Page URL ${observed} differs from expected URL ${expected}`,
  };
}
/** A `urlMatches` pattern, compiled as the plan validator compiles it (flag `u`, unanchored). */
function urlPattern(pattern: string): UrlTarget {
  let regex: RegExp;
  try {
    if (pattern.length > patternMaxLength) throw new RangeError("Pattern is too long");
    regex = new RegExp(pattern, "u");
  } catch {
    throw new RuntimeError(
      "oracle_uncertain",
      "urlMatches pattern is not a valid bounded ECMAScript regular expression",
      "inconclusive",
    );
  }
  return {
    holds: (href) => regex.test(href),
    expected: { matches: pattern },
    mismatch: (observed) => `Page URL ${observed} does not match pattern ${pattern}`,
  };
}

/** Cookie and web-storage values of a Playwright storage state (scrubbed from every artifact). */
export function storageStateSecrets(raw: string): string[] {
  const state = JSON.parse(raw) as {
    cookies?: { value?: unknown }[];
    origins?: { localStorage?: { value?: unknown }[] }[];
  };
  return [
    ...(state.cookies ?? []).map((cookie) => cookie.value),
    ...(state.origins ?? []).flatMap((origin) =>
      (origin.localStorage ?? []).map((entry) => entry.value),
    ),
  ].filter((value): value is string => typeof value === "string" && value.length >= 6);
}

export interface LoadedStorageState {
  cookies: {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Lax" | "None" | "Strict";
  }[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}
/**
 * Reads the vault storage state named by the host. Cookies for hosts outside the network policy
 * are dropped, so a state captured for one site is never replayed toward another origin.
 */
export async function loadStorageState(runtime: Runtime): Promise<LoadedStorageState | undefined> {
  const reference = runtime.input.auth?.storageState;
  if (!reference) return undefined;
  const raw = String(await runtime.resolve({ secretRef: reference.secretRef }));
  let parsed: Partial<LoadedStorageState>;
  try {
    parsed = JSON.parse(raw) as Partial<LoadedStorageState>;
  } catch {
    throw new RuntimeError("manual_auth_required", "Stored browser state is unreadable", "blocked");
  }
  // Additional origins admit page subrequests only; a stored session never reaches them.
  const additional = new Set(
    (runtime.input.networkPolicy.additionalOrigins ?? []).map(
      (origin) => canonicalUrl(origin).origin,
    ),
  );
  const hosts = new Set(
    runtime.input.networkPolicy.allowedOrigins
      .filter((origin) => !additional.has(canonicalUrl(origin).origin))
      .map((origin) => new URL(origin).hostname),
  );
  const cookies = (parsed.cookies ?? []).filter((cookie) =>
    hosts.has(String(cookie.domain ?? "").replace(/^\./u, "")),
  );
  const origins = (parsed.origins ?? []).filter((entry) => {
    try {
      return hosts.has(new URL(String(entry.origin)).hostname);
    } catch {
      return false;
    }
  });
  for (const value of storageStateSecrets(JSON.stringify({ cookies, origins })))
    runtime.secrets.add(value);
  return { cookies, origins };
}
/** One isolated browser context, with egress enforced by the supervisor's mandatory proxy. */
export async function runBrowser(runtime: Runtime): Promise<RunnerResult> {
  const unsupported = storageStateRefusal(runtime.input);
  if (unsupported) return unsupported;
  const proxy = process.env.TESTMASTER_EGRESS_PROXY;
  if (!proxy) return { outcome: "blocked", reasonCode: "security_precondition_failed" };
  let proxyUrl: URL;
  try {
    proxyUrl = new URL(proxy);
  } catch {
    return { outcome: "blocked", reasonCode: "security_precondition_failed" };
  }
  if (
    proxyUrl.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(proxyUrl.hostname) ||
    !proxyUrl.port ||
    proxyUrl.username ||
    proxyUrl.password
  )
    return { outcome: "blocked", reasonCode: "security_precondition_failed" };
  const plan = runtime.input.plan;
  if (plan?.runner !== "playwright")
    return { outcome: "blocked", reasonCode: "unsupported_capability" };
  const policy = runtime.input.policy ?? {};
  if ((policy.trace || policy.video) && policy.restrictedRaw !== true)
    return { outcome: "blocked", reasonCode: "security_precondition_failed" };
  const popupAliases = policy.popupAliases ?? [];
  if (new Set(popupAliases).size !== popupAliases.length)
    return { outcome: "blocked", reasonCode: "security_precondition_failed" };
  const http = new HttpEngine(runtime);
  const pages = new Map<string, Page>();
  const allPages: Page[] = [];
  const downloads = new Map<string, DownloadOutput>();
  const responseTypes = new Map<string, string>();
  const consoleLog: string[] = [];
  const networkLog: { method?: string; url: string; status?: number; failure?: string }[] = [];
  let logBytes = 0;
  let droppedLogs = 0;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page;
  let scope: Scope;
  let tempDirectory: string | undefined;
  let violation: RuntimeError | undefined;
  const denials = new EgressDenials();
  const ignoredOrigins = new Set(
    (runtime.input.networkPolicy.ignoredOrigins ?? []).map((entry) => canonicalUrl(entry).origin),
  );
  function recordIgnored(url: string, method: string, resourceType: string): void {
    denials.record({
      stepId: currentStepId ?? "attempt",
      url,
      method,
      resourceType,
      disposition: "ignored",
    });
  }
  let currentStepId: string | undefined;
  let popupIndex = 0;
  let expectedDownloadPage: Page | undefined;
  let result: RunnerResult = { outcome: "inconclusive", reasonCode: "insufficient_evidence" };
  const attemptTime = runtime.clock.stopwatch();
  let activeAgentStep: string | undefined;
  let activeMutationAllowed = false;
  let explorationStopped = false;
  let observationCount = 0;
  const abort = () => {
    void context?.close().catch(() => undefined);
    void browser?.close().catch(() => undefined);
  };
  runtime.signal.addEventListener("abort", abort, { once: true });

  function record(
    kind: "console" | "network",
    entry: string | { method?: string; url: string; status?: number; failure?: string },
  ): void {
    const safe =
      typeof entry === "string"
        ? runtime.scrub(entry)
        : {
            ...entry,
            url: runtime.scrub(entry.url),
            ...(entry.failure === undefined ? {} : { failure: runtime.scrub(entry.failure) }),
          };
    const bytes = Buffer.byteLength(JSON.stringify(safe));
    if (bytes > 16_384 || logBytes + bytes > LOG_BYTES) {
      droppedLogs++;
      return;
    }
    logBytes += bytes;
    if (kind === "console" && typeof safe === "string") consoleLog.push(safe);
    else if (typeof safe !== "string") networkLog.push(safe);
  }
  function deny(message: string): void {
    violation ??= new RuntimeError("egress_denied", message);
    void context?.close().catch(() => undefined);
  }
  function deadline(step: PlanStep, override?: number): number {
    const remaining = (runtime.input.timeoutMs ?? 300_000) - attemptTime.elapsed();
    if (remaining <= 0)
      throw new RuntimeError("execution_deadline", "Attempt deadline expired", "inconclusive");
    return Math.max(
      1,
      Math.min(stepTimeoutMs(step, runtime.input), override ?? Infinity, remaining),
    );
  }
  function pageFor(alias?: string): Page {
    if (alias === undefined) return page;
    const selected = pages.get(alias);
    if (!selected || selected.isClosed())
      throw new RuntimeError("security_precondition_failed", `Unavailable page alias: ${alias}`);
    return selected;
  }
  function authorizeFrame(frame: Frame): void {
    // Playwright appends the URL fragment to `frame.url()`; it never reaches the server or the proxy.
    const url = frame.url().split("#", 1)[0] ?? "";
    // A frame whose navigation was aborted shows Chromium's own error page, drawn without any
    // request; the route handler already recorded the aborted request.
    if (url !== "about:blank" && !url.startsWith("chrome-error:")) authorizeUrl(runtime, url);
  }
  async function rejectAmbiguous(locator: Locator): Promise<void> {
    const count = await locator.count();
    if (count > 1)
      throw new RuntimeError(
        "assertion_mismatch",
        `Locator is ambiguous; matched ${count}`,
        "failed",
      );
  }
  async function unique(locator: Locator, timeout: number): Promise<Locator> {
    await rejectAmbiguous(locator);
    try {
      await locator.waitFor({ state: "attached", timeout });
    } catch (error) {
      // A live page that never attaches the target within the step deadline is a reliable
      // observation (spec 03: step timeout with reliable observation is failed).
      if (error instanceof errors.TimeoutError && !runtime.signal.aborted)
        throw new RuntimeError(
          "assertion_timeout",
          "Locator did not match an attached element before the step deadline",
          "failed",
        );
      throw error;
    }
    const count = await locator.count();
    if (count !== 1)
      throw new RuntimeError(
        "assertion_mismatch",
        `Locator must match exactly one element; matched ${count}`,
        "failed",
      );
    return locator;
  }
  async function frameFrom(locator: Locator, timeout: number): Promise<Frame> {
    if (policy.allowFrames !== true)
      throw new RuntimeError("security_precondition_failed", "Frames are not authorized");
    const handle = await (await unique(locator, timeout)).elementHandle({ timeout });
    try {
      const frame = await handle?.contentFrame();
      if (!frame)
        throw new RuntimeError(
          "insufficient_evidence",
          "Locator is not an attached frame",
          "inconclusive",
        );
      authorizeFrame(frame);
      return frame;
    } finally {
      await handle?.dispose();
    }
  }
  // "wait": a container must attach (within `timeout`) and be unique before the target resolves
  // inside it. "lazy": a container is only chained, so an absent container leaves the target
  // with zero matches while an ambiguous container still fails. Absence paths and locator
  // evidence use "lazy"; a frame always has to exist.
  type ContainerMode = "wait" | "lazy";
  /**
   * Resolves a locator and applies its `nth` selection last, after pageAlias, frame and container
   * scoping. `.nth(n)` matches zero or one element, so every uniqueness check downstream passes
   * for an existing item and an out-of-range index never attaches (assertion_timeout).
   */
  async function locate(
    spec: LocatorSpec,
    timeout: number,
    base: Scope | Locator = scope,
    containers: ContainerMode = "wait",
  ): Promise<Locator> {
    const located = await locateScoped(spec, timeout, base, containers);
    return spec.nth === undefined ? located : located.nth(spec.nth);
  }
  async function locateScoped(
    spec: LocatorSpec,
    timeout: number,
    base: Scope | Locator,
    containers: ContainerMode,
  ): Promise<Locator> {
    let root: Scope | Locator = spec.pageAlias === undefined ? base : pageFor(spec.pageAlias);
    if (spec.frame) root = await frameFrom(await locate(spec.frame, timeout, root), timeout);
    if (spec.container) {
      const container = await locate(spec.container, timeout, root, containers);
      if (containers === "wait") root = await unique(container, timeout);
      else {
        await rejectAmbiguous(container);
        root = container;
      }
    }
    switch (spec.by) {
      case "testId": {
        const attributes = runtime.input.browser?.testIdAttributes ?? ["data-testid"];
        if (attributes.some((attribute) => !/^[a-zA-Z_][a-zA-Z0-9_.:-]*$/u.test(attribute)))
          throw new RuntimeError(
            "security_precondition_failed",
            "Invalid test identifier attribute",
          );
        if (attributes.length === 1 && attributes[0] === "data-testid")
          return root.getByTestId(spec.value);
        const value = [...spec.value]
          .map((character) => {
            const code = character.codePointAt(0) ?? 0;
            return code < 32 || code === 127 || character === "\\" || character === '"'
              ? `\\${code.toString(16)} `
              : character;
          })
          .join("");
        return root.locator(attributes.map((attribute) => `[${attribute}="${value}"]`).join(","));
      }
      case "role": {
        if (!("role" in spec))
          throw new RuntimeError(
            "security_precondition_failed",
            "Role locator is missing its role",
          );
        type Role = Parameters<Page["getByRole"]>[0];
        const role = spec.role as Role;
        const roleOptions: Parameters<Page["getByRole"]>[1] = {};
        if (spec.name !== undefined) roleOptions.name = spec.name;
        if (spec.exact !== undefined) roleOptions.exact = spec.exact;
        return root.getByRole(role, roleOptions);
      }
      case "label":
        return spec.exact === undefined
          ? root.getByLabel(spec.value)
          : root.getByLabel(spec.value, { exact: spec.exact });
      case "text":
        return spec.exact === undefined
          ? root.getByText(spec.value)
          : root.getByText(spec.value, { exact: spec.exact });
      case "placeholder":
        return spec.exact === undefined
          ? root.getByPlaceholder(spec.value)
          : root.getByPlaceholder(spec.value, { exact: spec.exact });
      case "css":
        return root.locator(spec.value);
    }
    throw new RuntimeError("unsupported_capability", "Unsupported locator kind");
  }
  async function stringValue(value: unknown): Promise<string> {
    const resolved = await runtime.resolve(value);
    if (typeof resolved !== "string")
      throw new RuntimeError(
        "security_precondition_failed",
        "Browser value must resolve to a string",
      );
    return resolved;
  }
  async function assertion(step: AssertionStep, timeout: number): Promise<void> {
    const { input, expectation } = step;
    if ("responseStepId" in input) {
      await http.perform(step);
      return;
    }
    if (
      expectation.predicate === "visualMatches" ||
      expectation.predicate === "accessibilityViolations"
    )
      throw new RuntimeError(
        "unsupported_capability",
        `${expectation.predicate} is not enabled in this milestone`,
      );
    if (expectation.predicate === "downloadMatches") {
      if (!("outputName" in input) || input.outputName !== expectation.outputName)
        throw new RuntimeError(
          "security_precondition_failed",
          "Download assertion must name its exact output",
        );
      const output = downloads.get(input.outputName);
      if (
        !output ||
        (expectation.sha256 !== undefined && output.sha256 !== expectation.sha256) ||
        (expectation.sizeBytes !== undefined && output.sizeBytes !== expectation.sizeBytes) ||
        (expectation.mimeType !== undefined && output.mimeType !== expectation.mimeType)
      )
        throw new RuntimeError(
          "assertion_mismatch",
          "Download metadata does not satisfy expectation",
          "failed",
        );
      return;
    }
    if (expectation.predicate === "urlEquals" || expectation.predicate === "urlMatches") {
      if (
        "locator" in input ||
        "outputName" in input ||
        "processStepId" in input ||
        "screen" in input ||
        "file" in input ||
        "clipboard" in input ||
        "responseStepId" in input
      )
        throw new RuntimeError("security_precondition_failed", "URL assertion requires page input");
      const target =
        expectation.predicate === "urlMatches"
          ? urlPattern(expectation.pattern)
          : exactUrl(
              resolveExpectedUrl(await stringValue(expectation.value), runtime.input.baseUrl),
            );
      const selected = pageFor(input.pageAlias);
      try {
        // A predicate, not the string: Playwright reads a string as a glob pattern.
        await selected.waitForURL((url) => target.holds(url.href), {
          timeout,
          waitUntil: "commit",
        });
      } catch (error) {
        // The deadline is the verdict below; any other failure (a closed page) propagates.
        if (!(error instanceof errors.TimeoutError) || runtime.signal.aborted) throw error;
      }
      const observed = normalizedUrl(selected.url());
      runtime.recordComparison(
        runtime.scrub(observed),
        typeof target.expected === "string" ? runtime.scrub(target.expected) : target.expected,
      );
      if (!target.holds(observed))
        throw new RuntimeError(
          "assertion_mismatch",
          runtime.scrub(target.mismatch(observed)),
          "failed",
        );
      return;
    }
    if (!("locator" in input))
      throw new RuntimeError("security_precondition_failed", "UI assertion requires a locator");
    const assertsAbsence =
      expectation.predicate === "hidden" ||
      ((expectation.predicate === "countEquals" || expectation.predicate === "countAtMost") &&
        expectation.value === 0);
    const locator = await locate(input.locator, timeout, scope, assertsAbsence ? "lazy" : "wait");
    if (
      expectation.predicate === "countEquals" ||
      expectation.predicate === "countAtLeast" ||
      expectation.predicate === "countAtMost"
    ) {
      const count = await locator.count();
      runtime.recordComparison(count, expectation.value);
      const [holds, bound] =
        expectation.predicate === "countEquals"
          ? [count === expectation.value, ""]
          : expectation.predicate === "countAtLeast"
            ? [count >= expectation.value, "at least "]
            : [count <= expectation.value, "at most "];
      if (!holds)
        throw new RuntimeError(
          "assertion_mismatch",
          `Expected ${bound}${expectation.value} elements, observed ${count}`,
          "failed",
        );
      return;
    }
    if (expectation.predicate === "hidden") {
      if ((await locator.count()) > 1)
        throw new RuntimeError("assertion_mismatch", "Hidden locator is ambiguous", "failed");
      await locator.waitFor({ state: "hidden", timeout });
      return;
    }
    await unique(locator, timeout);
    if (expectation.predicate === "visible") {
      await locator.waitFor({ state: "visible", timeout });
      return;
    }
    // Eventual consistency (spec 06): poll the predicate until it holds or the step deadline
    // expires, instead of judging a single sample; the last observation is retained.
    const deadline = performance.now() + timeout;
    let last: { observed: unknown; expected: unknown } | undefined;
    for (let checks = 1; ; checks++) {
      const remaining = Math.max(1, Math.floor(deadline - performance.now()));
      let observed: unknown;
      let expected: unknown;
      let holds: boolean;
      try {
        switch (expectation.predicate) {
          case "enabled":
            observed = await locator.isEnabled({ timeout: remaining });
            expected = true;
            holds = observed === true;
            break;
          case "disabled":
            observed = await locator.isDisabled({ timeout: remaining });
            expected = true;
            holds = observed === true;
            break;
          case "textEquals":
            observed = await locator.innerText({ timeout: remaining });
            expected = await stringValue(expectation.value);
            holds = observed === expected;
            break;
          case "textContains": {
            const text = await locator.innerText({ timeout: remaining });
            const part = await stringValue(expectation.value);
            observed = text;
            expected = part;
            holds = text.includes(part);
            if (holds) return;
            break;
          }
          case "valueEquals":
            observed = await locator.inputValue({ timeout: remaining });
            expected = await stringValue(expectation.value);
            holds = observed === expected;
            break;
          default:
            throw new RuntimeError(
              "unsupported_capability",
              `Predicate ${expectation.predicate} requires an HTTP response`,
            );
        }
      } catch (error) {
        // The final sample can receive only the last milliseconds of the deadline; a read that
        // times out after an earlier observation leaves that observation as the verdict.
        if (!(error instanceof errors.TimeoutError) || runtime.signal.aborted || !last) throw error;
        throw mismatch(last.observed, last.expected, checks - 1);
      }
      if (holds) {
        runtime.recordComparison(observed, expected);
        return;
      }
      last = { observed, expected };
      if (performance.now() >= deadline) throw mismatch(observed, expected, checks);
      await delay(Math.min(100, Math.max(1, deadline - performance.now())));
    }
  }
  function mismatch(observed: unknown, expected: unknown, checks: number): RuntimeError {
    runtime.recordComparison(observed, expected);
    return new RuntimeError(
      "assertion_mismatch",
      runtime.scrub(
        `Expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)} after ${checks} checks`,
      ),
      "failed",
    );
  }
  async function saveDownload(download: Download, outputName: string): Promise<void> {
    if (
      !outputName ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls in artifact output names.
      /[\u0000-\u001f\\/:]/u.test(outputName) ||
      outputName === "." ||
      outputName === ".." ||
      downloads.has(outputName)
    )
      throw new RuntimeError(
        "security_precondition_failed",
        "Download output name is unsafe or duplicated",
      );
    const downloadUrl = download.url();
    // Blob downloads inherit their creator origin; opaque/data blobs are never authorized.
    if (downloadUrl.startsWith("blob:")) {
      const origin = new URL(downloadUrl).origin;
      if (origin === "null")
        throw new RuntimeError("egress_denied", "Opaque blob download is not authorized");
      authorizeUrl(runtime, `${origin}/`);
    } else authorizeUrl(runtime, downloadUrl);
    const stream = await download.createReadStream();
    if (!stream)
      throw new RuntimeError(
        "insufficient_evidence",
        "Download stream unavailable",
        "inconclusive",
      );
    const limit = Math.min(runtime.input.bodyBytes ?? 10 * 1024 * 1024, ARTIFACT_BYTES);
    const chunks: Buffer[] = [];
    const digest = createHash("sha256");
    let sizeBytes = 0;
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        sizeBytes += bytes.byteLength;
        if (sizeBytes > limit)
          throw new RuntimeError(
            "artifact_limit_exceeded",
            "Download exceeds authorized byte limit",
            "inconclusive",
          );
        digest.update(bytes);
        chunks.push(bytes);
      }
      const failure = await download.failure();
      if (failure)
        throw new RuntimeError("insufficient_evidence", runtime.scrub(failure), "inconclusive");
      const mimeType = responseTypes.get(download.url()) ?? "application/octet-stream";
      await runtime.artifact(
        `browser/downloads/${outputName}`,
        "download",
        mimeType,
        Buffer.concat(chunks, sizeBytes),
      );
      downloads.set(outputName, { sizeBytes, mimeType, sha256: digest.digest("hex") });
    } finally {
      stream.destroy();
      await download.delete();
    }
  }
  async function perform(step: PlanStep, remaining?: number): Promise<void> {
    try {
      await performStep(step, remaining);
    } catch (error) {
      // A fatal egress denial closes the context, so the pending Playwright call fails with
      // "Target page, context or browser has been closed"; the denial is the cause.
      if (violation) throw violation;
      throw error;
    }
  }
  async function performStep(step: PlanStep, remaining?: number): Promise<void> {
    if (violation) throw violation;
    if (runtime.signal.aborted)
      throw new RuntimeError("user_cancelled", "Attempt cancelled", "inconclusive");
    const timeout = deadline(step, remaining);
    if (step.kind === "assertion") {
      await assertion(step, timeout);
      return;
    }
    switch (step.operation) {
      case "navigate":
        await page.goto(authorizeUrl(runtime, step.input.path, runtime.input.baseUrl).href, {
          timeout,
          waitUntil: step.input.readiness ?? "load",
        });
        break;
      case "request":
        await http.perform(step);
        break;
      case "switchPage":
        page = pageFor(step.input.pageAlias);
        scope = page;
        break;
      case "frame": {
        const previousScope = scope;
        const previousPage = page;
        scope = await frameFrom(await locate(step.input.locator, timeout), timeout);
        try {
          const children = await runtime.runSteps(step.input.childSteps, withEvidence);
          if (children.outcome !== "passed")
            throw new RuntimeError(
              children.reasonCode,
              "Required frame child step did not pass",
              children.outcome === "cancelled" ? "inconclusive" : children.outcome,
            );
        } finally {
          scope = previousScope;
          page = previousPage;
        }
        break;
      }
      case "click": {
        type Modifier = "Alt" | "Control" | "Meta" | "Shift";
        const options: {
          timeout: number;
          button?: "left" | "middle" | "right";
          modifiers?: Modifier[];
        } = { timeout };
        const button = step.input.button;
        if (button === "left" || button === "middle" || button === "right") options.button = button;
        const modifiers: Modifier[] = [];
        for (const modifier of step.input.modifiers ?? []) {
          if (
            modifier !== "Alt" &&
            modifier !== "Control" &&
            modifier !== "Meta" &&
            modifier !== "Shift"
          )
            throw new RuntimeError("security_precondition_failed", "Unsupported keyboard modifier");
          modifiers.push(modifier);
        }
        if (modifiers.length) options.modifiers = modifiers;
        await (await unique(await locate(step.input.locator, timeout), timeout)).click(options);
        break;
      }
      case "hover": {
        type Modifier = "Alt" | "Control" | "Meta" | "Shift";
        const modifiers: Modifier[] = [];
        for (const modifier of step.input.modifiers ?? []) {
          if (
            modifier !== "Alt" &&
            modifier !== "Control" &&
            modifier !== "Meta" &&
            modifier !== "Shift"
          )
            throw new RuntimeError("security_precondition_failed", "Unsupported keyboard modifier");
          modifiers.push(modifier);
        }
        await (await unique(await locate(step.input.locator, timeout), timeout)).hover({
          timeout,
          modifiers,
        });
        break;
      }
      case "check":
        await (await unique(await locate(step.input.locator, timeout), timeout)).check({ timeout });
        break;
      case "uncheck":
        await (await unique(await locate(step.input.locator, timeout), timeout)).uncheck({
          timeout,
        });
        break;
      case "fill":
        await (await unique(await locate(step.input.locator, timeout), timeout)).fill(
          await stringValue(step.input.value),
          { timeout },
        );
        break;
      case "press": {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in keyboard input.
        if (/[\u0000-\u001f]/u.test(step.input.key))
          throw new RuntimeError("security_precondition_failed", "Invalid keyboard key");
        await (await unique(await locate(step.input.locator, timeout), timeout)).press(
          step.input.key,
          { timeout },
        );
        break;
      }
      case "select": {
        const choices: { value?: string; label?: string; index?: number }[] = [];
        for (const choice of step.input.values) {
          if ("value" in choice) choices.push({ value: await stringValue(choice.value) });
          else if ("label" in choice) choices.push({ label: await stringValue(choice.label) });
          else choices.push({ index: choice.index });
        }
        await (await unique(await locate(step.input.locator, timeout), timeout)).selectOption(
          choices,
          { timeout },
        );
        break;
      }
      case "drag":
        await (await unique(await locate(step.input.source, timeout), timeout)).dragTo(
          await unique(await locate(step.input.destination, timeout), timeout),
          { timeout },
        );
        break;
      case "upload": {
        if (policy.allowUploads !== true)
          throw new RuntimeError("security_precondition_failed", "Uploads are not authorized");
        const files: { name: string; mimeType: string; buffer: Buffer }[] = [];
        let total = 0;
        for (const ref of step.input.artifactRefs) {
          const artifact = await readAuthorizedArtifact(runtime, ref);
          total += artifact.bytes.byteLength;
          if (total > (runtime.input.bodyBytes ?? 10 * 1024 * 1024))
            throw new RuntimeError(
              "artifact_limit_exceeded",
              "Upload exceeds aggregate byte limit",
              "inconclusive",
            );
          const name = runtime.input.artifacts?.[ref]?.path.split("/").at(-1);
          if (!name)
            throw new RuntimeError(
              "security_precondition_failed",
              "Upload artifact name is missing",
            );
          files.push({
            name,
            mimeType: artifact.mimeType,
            buffer: Buffer.from(
              artifact.bytes.buffer,
              artifact.bytes.byteOffset,
              artifact.bytes.byteLength,
            ),
          });
        }
        await (await unique(await locate(step.input.locator, timeout), timeout)).setInputFiles(
          files,
          { timeout },
        );
        break;
      }
      case "download": {
        if (policy.allowDownloads !== true)
          throw new RuntimeError("security_precondition_failed", "Downloads are not authorized");
        const locator = await unique(
          await locate(step.input.trigger.input.locator, timeout),
          timeout,
        );
        const selectedPage = locator.page();
        expectedDownloadPage = selectedPage;
        try {
          const [download] = await Promise.all([
            selectedPage.waitForEvent("download", { timeout }),
            locator.click({ timeout }),
          ]);
          await saveDownload(download, step.input.outputName);
        } finally {
          expectedDownloadPage = undefined;
        }
        break;
      }
      case "waitFor": {
        const waitTimeout = deadline(step, step.input.deadlineMs);
        if ("locator" in step.input) {
          const waitsForAttachment =
            step.input.state === "attached" || step.input.state === "visible";
          const locator = await locate(
            step.input.locator,
            waitTimeout,
            scope,
            waitsForAttachment ? "wait" : "lazy",
          );
          if (waitsForAttachment) await unique(locator, waitTimeout);
          else if ((await locator.count()) > 1)
            throw new RuntimeError("assertion_mismatch", "Wait locator is ambiguous", "failed");
          const state = step.input.state;
          if (
            state !== "attached" &&
            state !== "detached" &&
            state !== "hidden" &&
            state !== "visible"
          )
            throw new RuntimeError("security_precondition_failed", "Unsupported wait state");
          try {
            await locator.waitFor({ state, timeout: waitTimeout });
          } catch (error) {
            if (
              error instanceof errors.TimeoutError &&
              !runtime.signal.aborted &&
              !locator.page().isClosed()
            ) {
              // Re-querying the bound locator fails on a crashed page or detached frame;
              // only a live, unambiguous observation is a reliable state timeout.
              if ((await locator.count()) > 1)
                throw new RuntimeError("assertion_mismatch", "Wait locator is ambiguous", "failed");
              throw new RuntimeError(
                "assertion_timeout",
                "Locator did not reach the required state before the step deadline",
                "failed",
              );
            }
            throw error;
          }
        } else {
          const expected = authorizeUrl(
            runtime,
            step.input.response.url,
            runtime.input.baseUrl,
          ).href;
          const status = step.input.response.status;
          await page.waitForResponse(
            (response) =>
              response.url() === expected && (status === undefined || response.status() === status),
            { timeout: waitTimeout },
          );
        }
        break;
      }
    }
    if (violation) throw violation;
  }
  type LocatorTransition = {
    elapsedMs: number;
    attached: boolean;
    visible: boolean;
    hidden: boolean;
  };
  function stepLocators(step: PlanStep): LocatorSpec[] {
    if (step.operation === "drag") return [step.input.source, step.input.destination];
    if (step.operation === "download") return [step.input.trigger.input.locator];
    return "locator" in step.input ? [step.input.locator] : [];
  }
  async function locatorEvidence(
    step: PlanStep,
    spec: LocatorSpec,
    index: number,
    phase: "before" | "after",
    transitions: LocatorTransition[],
    observationComplete = true,
  ): Promise<void> {
    try {
      const selected = await locate(spec, 100, scope, "lazy");
      const observed = await selected.evaluateAll(
        (matches, testIdAttributes) => {
          const doc = matches[0]?.ownerDocument ?? document;
          const matched = new Set(matches);
          // The walk is bounded two ways, so a huge DOM cannot stall the step: it stops at the first
          // identified element beyond the candidate budget, and it never visits more than
          // maxVisited elements. Either cut reports `truncated`.
          const maxCandidates = 100;
          const maxVisited = 10_000;
          // Document and metadata elements are never locator targets; recording them would spend
          // the candidate budget on <head> contents. Matched elements always stay.
          const metadataTags = [
            "html",
            "head",
            "meta",
            "script",
            "style",
            "link",
            "title",
            "noscript",
            "template",
            "base",
          ];
          const recordedKeys = [
            "id",
            "name",
            "autocomplete",
            "aria-label",
            "aria-haspopup",
            "placeholder",
            "data-semantic",
            ...testIdAttributes,
          ].filter(
            (key) =>
              key !== "value" && !/token|secret|password|authorization|cookie|^on/iu.test(key),
          );
          const sanitizedText = (element: Element) => {
            const textWalker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let text = "";
            let visited = 0;
            while (visited++ < 100 && text.length < 200 && textWalker.nextNode()) {
              const node = textWalker.currentNode;
              if (
                !node.parentElement?.closest(
                  "input,textarea,[data-sensitive],[autocomplete*=password],script,style",
                )
              )
                text += node.textContent ?? "";
            }
            return text.slice(0, 200);
          };
          type Described = {
            node: Element;
            role: string;
            name: string;
            tag: string;
            type: string;
            attributes: Record<string, string>;
          };
          const implicitRoleTags = ["button", "a", "option", "select", "textarea", "input"];
          // Everything a locator or a healing replacement can identify, without computed style or
          // layout: those are read only for the elements that end up recorded.
          const describe = (node: Element): Described => {
            const tag = node.tagName.toLowerCase();
            const type = (node.getAttribute("type") ?? "").slice(0, 200);
            const sensitive =
              !!node.closest("[data-sensitive]") ||
              (!(tag === "input" && type === "password") &&
                !!node.closest("[autocomplete*=password]"));
            const attributes: Record<string, string> = {};
            if (!sensitive)
              for (const key of recordedKeys) {
                const value = node.getAttribute(key);
                if (value !== null && value.length <= 200) attributes[key] = value;
              }
            let role = (node.getAttribute("role") ?? "").slice(0, 200);
            if (!role)
              role =
                tag === "button"
                  ? "button"
                  : tag === "a" && node.hasAttribute("href")
                    ? "link"
                    : tag === "select"
                      ? "combobox"
                      : tag === "textarea"
                        ? "textbox"
                        : tag === "input"
                          ? type === "checkbox"
                            ? "checkbox"
                            : type === "radio"
                              ? "radio"
                              : ["button", "submit", "reset"].includes(type)
                                ? "button"
                                : type === "password"
                                  ? ""
                                  : "textbox"
                          : "";
            const labels = "labels" in node ? (node as HTMLInputElement).labels : null;
            const labelled = (node.getAttribute("aria-labelledby") ?? "")
              .slice(0, 200)
              .split(/\s+/u)
              .slice(0, 10)
              .map((id) => doc.getElementById(id))
              .filter((label) => label && !label.closest("[data-sensitive]"));
            const name = sensitive
              ? ""
              : (node.getAttribute("aria-label") ??
                (labelled.length
                  ? labelled.map((label) => (label ? sanitizedText(label) : "")).join(" ")
                  : labels?.length
                    ? Array.from(labels)
                        .slice(0, 10)
                        .filter((label) => !label.closest("[data-sensitive]"))
                        .map(sanitizedText)
                        .join(" ")
                    : ["button", "a", "option"].includes(tag)
                      ? sanitizedText(node)
                      : ""));
            return {
              node,
              role,
              name: name.trim().replace(/\s+/gu, " ").slice(0, 200),
              tag,
              type,
              attributes,
            };
          };
          // Matched elements are always recorded (they fill at most the whole budget); the rest of
          // the budget goes to identified elements in tree order.
          const kept = new Map<Element, Described>();
          let unmatchedBudget = maxCandidates - Math.min(matches.length, maxCandidates);
          let truncated = matches.length > maxCandidates;
          const consider = (node: Element): boolean => {
            if (matched.has(node as HTMLElement)) {
              if (kept.size < maxCandidates) kept.set(node, describe(node));
              return true;
            }
            if (metadataTags.includes(node.tagName.toLowerCase())) return true;
            // Cheap necessary condition for an identity: only these elements are described, so
            // anonymous wrappers cost a few attribute reads and no text walk.
            if (
              !(
                node.hasAttribute("role") ||
                node.hasAttribute("aria-labelledby") ||
                implicitRoleTags.includes(node.tagName.toLowerCase()) ||
                ("labels" in node && !!(node as HTMLInputElement).labels?.length) ||
                recordedKeys.some((key) => node.hasAttribute(key))
              )
            )
              return true;
            const described = describe(node);
            if (!(described.role || described.name || Object.keys(described.attributes).length))
              return true;
            if (unmatchedBudget === 0) {
              truncated = true;
              return false;
            }
            unmatchedBudget--;
            kept.set(node, described);
            return true;
          };
          // SVG resource definitions (an icon sprite's <symbol>s, gradients, clip paths) never
          // render where they stand, so their subtrees are skipped: an icon library's sprite can
          // hold hundreds of identified <symbol>s that would fill the budget before the form.
          const definitionTags = [
            "defs",
            "symbol",
            "clippath",
            "mask",
            "lineargradient",
            "radialgradient",
            "pattern",
            "filter",
            "marker",
          ];
          const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT, {
            acceptNode: (node) =>
              (node as Element).namespaceURI === "http://www.w3.org/2000/svg" &&
              definitionTags.includes((node as Element).localName.toLowerCase())
                ? NodeFilter.FILTER_REJECT
                : NodeFilter.FILTER_ACCEPT,
          });
          let walking = consider(doc.documentElement);
          let visited = 0;
          while (walking) {
            if (visited >= maxVisited) {
              if (walker.nextNode()) truncated = true;
              break;
            }
            if (!walker.nextNode()) break;
            visited++;
            walking = consider(walker.currentNode as Element);
          }
          // A cut walk can end before reaching a matched element; matches are in hand, so add them.
          for (const node of matches.slice(0, maxCandidates))
            if (!kept.has(node)) kept.set(node, describe(node));
          const candidates = Array.from(kept.values(), ({ node, ...described }) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            const visible =
              node.checkVisibility({ visibilityProperty: true }) &&
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== "hidden" &&
              style.visibility !== "collapse";
            return { ...described, matched: matched.has(node as HTMLElement), visible };
          });
          return {
            cardinality: matches.length,
            candidates,
            truncated: truncated || testIdAttributes.length > 16,
            origin: doc.location.origin,
          };
        },
        (runtime.input.browser?.testIdAttributes ?? ["data-testid"]).slice(0, 17),
      );
      const candidates = observed.candidates.map((element) => {
        const safe = {
          ...element,
          role: runtime.scrub(element.role),
          name: runtime.scrub(element.name),
          type: runtime.scrub(element.type),
          attributes: Object.fromEntries(
            Object.entries(element.attributes).map(([key, value]) => [key, runtime.scrub(value)]),
          ),
        };
        const attributes = Object.fromEntries(
          ["name", "autocomplete", "aria-haspopup", "data-semantic"]
            .filter((key) => safe.attributes[key] !== undefined)
            .map((key) => [key, safe.attributes[key]]),
        );
        return {
          ...safe,
          fingerprint: semanticHash({
            role: safe.role,
            name: safe.name,
            tag: safe.tag,
            type: safe.type,
            attributes,
          }),
        };
      });
      const state =
        step.operation === "waitFor" && "locator" in step.input
          ? {
              requested: step.input.state,
              deadlineMs: Math.min(step.input.deadlineMs, stepTimeoutMs(step, runtime.input)),
              transitions: transitions.slice(),
            }
          : null;
      const payload = {
        schemaVersion: "1.0.0",
        stepId: step.id,
        phase,
        frameOrigin: runtime.scrub(observed.origin),
        locator: JSON.parse(runtime.scrub(JSON.stringify(spec))) as LocatorSpec,
        cardinality: observed.cardinality,
        candidates,
        truncated: observed.truncated || !observationComplete,
        state,
      };
      const bytes = Buffer.from(
        JSON.stringify({ ...payload, evidenceHash: semanticHash(payload) }),
      );
      if (bytes.byteLength > 262144)
        throw new RuntimeError(
          "artifact_limit_exceeded",
          "Locator evidence byte limit",
          "inconclusive",
        );
      await runtime.artifact(
        `browser/steps/${step.id}-locator-${index}-${phase}.json`,
        "locator-evidence",
        "application/json",
        bytes,
      );
    } catch (error) {
      await runtime
        .emit("log", {
          level: "warn",
          message: runtime
            .scrub(
              `Locator evidence unavailable: ${error instanceof Error ? error.message : String(error)}`,
            )
            .slice(0, 16384),
        })
        .catch(() => undefined);
    }
  }
  async function evidence(step: PlanStep, phase: "before" | "after"): Promise<void> {
    if (page.isClosed()) return;
    try {
      const png = await screenshotPage(page, runtime.secrets, deadline(step));
      if (png.byteLength > ARTIFACT_BYTES)
        throw new RuntimeError("artifact_limit_exceeded", "Screenshot byte limit", "inconclusive");
      await runtime.artifact(
        `browser/steps/${step.id}-${phase}.png`,
        "screenshot",
        "image/png",
        png,
      );
      const snapshots = (await pageMarkup(page)).map((markup) =>
        redactMarkup(runtime.scrub(markup), runtime.secrets),
      );
      const dom = Buffer.from(snapshots.join("\n"));
      if (dom.byteLength > DOM_BYTES) {
        await runtime.emit("log", {
          level: "warn",
          message: "DOM evidence omitted: byte limit exceeded",
        });
      } else
        await runtime.artifact(`browser/steps/${step.id}-${phase}.html`, "dom", "text/html", dom);
    } catch (error) {
      await runtime
        .emit("log", {
          level: "warn",
          message: runtime
            .scrub(
              `Browser evidence unavailable: ${error instanceof Error ? error.message : String(error)}`,
            )
            .slice(0, 16_384),
        })
        .catch(() => undefined);
    }
  }
  /**
   * Reads the page until two reads at least SETTLE_INTERVAL_MS apart agree, so a single-page app
   * that is still rendering is not observed half-built. The wait ends at the step deadline or
   * SETTLE_LIMIT_MS, whichever is first; a page that never agrees is reported as not settled.
   */
  async function observeSettled(
    step: PlanStep,
  ): Promise<{ observed: ObservedPage; settled: boolean }> {
    const until = performance.now() + deadline(step, SETTLE_LIMIT_MS);
    let observed = await page.evaluate(observePage);
    while (performance.now() + SETTLE_INTERVAL_MS <= until) {
      await delay(SETTLE_INTERVAL_MS, undefined, { signal: runtime.signal });
      const next = await page.evaluate(observePage);
      if (
        observed.text === next.text &&
        JSON.stringify(observed.controls) === JSON.stringify(next.controls) &&
        observed.elements.length === next.elements.length
      )
        return { observed: next, settled: true };
      observed = next;
    }
    return { observed, settled: false };
  }
  async function resolveAgentStep(step: PlanStep): Promise<PlanStep | null> {
    const agent = runtime.input.agent;
    if (!agent?.resolveSteps.includes(step.id)) return step;
    if (step.kind !== "action")
      throw new RuntimeError("security_precondition_failed", "Agent step is not an action");
    if (explorationStopped) return null;
    const { observed, settled } = await observeSettled(step);
    const first = observationCount++ === 0;
    const actions: PlanStep[] = [];
    for (const element of observed.elements) {
      // Most specific first: the first candidate is the only locator a replayed agent step uses.
      const candidates: LocatorSpec[] = [];
      if (element.testId) candidates.push({ by: "testId", value: element.testId });
      if (element.label) candidates.push({ by: "label", value: element.label, exact: true });
      if (element.tag === "button" && element.text)
        candidates.push({ by: "role", role: "button", name: element.text, exact: true });
      if (element.placeholder)
        candidates.push({ by: "placeholder", value: element.placeholder, exact: true });
      if (element.role && element.name)
        candidates.push({ by: "role", role: element.role, name: element.name, exact: true });
      const locator: LocatorSpec | undefined = candidates[0];
      if (agent.exploration) {
        for (const approved of agent.mutationActions ?? []) {
          if (approved.kind !== "action" || !("locator" in approved.input)) continue;
          const wanted = JSON.stringify(approved.input.locator);
          if (candidates.some((candidate) => JSON.stringify(candidate) === wanted))
            actions.push({ ...approved, id: step.id });
        }
        if (!element.href) continue;
        try {
          const target = authorizeUrl(runtime, element.href);
          if (target.href === page.url()) continue;
          actions.push({
            id: step.id,
            kind: "action",
            operation: "navigate",
            description: `Observed link ${element.text || target.pathname}`,
            input: { path: target.href },
          });
        } catch {
          /* Forbidden links are observations, never tools. */
        }
      } else if (locator && "locator" in step.input) {
        actions.push(validate<PlanStep>("Step", { ...step, input: { ...step.input, locator } }));
      } else if (step.operation === "navigate") actions.push(step);
    }
    const cleaned = (value: string | null): string | null =>
      value === null ? null : runtime.scrub(value);
    const observation = {
      url: page.url(),
      title: runtime.scrub(observed.title),
      text: runtime.scrub(observed.text),
      settled,
      hasPasswordField: observed.hasPasswordField,
      controls: observed.controls.map((control) => ({
        ...control,
        name: cleaned(control.name),
        placeholder: cleaned(control.placeholder),
        testId: cleaned(control.testId),
      })),
      actions,
    };
    await runtime.artifact(
      `browser/steps/${step.id}-observation.json`,
      "dom",
      "application/json",
      Buffer.from(JSON.stringify(observation)),
    );
    const selected = await runtime.agent(step.id, observation);
    if (selected === null) {
      explorationStopped = true;
      if (agent.exploration && agent.requireActionable && first && actions.length === 0) {
        // The closing assertion is skipped after this failure; keep a picture of what was seen.
        await evidence(step, "after");
        const at = new URL(observation.url);
        at.search = "";
        at.hash = "";
        throw new RuntimeError(
          "insufficient_evidence",
          `Exploration observed no same-origin link at ${at.href}: ${observation.controls.length} form controls, ${observation.hasPasswordField ? "password field present" : "no password field"}, 0 approved actions.${settled ? "" : " The page had not settled."}`,
          "inconclusive",
        );
      }
      return null;
    }
    validate("Step", selected);
    if (
      selected.id !== step.id ||
      !actions.some((action) => JSON.stringify(action) === JSON.stringify(selected))
    )
      throw new RuntimeError(
        "security_precondition_failed",
        "Controller action is not grounded in this observation",
      );
    return selected;
  }
  async function withEvidence(step: PlanStep): Promise<void> {
    currentStepId = step.id;
    // Resolve known secret references before either screenshot can expose them.
    if (step.operation === "fill") await runtime.resolve(step.input.value);
    if (
      step.kind === "assertion" &&
      "value" in step.expectation &&
      typeof step.expectation.value === "object"
    )
      await runtime.resolve(step.expectation.value);
    if (step.operation === "select")
      for (const choice of step.input.values) {
        if ("value" in choice) await runtime.resolve(choice.value);
        else if ("label" in choice) await runtime.resolve(choice.label);
      }
    const selected = await resolveAgentStep(step);
    if (!selected) return;
    activeAgentStep = selected.id;
    activeMutationAllowed = (runtime.input.agent?.mutationActions ?? []).some(
      (action) => JSON.stringify({ ...action, id: selected.id }) === JSON.stringify(selected),
    );
    const locators = stepLocators(selected);
    // Action auto-wait and its evidence share one budget; missing targets must not get
    // a second attachment timeout after we have recorded their absence.
    let actionDeadline: number | undefined;
    let attachmentError: unknown;
    if (selected.kind === "action" && selected.operation !== "waitFor" && locators.length) {
      actionDeadline = performance.now() + deadline(selected);
      try {
        for (const locator of locators) {
          const remaining = deadline(selected, actionDeadline - performance.now());
          await unique(await locate(locator, remaining), remaining);
        }
      } catch (error) {
        attachmentError = error;
      }
    }
    const transitions: LocatorTransition[] = [];
    const waitStarted = performance.now();
    let sampling = false;
    let sampler: Promise<void> | undefined;
    let observationComplete = true;
    const sample = async () => {
      if (selected.operation !== "waitFor" || !("locator" in selected.input)) return;
      try {
        const locator = await locate(selected.input.locator, 100, scope, "lazy");
        const state = await locator.evaluateAll((nodes) => ({
          cardinality: nodes.length,
          attached: nodes.length > 0,
          visible: nodes.some((node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return (
              node.checkVisibility({ visibilityProperty: true }) &&
              style.visibility !== "hidden" &&
              style.visibility !== "collapse" &&
              rect.width > 0 &&
              rect.height > 0
            );
          }),
        }));
        if (state.cardinality > 1) observationComplete = false;
        const previous = transitions.at(-1);
        if (
          !previous ||
          previous.attached !== state.attached ||
          previous.visible !== state.visible
        ) {
          if (transitions.length >= 128) observationComplete = false;
          else
            transitions.push({
              elapsedMs: Math.round(performance.now() - waitStarted),
              attached: state.attached,
              visible: state.visible,
              hidden: !state.visible,
            });
        }
      } catch {
        observationComplete = false;
      }
    };
    await sample();
    for (const [index, locator] of locators.entries())
      await locatorEvidence(selected, locator, index, "before", transitions, observationComplete);
    await evidence(selected, "before");
    // Retain the first observation: screenshot collection can span the readiness
    // transition, and restarting here would erase its visible predecessor.
    await sample();
    if (selected.operation === "waitFor" && "locator" in selected.input) {
      sampling = true;
      sampler = (async () => {
        while (sampling) {
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
          if (sampling) await sample();
        }
      })();
    }
    try {
      if (runtime.signal.aborted)
        throw new RuntimeError("user_cancelled", "Attempt cancelled", "inconclusive");
      deadline(selected);
      if (attachmentError) throw attachmentError;
      await perform(
        selected,
        actionDeadline === undefined ? undefined : actionDeadline - performance.now(),
      );
    } finally {
      sampling = false;
      await sampler;
      await sample();
      for (const [index, locator] of locators.entries())
        await locatorEvidence(selected, locator, index, "after", transitions, observationComplete);
      await evidence(selected, "after");
      activeAgentStep = undefined;
      activeMutationAllowed = false;
    }
  }
  function attachPage(target: Page): void {
    allPages.push(target);
    target.on("console", (message) => record("console", `${message.type()}: ${message.text()}`));
    target.on("pageerror", (error) => record("console", `pageerror: ${error.message}`));
    target.on("request", (request) =>
      record("network", { method: request.method(), url: request.url() }),
    );
    target.on("requestfailed", (request) =>
      record("network", {
        url: request.url(),
        failure: request.failure()?.errorText ?? "request_failed",
      }),
    );
    target.on("response", (response) => {
      record("network", { url: response.url(), status: response.status() });
      const type = response.headers()["content-type"]?.split(";")[0]?.trim();
      if (type && responseTypes.size < 256) responseTypes.set(response.url(), type);
    });
    target.on("download", (download) => {
      if (isIgnoredRequest(download.url(), ignoredOrigins)) {
        void download.cancel().catch(() => undefined);
        recordIgnored(download.url(), "GET", "download");
        return;
      }
      if (policy.allowDownloads !== true || expectedDownloadPage !== target) {
        void download.cancel().catch(() => undefined);
        deny("Unexpected download is not authorized");
      }
    });
    target.on("framenavigated", (frame) => {
      try {
        authorizeFrame(frame);
      } catch {
        const url = frame.url();
        // A document of an ignored origin is dropped like its request; it never fails the attempt.
        if (isIgnoredRequest(url, ignoredOrigins)) {
          recordIgnored(url, "GET", "document");
          return;
        }
        // A frame is a document request that the route handler no longer sees once it is committed,
        // so the denial is recorded here like a denied subrequest: origin only, never path or query.
        denials.record({
          stepId: currentStepId ?? "attempt",
          url,
          method: "GET",
          resourceType: "document",
          disposition: "fatal",
        });
        deny(runtime.scrub(`Frame navigation is not authorized: ${deniedOrigin(url)}`));
      }
    });
  }
  try {
    // Collection can precede the action that first uses a credential.
    for (const reference of runtime.input.secrets)
      await runtime.resolve({ secretRef: reference.secretRef });
    const storageState = await loadStorageState(runtime);
    if (runtime.signal.aborted)
      throw new RuntimeError("user_cancelled", "Attempt cancelled", "inconclusive");
    tempDirectory = await mkdtemp(join(tmpdir(), "testmaster-browser-"));
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      proxy: { server: proxy, bypass: "<-loopback>" },
      args: [
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--disable-background-networking",
        // Never let a host password manager or OS keychain autofill or leak into the target.
        "--password-store=basic",
        "--use-mock-keychain",
      ],
    });
    if (runtime.signal.aborted)
      throw new RuntimeError("user_cancelled", "Attempt cancelled", "inconclusive");
    context = await browser.newContext({
      viewport: runtime.input.browser?.viewport ?? { width: 1280, height: 720 },
      locale: runtime.input.locale ?? "en-US",
      timezoneId: runtime.input.timezone ?? "UTC",
      permissions: [],
      serviceWorkers: "block",
      acceptDownloads: policy.allowDownloads === true,
      ignoreHTTPSErrors: false,
      ...(storageState ? { storageState } : {}),
      ...(policy.video === true ? { recordVideo: { dir: tempDirectory } } : {}),
    });
    await context.route("**/*", async (route) => {
      if (
        runtime.input.agent &&
        !["GET", "HEAD", "OPTIONS"].includes(route.request().method()) &&
        (!activeAgentStep ||
          (!activeMutationAllowed &&
            !runtime.input.agent.mutationStepIds.includes(activeAgentStep)))
      ) {
        await route.abort("blockedbyclient").catch(() => undefined);
        deny("Agent mutation is not explicitly authorized");
        return;
      }
      const request = route.request();
      // An ignored origin is dropped before authorization for every resource type and method; the
      // proxy never admits it either. Ambiguous URLs never match (SEC-008) and stay fatal below.
      if (isIgnoredRequest(request.url(), ignoredOrigins)) {
        recordIgnored(request.url(), request.method(), request.resourceType());
        await route.abort("blockedbyclient").catch(() => undefined);
        return;
      }
      let authorized = false;
      try {
        authorizeUrl(runtime, request.url());
        authorized = true;
      } catch {
        /* Refused below; a malformed URL is refused like an unapproved origin. */
      }
      if (authorized) {
        try {
          await route.continue();
        } catch {
          await route.abort("blockedbyclient").catch(() => undefined);
          // The origin is allowed; the browser could not forward the request (for example the page
          // or context closed mid-request). The attempt still stops, but the reason must not blame the origin.
          deny(
            runtime.scrub(
              `Browser could not forward a request to the authorized origin ${deniedOrigin(request.url())} (${request.resourceType()} request)`,
            ),
          );
        }
        return;
      }
      // The proxy never sees a request aborted here, so this is the only record of the denial.
      const disposition = denialDisposition(
        request.url(),
        request.method(),
        request.resourceType(),
      );
      denials.record({
        stepId: currentStepId ?? "attempt",
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        disposition,
      });
      await route.abort("blockedbyclient").catch(() => undefined);
      if (disposition === "fatal")
        deny(runtime.scrub(deniedSubrequestMessage(request.url(), request.resourceType())));
    });
    // The page's socket is a mock until the runner connects it, so only an authorized origin ever
    // reaches the proxy, which validates the CONNECT tunnel again. Dedicated workers bypass this
    // hook and are covered by the proxy alone.
    await context.routeWebSocket("**/*", (socket) => {
      const requestUrl = webSocketRequestUrl(socket.url());
      if (isIgnoredRequest(requestUrl, ignoredOrigins)) {
        recordIgnored(requestUrl, "GET", "websocket");
        void socket.close({ code: 1008, reason: "WebSocket origin is ignored by the environment" });
        return;
      }
      try {
        authorizeUrl(runtime, requestUrl);
      } catch {
        denials.record({
          stepId: currentStepId ?? "attempt",
          url: requestUrl,
          method: "GET",
          resourceType: "websocket",
          disposition: "fatal",
        });
        void socket.close({ code: 1008, reason: "WebSocket origin is not authorized" });
        deny(runtime.scrub(deniedSubrequestMessage(requestUrl, "websocket")));
        return;
      }
      try {
        socket.connectToServer();
      } catch {
        void socket.close({ code: 1011, reason: "WebSocket could not be connected" });
        deny(
          runtime.scrub(
            `Browser could not connect a WebSocket to the authorized origin ${deniedOrigin(requestUrl)}`,
          ),
        );
      }
    });
    if (policy.trace === true && policy.restrictedRaw === true)
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    page = await context.newPage();
    scope = page;
    attachPage(page);
    context.on("page", (popup) => {
      const alias = popupAliases[popupIndex++];
      if (!alias) {
        void popup.close().catch(() => undefined);
        deny("Unexpected popup is not authorized");
        return;
      }
      pages.set(alias, popup);
      attachPage(popup);
    });
    const login = runtime.input.auth?.login;
    if (login) {
      // The login phase is not a plan step: indexes and evidence stay those of the authored plan.
      try {
        for (const step of login.steps) await perform(step);
      } catch (error) {
        if (runtime.signal.aborted) throw error;
        throw new RuntimeError("manual_auth_required", "Browser login did not complete", "blocked");
      }
      if (login.captureState) {
        const captured = JSON.stringify(await context.storageState());
        for (const value of storageStateSecrets(captured)) runtime.secrets.add(value);
        if (Buffer.byteLength(captured) > 65_536)
          throw new RuntimeError(
            "storage_unavailable",
            "Captured storage state exceeds the size limit",
            "blocked",
          );
        await runtime.protocol.emit("auth.state", { kind: "storageState", data: captured });
      }
    }
    result = await runtime.runSteps(plan.steps, withEvidence);
    // A denial closes the context, so a pending call may already have been mapped to inconclusive
    // by the closed-page error; the denial is the cause. A genuine failed assertion stands.
    if (
      violation &&
      (result.outcome === "passed" ||
        (result.outcome === "inconclusive" && !runtime.signal.aborted))
    )
      result = { outcome: violation.outcome, reasonCode: violation.reasonCode };
  } catch (error) {
    const aborted = abortVerdict(runtime.signal);
    if (aborted) result = aborted;
    else if (violation) result = { outcome: violation.outcome, reasonCode: violation.reasonCode };
    else if (error instanceof RuntimeError)
      result = { outcome: error.outcome, reasonCode: error.reasonCode };
    else
      result = {
        outcome: browser ? "inconclusive" : "blocked",
        reasonCode: browser ? "insufficient_evidence" : "security_precondition_failed",
      };
  } finally {
    runtime.signal.removeEventListener("abort", abort);
    try {
      if (
        context &&
        policy.trace === true &&
        policy.restrictedRaw === true &&
        tempDirectory &&
        !runtime.signal.aborted
      ) {
        const trace = join(tempDirectory, "trace.zip");
        await context.tracing.stop({ path: trace });
        if ((await stat(trace)).size <= ARTIFACT_BYTES)
          await runtime.artifact(
            "browser/trace.zip",
            "restrictedRaw.trace",
            "application/zip",
            await readFile(trace),
          );
        else
          await runtime.emit("log", {
            level: "warn",
            message: "Raw trace omitted: artifact byte limit exceeded",
          });
      }
    } catch {
      await runtime
        .emit("log", { level: "warn", message: "Raw trace unavailable" })
        .catch(() => undefined);
    }
    try {
      await context?.close();
    } catch {
      /* Already closed by cancellation or policy enforcement. */
    }
    try {
      if (policy.video === true && policy.restrictedRaw === true)
        for (let i = 0; i < allPages.length; i++) {
          const targetPage = allPages[i];
          if (!targetPage) continue;
          const video = targetPage.video();
          if (!video) continue;
          const path = await video.path();
          if ((await stat(path)).size <= ARTIFACT_BYTES)
            await runtime.artifact(
              `browser/video-${i}.webm`,
              "restrictedRaw.video",
              "video/webm",
              await readFile(path),
            );
          else
            await runtime.emit("log", {
              level: "warn",
              message: "Raw video omitted: artifact byte limit exceeded",
            });
        }
    } catch {
      await runtime
        .emit("log", { level: "warn", message: "Raw video unavailable" })
        .catch(() => undefined);
    }
    try {
      for (const denial of denials.list())
        await runtime.emit("egress.denied", { ...denial, origin: runtime.scrub(denial.origin) });
      if (denials.omittedCount)
        await runtime.emit("log", {
          level: "warn",
          message: `egress_denials_omitted:${denials.omittedCount}`,
        });
    } catch {
      /* The protocol channel closed (cancellation); the denial remains in network.json. */
    }
    try {
      await runtime.artifact(
        "browser/console.json",
        "console",
        "application/json",
        Buffer.from(runtime.scrub(JSON.stringify({ entries: consoleLog, droppedLogs }))),
      );
      await runtime.artifact(
        "browser/network.json",
        "network",
        "application/json",
        Buffer.from(runtime.scrub(JSON.stringify({ entries: networkLog, droppedLogs }))),
      );
    } catch {
      if (result.outcome === "passed")
        result = { outcome: "inconclusive", reasonCode: "storage_unavailable" };
    }
    try {
      result = await http.cleanup(result);
    } catch {
      result = { ...result, cleanupOutcome: "inconclusive" };
    }
    const [httpClosed, browserClosed] = await Promise.allSettled([http.close(), browser?.close()]);
    if (browserClosed?.status === "rejected") {
      result = { ...result, cleanupOutcome: "failed" };
      await runtime.emit("log", {
        level: "error",
        message: "browser_profile_cleanup_failed:browser_close",
      });
    } else if (httpClosed.status === "rejected") {
      result = { ...result, cleanupOutcome: "failed" };
    }
    if (tempDirectory) {
      try {
        await rm(tempDirectory, { recursive: true, force: true });
      } catch {
        result = { ...result, cleanupOutcome: "failed" };
        await runtime.emit("log", {
          level: "error",
          message: "browser_profile_cleanup_failed:temp_dir",
        });
      }
    }
  }
  return result;
}
