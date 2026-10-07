/// <reference lib="dom" />
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Locator as LocatorSpec, type PlanStep, validate } from "@testmaster/contracts";
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
import { authorizeUrl, HttpEngine, readAuthorizedArtifact } from "./http.js";
import { type RunnerResult, type Runtime, RuntimeError } from "./runtime.js";

type Scope = Page | Frame;
type AssertionStep = Extract<PlanStep, { operation: "assert" }>;
interface DownloadOutput {
  sizeBytes: number;
  mimeType: string;
  sha256: string;
}
const LOG_BYTES = 1024 * 1024;
const DOM_BYTES = 1024 * 1024;
const ARTIFACT_BYTES = 64 * 1024 * 1024;

/** One isolated browser context, with egress enforced by the supervisor's mandatory proxy. */
export async function runBrowser(runtime: Runtime): Promise<RunnerResult> {
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
  let popupIndex = 0;
  let expectedDownloadPage: Page | undefined;
  let result: RunnerResult = { outcome: "inconclusive", reasonCode: "insufficient_evidence" };
  const started = performance.now();
  let agentRequests = 0;
  let activeAgentStep: string | undefined;
  let activeMutationAllowed = false;
  let explorationStopped = false;
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
    const remaining = (runtime.input.timeoutMs ?? 300_000) - (performance.now() - started);
    if (remaining <= 0)
      throw new RuntimeError("execution_deadline", "Attempt deadline expired", "inconclusive");
    return Math.max(
      1,
      Math.min(
        step.timeoutMs ?? runtime.input.stepTimeoutMs ?? 30_000,
        override ?? Infinity,
        remaining,
      ),
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
    const url = frame.url();
    if (url !== "about:blank") authorizeUrl(runtime, url);
  }
  async function unique(locator: Locator, timeout: number): Promise<Locator> {
    const initialCount = await locator.count();
    if (initialCount > 1)
      throw new RuntimeError(
        "assertion_mismatch",
        `Locator is ambiguous; matched ${initialCount}`,
        "failed",
      );
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
  async function locate(
    spec: LocatorSpec,
    timeout: number,
    base: Scope | Locator = scope,
  ): Promise<Locator> {
    let root: Scope | Locator = spec.pageAlias === undefined ? base : pageFor(spec.pageAlias);
    if (spec.frame) root = await frameFrom(await locate(spec.frame, timeout, root), timeout);
    if (spec.container) root = await unique(await locate(spec.container, timeout, root), timeout);
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
    if (expectation.predicate === "urlEquals") {
      if ("locator" in input || "outputName" in input)
        throw new RuntimeError("security_precondition_failed", "URL assertion requires page input");
      const expected = await stringValue(expectation.value);
      const selected = pageFor(input.pageAlias);
      await selected.waitForURL(expected, { timeout, waitUntil: "commit" });
      if (selected.url() !== expected)
        throw new RuntimeError(
          "assertion_mismatch",
          "Page URL differs from expected URL",
          "failed",
        );
      return;
    }
    if (!("locator" in input))
      throw new RuntimeError("security_precondition_failed", "UI assertion requires a locator");
    const locator = await locate(input.locator, timeout);
    if (expectation.predicate === "countEquals") {
      const count = await locator.count();
      if (count !== expectation.value)
        throw new RuntimeError(
          "assertion_mismatch",
          `Expected ${expectation.value} elements, observed ${count}`,
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
    let observed: unknown;
    let expected: unknown;
    switch (expectation.predicate) {
      case "visible":
        await locator.waitFor({ state: "visible", timeout });
        return;
      case "enabled":
        observed = await locator.isEnabled({ timeout });
        expected = true;
        break;
      case "textEquals":
        observed = await locator.innerText({ timeout });
        expected = await stringValue(expectation.value);
        break;
      case "textContains": {
        const text = await locator.innerText({ timeout });
        const part = await stringValue(expectation.value);
        if (text.includes(part)) return;
        observed = text;
        expected = part;
        break;
      }
      case "valueEquals":
        observed = await locator.inputValue({ timeout });
        expected = await stringValue(expectation.value);
        break;
      default:
        throw new RuntimeError(
          "unsupported_capability",
          `Predicate ${expectation.predicate} requires an HTTP response`,
        );
    }
    if (observed !== expected)
      throw new RuntimeError(
        "assertion_mismatch",
        runtime.scrub(`Expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`),
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
  async function perform(step: PlanStep): Promise<void> {
    if (violation) throw violation;
    if (runtime.signal.aborted)
      throw new RuntimeError("user_cancelled", "Attempt cancelled", "inconclusive");
    const timeout = deadline(step);
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
          const locator = await locate(step.input.locator, waitTimeout);
          if (step.input.state === "attached" || step.input.state === "visible")
            await unique(locator, waitTimeout);
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
          await locator.waitFor({ state, timeout: waitTimeout });
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
      const selected = await locate(spec, 100);
      const observed = await selected.evaluateAll(
        (matches, testIdAttributes) => {
          const doc = matches[0]?.ownerDocument ?? document;
          const all: Element[] = [];
          const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT);
          all.push(doc.documentElement);
          while (all.length <= 100 && walker.nextNode()) all.push(walker.currentNode as Element);
          const matched = new Set(matches);
          const candidates = all.slice(0, 100).map((node) => {
            const tag = node.tagName.toLowerCase();
            const type = (node.getAttribute("type") ?? "").slice(0, 200);
            const sensitive =
              !!node.closest("[data-sensitive], [autocomplete*=password]") || type === "password";
            const attributes: Record<string, string> = {};
            if (!sensitive)
              for (const key of [
                "id",
                "name",
                "autocomplete",
                "aria-label",
                "aria-haspopup",
                "placeholder",
                "data-semantic",
                ...testIdAttributes,
              ]) {
                if (key === "value" || /token|secret|password|authorization|cookie|^on/iu.test(key))
                  continue;
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
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            const visible =
              node.checkVisibility({ visibilityProperty: true }) &&
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== "hidden" &&
              style.visibility !== "collapse";
            return {
              role,
              name: name.trim().replace(/\s+/gu, " ").slice(0, 200),
              tag,
              type,
              attributes,
              matched: matched.has(node as HTMLElement),
              visible,
            };
          });
          return {
            cardinality: matches.length,
            candidates,
            truncated: all.length > 100 || testIdAttributes.length > 16,
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
              deadlineMs: Math.min(
                step.input.deadlineMs,
                step.timeoutMs ?? runtime.input.stepTimeoutMs ?? 30_000,
              ),
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
      const masks: Locator[] = [];
      for (const frame of page.frames()) {
        masks.push(
          frame.locator(
            "input, textarea, [data-sensitive], [autocomplete*=password], canvas, img, video, iframe",
          ),
        );
        for (const secret of runtime.secrets)
          if (secret) masks.push(frame.getByText(secret, { exact: false }));
      }
      const png = await page.screenshot({
        type: "png",
        timeout: Math.min(deadline(step), 5000),
        animations: "disabled",
        mask: masks,
        maskColor: "#000000",
      });
      if (png.byteLength > ARTIFACT_BYTES)
        throw new RuntimeError("artifact_limit_exceeded", "Screenshot byte limit", "inconclusive");
      await runtime.artifact(
        `browser/steps/${step.id}-${phase}.png`,
        "screenshot",
        "image/png",
        png,
      );
      const snapshots: string[] = [];
      for (const frame of page.frames()) {
        const html = await frame.evaluate(() => {
          const clone = document.documentElement.cloneNode(true) as HTMLElement;
          for (const node of clone.querySelectorAll(
            "input, textarea, [data-sensitive], script, style, noscript, meta",
          )) {
            node.removeAttribute("value");
            node.textContent = "[REDACTED]";
            if (["SCRIPT", "STYLE", "NOSCRIPT", "META"].includes(node.tagName)) node.remove();
          }
          for (const node of clone.querySelectorAll("*"))
            for (const attribute of Array.from(node.attributes)) {
              if (/token|secret|password|authorization|cookie|^on/i.test(attribute.name))
                node.removeAttribute(attribute.name);
            }
          return clone.outerHTML;
        });
        let redacted = runtime.scrub(html);
        for (const secret of runtime.secrets)
          if (secret) {
            const escaped = secret
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;");
            redacted = redacted.split(escaped).join("[REDACTED]");
          }
        snapshots.push(redacted);
      }
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
  async function resolveAgentStep(step: PlanStep): Promise<PlanStep | null> {
    const agent = runtime.input.agent;
    if (!agent?.resolveSteps.includes(step.id)) return step;
    if (step.kind !== "action" || ++agentRequests > agent.maxRequests)
      throw new RuntimeError(
        "security_precondition_failed",
        "Agent request budget or action boundary exceeded",
      );
    if (explorationStopped) return null;
    const observed = await page.evaluate(() => ({
      title: document.title,
      text: Array.from(document.querySelectorAll("h1,h2,h3,p,label,a,button,main"))
        .filter((node) => !node.closest("[data-sensitive],form"))
        .map((node) => node.textContent ?? "")
        .join("\n")
        .slice(0, 12000),
      elements: Array.from(
        document.querySelectorAll(
          "a[href],button,input:not([type=password]),textarea,select,[data-testid]",
        ),
      )
        .slice(0, 100)
        .map((node) => ({
          tag: node.tagName.toLowerCase(),
          testId: node.getAttribute("data-testid"),
          label: node.getAttribute("aria-label"),
          text: (node.textContent ?? "").slice(0, 200),
          href: node instanceof HTMLAnchorElement ? node.href : null,
        })),
    }));
    const actions: PlanStep[] = [];
    for (const element of observed.elements) {
      const locator: LocatorSpec | undefined = element.testId
        ? { by: "testId", value: element.testId }
        : element.label
          ? { by: "label", value: element.label, exact: true }
          : element.tag === "button" && element.text
            ? { by: "role", role: "button", name: element.text, exact: true }
            : undefined;
      if (agent.exploration) {
        if (locator)
          for (const approved of agent.mutationActions ?? []) {
            if (
              approved.kind === "action" &&
              "locator" in approved.input &&
              JSON.stringify(approved.input.locator) === JSON.stringify(locator)
            )
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
    const observation = {
      url: page.url(),
      title: runtime.scrub(observed.title),
      text: runtime.scrub(observed.text),
      actions,
    };
    await runtime.artifact(
      `browser/steps/${step.id}-observation.json`,
      "dom",
      "application/json",
      Buffer.from(JSON.stringify(observation)),
    );
    const selected = await runtime.protocol.agent(step.id, observation);
    if (selected === null) {
      explorationStopped = true;
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
    const transitions: LocatorTransition[] = [];
    let waitStarted = performance.now();
    let sampling = false;
    let sampler: Promise<void> | undefined;
    let observationComplete = true;
    const sample = async () => {
      if (selected.operation !== "waitFor" || !("locator" in selected.input)) return;
      try {
        const locator = await locate(selected.input.locator, 100);
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
    waitStarted = performance.now();
    transitions.length = 0;
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
      await perform(selected);
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
      if (policy.allowDownloads !== true || expectedDownloadPage !== target) {
        void download.cancel().catch(() => undefined);
        deny("Unexpected download is not authorized");
      }
    });
    target.on("framenavigated", (frame) => {
      try {
        authorizeFrame(frame);
      } catch {
        deny("Frame navigation is not authorized");
      }
    });
  }
  try {
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
      try {
        authorizeUrl(runtime, route.request().url());
        await route.continue();
      } catch {
        await route.abort("blockedbyclient").catch(() => undefined);
        deny("Subrequest origin is not authorized");
      }
    });
    await context.routeWebSocket("**/*", (socket) => {
      void socket.close({
        code: 1008,
        reason: "WebSockets are not supported by this runner policy",
      });
      deny("WebSocket capability is not authorized");
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
    result = await runtime.runSteps(plan.steps, withEvidence);
    if (violation && result.outcome === "passed")
      result = { outcome: violation.outcome, reasonCode: violation.reasonCode };
  } catch (error) {
    if (runtime.signal.aborted) result = { outcome: "cancelled", reasonCode: "user_cancelled" };
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
