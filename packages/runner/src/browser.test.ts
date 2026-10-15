import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { type PlanStep, type RunnerEvent, validate } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import type * as Playwright from "playwright-core";
import { type Browser, errors } from "playwright-core";
import { afterEach, beforeEach, expect, it, type Mock, vi } from "vitest";
import { resolveExpectedUrl, runBrowser } from "./browser.js";
import { observePage } from "./observation.js";
import { ProtocolClient } from "./protocol.js";
import { type RunnerInput, Runtime } from "./runtime.js";

const launch = vi.hoisted(() => vi.fn());
vi.mock("playwright-core", async (importOriginal) => {
  const actual = await importOriginal<typeof Playwright>();
  return { chromium: { launch }, errors: actual.errors };
});

class LocatorStub {
  countValue = 1;
  text = "saved";
  frame: PageStub | undefined;
  readonly click = vi.fn(async () => {
    this.owner.onClick?.();
  });
  readonly fill = vi.fn(async () => undefined);
  readonly waitFor = vi.fn(async () => undefined);
  readonly selectOption = vi.fn(async () => []);
  readonly setInputFiles = vi.fn(async () => undefined);
  constructor(readonly owner: PageStub) {}
  async count() {
    return this.countValue;
  }
  async evaluateAll(_callback: unknown, attributes?: unknown) {
    if (attributes === undefined)
      return { attached: this.countValue > 0, visible: this.countValue > 0 };
    return {
      cardinality: this.countValue,
      candidates: [
        {
          role: "button",
          name: "Submit canary",
          tag: "button",
          type: "",
          attributes: { "data-testid": "submit" },
          matched: this.countValue > 0,
          visible: true,
        },
      ],
      truncated: false,
      origin: "http://fixture.test",
    };
  }
  async elementHandle() {
    return { contentFrame: async () => this.frame, dispose: async () => undefined };
  }
  async innerText() {
    return this.text;
  }
  async inputValue() {
    return this.text;
  }
  async isEnabled() {
    return true;
  }
  page() {
    return this.owner;
  }
}
class PageStub extends EventEmitter {
  readonly selectors = new Map<string, LocatorStub>();
  readonly screenshot = vi.fn(async () => Buffer.from("png"));
  readonly goto = vi.fn(async (url: string) => {
    this.href = url;
  });
  readonly close = vi.fn(async () => {
    this.closed = true;
  });
  readonly waitForURL = vi.fn(async () => undefined);
  readonly waitForResponse = vi.fn(async () => undefined);
  onClick: (() => void) | undefined;
  closed = false;
  href = "http://fixture.test/";
  locator(selector: string) {
    let locator = this.selectors.get(selector);
    if (!locator) {
      locator = new LocatorStub(this);
      this.selectors.set(selector, locator);
    }
    return locator;
  }
  getByTestId(value: string) {
    return this.locator(value);
  }
  getByText(value: string) {
    return this.locator(value);
  }
  frames() {
    return [this];
  }
  async evaluate() {
    return "<html>canary</html>";
  }
  isClosed() {
    return this.closed;
  }
  url() {
    return this.href;
  }
  video() {
    return null;
  }
  waitForEvent(name: string) {
    return new Promise<unknown>((resolve) => this.once(name, resolve));
  }
}
class ContextStub extends EventEmitter {
  readonly page = new PageStub();
  readonly route = vi.fn(async () => undefined);
  readonly routeWebSocket = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  readonly tracing = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
  async newPage() {
    return this.page;
  }
}
let context: ContextStub;
let closeBrowser = vi.fn(async () => undefined);
let events: RunnerEvent[];
let artifacts: { path: string; kind: string; bytes: Buffer }[];
function runtime(steps: PlanStep[], policy: RunnerInput["policy"] = {}): Runtime {
  const protocol = new ProtocolClient("att_01900000-0000-7000-8000-000000000001", "n".repeat(32));
  let seq = 0;
  vi.spyOn(protocol, "emit").mockImplementation(async (type, payload) => {
    events.push(
      validate<RunnerEvent>("RunnerEvent", {
        protocolVersion: "1.0.0",
        seq: seq++,
        attemptId: protocol.attemptId,
        occurredAt: new Date().toISOString(),
        type,
        payload,
      }),
    );
  });
  vi.spyOn(protocol, "artifact").mockImplementation(async (path, kind, _mime, bytes) => {
    artifacts.push({ path, kind, bytes: Buffer.from(bytes) });
  });
  return new Runtime(
    {
      attemptId: protocol.attemptId,
      nonce: "n".repeat(32),
      baseUrl: "http://fixture.test/",
      networkPolicy: { allowedOrigins: ["http://fixture.test"], networkProfile: "public" },
      secrets: [],
      policy,
      plan: {
        schemaVersion: "1.0.0",
        kind: "executable",
        name: "browser",
        type: "frontend",
        runner: "playwright",
        requirementRefs: [],
        steps,
      },
    },
    protocol,
  );
}
const click: PlanStep = {
  id: "click",
  kind: "action",
  operation: "click",
  description: "Click",
  input: { locator: { by: "testId", value: "submit" } },
};
const assertion: PlanStep = {
  id: "assert",
  kind: "assertion",
  operation: "assert",
  description: "Assert",
  input: { locator: { by: "testId", value: "message" } },
  expectation: { predicate: "textEquals", value: { literal: "saved" } },
  // Value predicates poll until the step deadline; keep failing cases fast.
  timeoutMs: 300,
};
beforeEach(() => {
  vi.stubEnv("TESTMASTER_EGRESS_PROXY", "http://127.0.0.1:3128");
  context = new ContextStub();
  closeBrowser = vi.fn(async () => undefined);
  events = [];
  artifacts = [];
  // Playwright is replaced at its launch boundary with an in-process behavioral double.
  const browser = {
    newContext: vi.fn(async () => context),
    close: closeBrowser,
  } as unknown as Browser;
  launch.mockResolvedValue(browser);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  launch.mockReset();
});

it("requires the supervisor proxy and never silently disables Chromium sandbox", async () => {
  vi.stubEnv("TESTMASTER_EGRESS_PROXY", "");
  expect(await runBrowser(runtime([assertion]))).toMatchObject({
    outcome: "blocked",
    reasonCode: "security_precondition_failed",
  });
  expect(launch).not.toHaveBeenCalled();
  vi.stubEnv("TESTMASTER_EGRESS_PROXY", "http://127.0.0.1:3128");
  expect(await runBrowser(runtime([assertion]))).toMatchObject({ outcome: "passed" });
  expect(launch).toHaveBeenCalledWith(
    expect.objectContaining({
      chromiumSandbox: true,
      proxy: { server: "http://127.0.0.1:3128", bypass: "<-loopback>" },
    }),
  );
  expect(closeBrowser).toHaveBeenCalled();
});
it("emits bounded hashed sanitized locator records on ordinary replay and failed actions", async () => {
  const attempt = runtime([click]);
  attempt.secrets.add("canary");
  context.page.locator("submit").countValue = 2;
  expect(await runBrowser(attempt)).toMatchObject({ outcome: "failed" });
  for (const phase of ["before", "after"]) {
    const artifact = artifacts.find(
      (entry) => entry.path === `browser/steps/click-locator-0-${phase}.json`,
    );
    expect(artifact?.kind).toBe("locator-evidence");
    const record = JSON.parse(artifact!.bytes.toString());
    const { evidenceHash, ...payload } = record;
    expect(record).toMatchObject({
      stepId: "click",
      phase,
      cardinality: 2,
      frameOrigin: "http://fixture.test",
    });
    expect(evidenceHash).toBe(semanticHash(payload));
    expect(artifact!.bytes.toString()).not.toContain("canary");
    expect(record.candidates[0].name).toBe("Submit [REDACTED]");
  }
  expect(events.find((event) => event.type === "step.finished")?.payload).toMatchObject({
    evidencePaths: expect.arrayContaining([
      "browser/steps/click-locator-0-before.json",
      "browser/steps/click-locator-0-after.json",
    ]),
  });
});
it("captures asynchronously attached action identity before acting and spends only the remaining step budget", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const target = context.page.locator("submit");
  target.countValue = 0;
  target.waitFor.mockImplementation(async () => {
    now += 75;
    target.countValue = 1;
  });
  expect(await runBrowser(runtime([{ ...click, timeoutMs: 200 }]))).toMatchObject({
    outcome: "passed",
  });
  const before = JSON.parse(
    artifacts
      .find((entry) => entry.path === "browser/steps/click-locator-0-before.json")!
      .bytes.toString(),
  );
  expect(before.cardinality).toBe(1);
  expect(before.candidates[0].matched).toBe(true);
  expect(target.click).toHaveBeenCalledWith(expect.objectContaining({ timeout: 125 }));
});
it("captures missing action targets once without restarting their attachment deadline", async () => {
  const target = context.page.locator("submit");
  target.countValue = 0;
  target.waitFor.mockRejectedValue(new errors.TimeoutError("Attachment deadline"));
  expect(await runBrowser(runtime([{ ...click, timeoutMs: 20 }]))).toMatchObject({
    outcome: "failed",
    reasonCode: "assertion_timeout",
  });
  expect(target.waitFor).toHaveBeenCalledOnce();
  expect(target.click).not.toHaveBeenCalled();
  for (const phase of ["before", "after"]) {
    const record = JSON.parse(
      artifacts
        .find((entry) => entry.path === `browser/steps/click-locator-0-${phase}.json`)!
        .bytes.toString(),
    );
    expect(record.cardinality).toBe(0);
  }
});
it("retains a readiness transition that occurs while before screenshots are collected", async () => {
  const target = context.page.locator("loading");
  context.page.screenshot.mockImplementation(async () => {
    target.countValue = 0;
    return Buffer.from("png");
  });
  const wait: PlanStep = {
    id: "wait",
    kind: "action",
    operation: "waitFor",
    description: "Wait",
    input: { locator: { by: "testId", value: "loading" }, state: "detached", deadlineMs: 100 },
  };
  expect(await runBrowser(runtime([wait]))).toMatchObject({ outcome: "passed" });
  const record = JSON.parse(
    artifacts
      .find((entry) => entry.path === "browser/steps/wait-locator-0-after.json")!
      .bytes.toString(),
  );
  expect(record.state.transitions.map((state: { attached: boolean }) => state.attached)).toEqual([
    true,
    false,
  ]);
});
it("preserves cancellation and attempt deadline precedence during attachment observation", async () => {
  for (const cancel of [false, true]) {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const attempt = runtime([click]);
    attempt.input.timeoutMs = 50;
    const target = context.page.locator("submit");
    target.countValue = 0;
    target.waitFor.mockImplementation(async () => {
      if (cancel) attempt.protocol.controller.abort();
      else now = 51;
      throw new errors.TimeoutError("Attachment deadline");
    });
    expect(await runBrowser(attempt)).toMatchObject({
      reasonCode: cancel ? "user_cancelled" : "execution_deadline",
    });
    expect(target.click).not.toHaveBeenCalled();
  }
});
it("fails ambiguous actions and skips the remaining required oracle", async () => {
  context.page.locator("submit").countValue = 2;
  expect(await runBrowser(runtime([click, assertion]))).toMatchObject({
    outcome: "failed",
    reasonCode: "assertion_mismatch",
  });
  expect(context.page.locator("submit").click).not.toHaveBeenCalled();
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "step.finished",
      payload: expect.objectContaining({ stepId: "assert", status: "skipped" }),
    }),
  );
});
it("selects numeric indices without treating them as typed value references", async () => {
  const select: PlanStep = {
    id: "select",
    kind: "action",
    operation: "select",
    description: "Select",
    input: {
      locator: { by: "testId", value: "options" },
      values: [{ index: 0 }, { label: { literal: "Two" } }],
    },
  };
  expect(await runBrowser(runtime([select, assertion]))).toMatchObject({ outcome: "passed" });
  expect(context.page.locator("options").selectOption).toHaveBeenCalledWith(
    [{ index: 0 }, { label: "Two" }],
    expect.objectContaining({ timeout: expect.any(Number) }),
  );
});
it("restores lexical frame scope and emits child-step events", async () => {
  const frame = new PageStub();
  context.page.locator("frame").frame = frame;
  const child = { ...click, id: "frame-click" };
  const enter: PlanStep = {
    id: "enter",
    kind: "action",
    operation: "frame",
    description: "Enter frame",
    input: { locator: { by: "testId", value: "frame" }, childSteps: [child] },
  };
  expect(await runBrowser(runtime([enter, click, assertion], { allowFrames: true }))).toMatchObject(
    { outcome: "passed" },
  );
  expect(frame.locator("submit").click).toHaveBeenCalledOnce();
  expect(context.page.locator("submit").click).toHaveBeenCalledOnce();
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "step.finished",
      payload: expect.objectContaining({ stepId: "frame-click", status: "passed" }),
    }),
  );
});
it("binds popup aliases only from approved policy and does not switch implicitly", async () => {
  const popup = new PageStub();
  context.page.onClick = () => context.emit("page", popup);
  const switchPage: PlanStep = {
    id: "switch",
    kind: "action",
    operation: "switchPage",
    description: "Switch",
    input: { pageAlias: "receipt" },
  };
  expect(
    await runBrowser(runtime([click, switchPage, assertion], { popupAliases: ["receipt"] })),
  ).toMatchObject({ outcome: "passed" });
  expect(popup.screenshot).toHaveBeenCalled();
  context = new ContextStub();
  context.page.onClick = () => context.emit("page", popup);
  // Same launch boundary, but a fresh context without popup authorization.
  const browser = { newContext: async () => context, close: closeBrowser } as unknown as Browser;
  launch.mockResolvedValue(browser);
  expect(await runBrowser(runtime([click, assertion]))).toMatchObject({
    outcome: "blocked",
    reasonCode: "egress_denied",
  });
});
interface RouteDouble {
  request: () => { url: () => string; method: () => string; resourceType: () => string };
  abort: Mock;
  continue: Mock;
}
function routeFor(url: string, resourceType: string, method = "GET"): RouteDouble {
  return {
    request: () => ({ url: () => url, method: () => method, resourceType: () => resourceType }),
    abort: vi.fn(async () => undefined),
    continue: vi.fn(async () => undefined),
  };
}
/** Fires the route handler Chromium would call for each request while the click step runs. */
function requestsOnClick(...routes: RouteDouble[]): void {
  context.page.onClick = () => {
    const handler = (context.route.mock.calls as unknown[][])[0]?.[1] as
      | ((route: RouteDouble) => Promise<void>)
      | undefined;
    if (!handler) throw new Error("Route handler was not installed");
    for (const route of routes) void handler(route);
  };
}
const egressEvents = () =>
  events.flatMap((event) => (event.type === "egress.denied" ? [event.payload] : []));
it("aborts passive subresources from an unapproved origin, records them once per origin and type, and still passes", async () => {
  const flag = routeFor("https://cdn.example.test/flags/br.png?token=url-canary", "image");
  const second = routeFor("https://cdn.example.test/flags/ar.png", "image");
  const font = routeFor("https://cdn.example.test/f.woff2", "font", "HEAD");
  requestsOnClick(flag, second, font);
  expect(await runBrowser(runtime([click, assertion]))).toMatchObject({
    outcome: "passed",
    reasonCode: "assertions_satisfied",
  });
  expect(flag.abort).toHaveBeenCalledWith("blockedbyclient");
  expect(flag.continue).not.toHaveBeenCalled();
  expect(egressEvents()).toEqual([
    {
      stepId: "click",
      origin: "https://cdn.example.test",
      method: "GET",
      resourceType: "image",
      disposition: "aborted",
      count: 2,
    },
    {
      stepId: "click",
      origin: "https://cdn.example.test",
      method: "HEAD",
      resourceType: "font",
      disposition: "aborted",
      count: 1,
    },
  ]);
  // Origin only: neither the path nor the query leaves the route handler.
  expect(JSON.stringify(egressEvents())).not.toContain("url-canary");
  expect(JSON.stringify(egressEvents())).not.toContain("flags");
});
it.each([
  ["script", "GET"],
  ["xhr", "GET"],
  ["fetch", "GET"],
  ["document", "GET"],
  ["eventsource", "GET"],
  ["manifest", "GET"],
  ["other", "GET"],
  ["image", "POST"],
])("blocks the run when a %s %s request targets an unapproved origin", async (type, method) => {
  const request = routeFor("https://tracker.example.test/collect?id=url-canary", type, method);
  requestsOnClick(request);
  expect(await runBrowser(runtime([click, assertion]))).toMatchObject({
    outcome: "blocked",
    reasonCode: "egress_denied",
  });
  expect(request.abort).toHaveBeenCalledWith("blockedbyclient");
  expect(request.continue).not.toHaveBeenCalled();
  expect(egressEvents()).toEqual([
    expect.objectContaining({
      origin: "https://tracker.example.test",
      resourceType: type,
      disposition: "fatal",
      count: 1,
    }),
  ]);
  expect(JSON.stringify(egressEvents())).not.toContain("url-canary");
});
it("never downgrades an unapproved passive request whose URL is ambiguous", async () => {
  const ambiguous = routeFor("https://cdn.example.test\\@evil.example.test/a.png", "image");
  requestsOnClick(ambiguous);
  expect(await runBrowser(runtime([click, assertion]))).toMatchObject({
    outcome: "blocked",
    reasonCode: "egress_denied",
  });
  expect(egressEvents()).toEqual([expect.objectContaining({ disposition: "fatal" })]);
});
it("lets an approved additional origin through without recording a denial", async () => {
  const attempt = runtime([click, assertion]);
  attempt.input.networkPolicy.allowedOrigins.push("https://cdn.example.test");
  attempt.input.networkPolicy.additionalOrigins = ["https://cdn.example.test"];
  const approved = routeFor("https://cdn.example.test/flags/br.png", "image");
  const script = routeFor("https://cdn.example.test/app.js", "script");
  requestsOnClick(approved, script);
  expect(await runBrowser(attempt)).toMatchObject({
    outcome: "passed",
    reasonCode: "assertions_satisfied",
  });
  expect(approved.continue).toHaveBeenCalledOnce();
  expect(script.continue).toHaveBeenCalledOnce();
  expect(approved.abort).not.toHaveBeenCalled();
  expect(egressEvents()).toEqual([]);
});
it("never replays a stored session toward an additional origin", async () => {
  const secretRef = "sec_019bf434-20c0-7000-8000-000000000001";
  const attempt = runtime([assertion]);
  attempt.input.networkPolicy.allowedOrigins.push("https://cdn.example.test");
  attempt.input.networkPolicy.additionalOrigins = ["https://cdn.example.test"];
  Object.assign(attempt.input, {
    secrets: [{ secretRef, secretVersion: 1 }],
    auth: { storageState: { secretRef } },
  });
  const cookie = (domain: string) => ({
    name: "sid",
    value: `session-for-${domain}`,
    domain,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  });
  vi.spyOn(attempt.protocol, "secret").mockResolvedValue(
    JSON.stringify({ cookies: [cookie("fixture.test"), cookie("cdn.example.test")], origins: [] }),
  );
  const newContext = vi.fn(async () => context);
  launch.mockResolvedValue({ newContext, close: closeBrowser } as unknown as Browser);
  expect(await runBrowser(attempt)).toMatchObject({ outcome: "passed" });
  const options = newContext.mock.calls[0]?.[0] as unknown as {
    storageState: { cookies: { domain: string }[] };
  };
  expect(options.storageState.cookies.map((entry) => entry.domain)).toEqual(["fixture.test"]);
});
it("captures before/after evidence and scrubs DOM and console canaries", async () => {
  const attempt = runtime([click, assertion]);
  attempt.secrets.add("canary");
  context.page.onClick = () =>
    context.page.emit("console", { type: () => "log", text: () => "canary" });
  expect(await runBrowser(attempt)).toMatchObject({ outcome: "passed" });
  expect(artifacts.map((artifact) => artifact.path)).toContain("browser/steps/click-before.png");
  expect(artifacts.map((artifact) => artifact.path)).toContain("browser/steps/click-after.png");
  expect(
    artifacts
      .filter((artifact) => artifact.kind !== "screenshot")
      .every((artifact) => !artifact.bytes.includes("canary")),
  ).toBe(true);
  expect(context.page.screenshot).toHaveBeenCalledWith(
    expect.objectContaining({ mask: expect.arrayContaining([context.page.locator("canary")]) }),
  );
});
it("waits for an authorized download before triggering and checks exact digest/MIME/size", async () => {
  const bytes = Buffer.from("approved");
  context.page.onClick = () => {
    context.page.emit("response", {
      url: () => "http://fixture.test/file",
      status: () => 200,
      headers: () => ({ "content-type": "text/plain; charset=utf-8" }),
    });
    context.page.emit("download", {
      url: () => "http://fixture.test/file",
      createReadStream: async () => Readable.from([bytes]),
      failure: async () => null,
      delete: async () => undefined,
    });
  };
  const download: PlanStep = {
    id: "download",
    kind: "action",
    operation: "download",
    description: "Download",
    input: {
      trigger: { operation: "click", input: { locator: { by: "testId", value: "submit" } } },
      outputName: "receipt.txt",
    },
  };
  const check: PlanStep = {
    id: "download-assert",
    kind: "assertion",
    operation: "assert",
    description: "Check download",
    input: { outputName: "receipt.txt" },
    expectation: {
      predicate: "downloadMatches",
      outputName: "receipt.txt",
      mimeType: "text/plain",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
  expect(await runBrowser(runtime([download, check], { allowDownloads: true }))).toMatchObject({
    outcome: "passed",
  });
  expect(artifacts.find((artifact) => artifact.kind === "download")?.bytes).toEqual(bytes);
});
it("enforces typed wait deadlines and refuses raw artifacts without explicit authorization", async () => {
  const wait: PlanStep = {
    id: "wait",
    kind: "action",
    operation: "waitFor",
    description: "Wait",
    input: { locator: { by: "testId", value: "message" }, state: "visible", deadlineMs: 20 },
  };
  expect(await runBrowser(runtime([wait, assertion]))).toMatchObject({ outcome: "passed" });
  expect(context.page.locator("message").waitFor).toHaveBeenCalledWith({
    state: "visible",
    timeout: 20,
  });
  launch.mockClear();
  expect(await runBrowser(runtime([assertion], { trace: true }))).toMatchObject({
    outcome: "blocked",
    reasonCode: "security_precondition_failed",
  });
  expect(launch).not.toHaveBeenCalled();
});
it("fails a real negative oracle instead of claiming screenshot capture means success", async () => {
  context.page.locator("message").text = "broken";
  expect(await runBrowser(runtime([assertion]))).toMatchObject({
    outcome: "failed",
    reasonCode: "assertion_mismatch",
  });
});
it("waits for an eventually consistent value within the step deadline but fails on a stale one", async () => {
  const message = context.page.locator("message");
  // The product renders the value after a few observations (e.g. an async toast).
  let reads = 0;
  vi.spyOn(message, "innerText").mockImplementation(async () => (++reads < 3 ? "" : "saved"));
  expect(await runBrowser(runtime([assertion]))).toMatchObject({ outcome: "passed" });
  expect(reads).toBe(3);
  vi.spyOn(message, "innerText").mockImplementation(async () => "");
  expect(await runBrowser(runtime([assertion]))).toMatchObject({
    outcome: "failed",
    reasonCode: "assertion_mismatch",
  });
  expect(
    events.findLast((event) => event.type === "step.finished" && event.payload.stepId === "assert")
      ?.payload,
  ).toMatchObject({ observed: "", expected: "saved" });
});
it("keeps a stale observation as the mismatch when the final sample read times out", async () => {
  const message = context.page.locator("message");
  // The last poll gets only the remaining milliseconds of the deadline; Playwright can time
  // out that read even though the element is attached and was already observed.
  let reads = 0;
  vi.spyOn(message, "innerText").mockImplementation(async () => {
    if (++reads < 3) return "1.25";
    throw new errors.TimeoutError("locator.innerText: Timeout 1ms exceeded.");
  });
  expect(await runBrowser(runtime([assertion]))).toMatchObject({
    outcome: "failed",
    reasonCode: "assertion_mismatch",
  });
  expect(
    events.findLast((event) => event.type === "step.finished" && event.payload.stepId === "assert")
      ?.payload,
  ).toMatchObject({ observed: "1.25", expected: "saved" });
  // Without any observation, the read timeout stays a timeout.
  vi.spyOn(message, "innerText").mockImplementation(async () => {
    throw new errors.TimeoutError("locator.innerText: Timeout exceeded.");
  });
  expect(await runBrowser(runtime([assertion]))).toMatchObject({
    outcome: "failed",
    reasonCode: "assertion_timeout",
  });
});
it("blocks unauthorized uploads before touching filesystem or target inputs", async () => {
  const upload: PlanStep = {
    id: "upload",
    kind: "action",
    operation: "upload",
    description: "Upload",
    input: {
      locator: { by: "testId", value: "file" },
      artifactRefs: ["art_01900000-0000-7000-8000-000000000001"],
    },
  };
  expect(await runBrowser(runtime([upload, assertion]))).toMatchObject({
    outcome: "blocked",
    reasonCode: "security_precondition_failed",
  });
  expect(context.page.locator("file").setInputFiles).not.toHaveBeenCalled();
});
it("allows detached waits to target absent elements but rejects ambiguous hidden waits", async () => {
  context.page.locator("gone").countValue = 0;
  const wait: PlanStep = {
    id: "wait",
    kind: "action",
    operation: "waitFor",
    description: "Wait",
    input: { locator: { by: "testId", value: "gone" }, state: "detached", deadlineMs: 20 },
  };
  expect(await runBrowser(runtime([wait, assertion]))).toMatchObject({ outcome: "passed" });
  context.page.locator("gone").countValue = 2;
  expect(await runBrowser(runtime([wait, assertion]))).toMatchObject({
    outcome: "failed",
    reasonCode: "assertion_mismatch",
  });
});

it("distinguishes a live state-wait timeout from a crashed page without treating either as passed", async () => {
  const wait: PlanStep = {
    id: "wait",
    kind: "action",
    operation: "waitFor",
    description: "Wait",
    input: { locator: { by: "testId", value: "message" }, state: "detached", deadlineMs: 20 },
  };
  context.page
    .locator("message")
    .waitFor.mockRejectedValue(new errors.TimeoutError("State deadline"));
  expect(await runBrowser(runtime([wait, assertion]))).toMatchObject({
    outcome: "failed",
    reasonCode: "assertion_timeout",
  });
  expect(
    events.find((event) => event.type === "step.finished" && event.payload.stepId === "wait")
      ?.payload,
  ).toMatchObject({ status: "failed", reasonCode: "assertion_timeout" });
  context.page.closed = true;
  context.page.locator("message").waitFor.mockRejectedValue(new Error("Page crashed"));
  expect(await runBrowser(runtime([wait, assertion]))).toMatchObject({
    outcome: "inconclusive",
    reasonCode: "insufficient_evidence",
  });
});

it("retains business assertion values for diagnosis but omits secret-derived and oversized comparisons", async () => {
  expect(await runBrowser(runtime([assertion]))).toMatchObject({ outcome: "passed" });
  expect(
    events.find((event) => event.type === "step.finished" && event.payload.stepId === "assert")
      ?.payload,
  ).toMatchObject({ observed: "saved", expected: "saved" });
  events = [];
  context.page.locator("message").text = "wrong-price";
  expect(await runBrowser(runtime([assertion]))).toMatchObject({
    outcome: "failed",
    reasonCode: "assertion_mismatch",
  });
  expect(events.find((event) => event.type === "step.finished")?.payload).toMatchObject({
    observed: "wrong-price",
    expected: "saved",
  });
  for (const value of ["private-business-value", "x".repeat(8193)]) {
    events = [];
    context.page.locator("message").text = value;
    const attempt = runtime([assertion]);
    attempt.secrets.add("private-business-value");
    expect(await runBrowser(attempt)).toMatchObject({ outcome: "failed" });
    const payload = events.find((event) => event.type === "step.finished")!.payload;
    expect(payload).not.toHaveProperty("observed");
    expect(payload).not.toHaveProperty("expected");
    expect(JSON.stringify(events)).not.toContain("private-business-value");
  }
  events = [];
  const reused = runtime([assertion]);
  context.page.locator("message").text = "saved";
  expect(await runBrowser(reused)).toMatchObject({ outcome: "passed" });
  context.page.locator("message").text = "private-business-value";
  reused.secrets.add("private-business-value");
  expect(await runBrowser(reused)).toMatchObject({ outcome: "failed" });
  const last = events.filter((event) => event.type === "step.finished").at(-1)!.payload;
  expect(last).not.toHaveProperty("observed");
  expect(last).not.toHaveProperty("expected");
});
it("launches Chromium with explicit password-store and keychain isolation and no default-arg override", async () => {
  expect(await runBrowser(runtime([assertion]))).toMatchObject({ outcome: "passed" });
  const options = launch.mock.calls[0]?.[0];
  expect(options.args).toEqual(
    expect.arrayContaining(["--password-store=basic", "--use-mock-keychain"]),
  );
  expect(options.ignoreDefaultArgs).toBeUndefined();
  expect(options.args).toEqual(
    expect.arrayContaining([
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ]),
  );
});
it("blocks a fill whose secret reference is absent from the snapshot before typing", async () => {
  const fill: PlanStep = {
    id: "fill-password",
    kind: "action",
    operation: "fill",
    description: "Fill password",
    input: {
      locator: { by: "testId", value: "password" },
      value: { secretRef: "sec_019bf434-20c0-7000-8000-000000000001" },
    },
  };
  const attempt = runtime([fill, click]);
  const secret = vi.spyOn(attempt.protocol, "secret");
  expect(await runBrowser(attempt)).toMatchObject({
    outcome: "blocked",
    reasonCode: "missing_secret",
  });
  expect(secret).not.toHaveBeenCalled();
  expect(context.page.locator("password").fill).not.toHaveBeenCalled();
  expect(context.page.locator("submit").click).not.toHaveBeenCalled();
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "step.finished",
      payload: expect.objectContaining({
        stepId: "fill-password",
        status: "blocked",
        reasonCode: "missing_secret",
      }),
    }),
  );
});
it("keeps a proven assertion failure when a later revocation cancels the attempt", async () => {
  context.page.locator("message").text = "unexpected";
  const attempt = runtime([assertion, click]);
  const emit = vi.mocked(attempt.protocol.emit);
  const record = emit.getMockImplementation();
  if (!record) throw new Error("Missing emit double");
  emit.mockImplementation(async (type, payload) => {
    await record(type, payload);
    // Revocation lands after the oracle has already produced its negative verdict.
    if (
      type === "step.finished" &&
      typeof payload === "object" &&
      payload !== null &&
      "stepId" in payload &&
      payload.stepId === "assert"
    )
      attempt.protocol.controller.abort();
  });
  expect(await runBrowser(attempt)).toMatchObject({
    outcome: "failed",
    reasonCode: "assertion_mismatch",
  });
  expect(context.page.locator("submit").click).not.toHaveBeenCalled();
});
it("refuses storage-state input as unsupported before launching Chromium", async () => {
  for (const carrier of ["input", "browser", "policy"] as const) {
    const attempt = runtime([assertion]);
    const state = { cookies: [], origins: [] };
    if (carrier === "input") Object.assign(attempt.input, { storageState: state });
    else {
      attempt.input[carrier] ??= {};
      Object.assign(attempt.input[carrier], { storageState: state });
    }
    expect(await runBrowser(attempt)).toMatchObject({
      outcome: "blocked",
      reasonCode: "unsupported_capability",
    });
  }
  expect(launch).not.toHaveBeenCalled();
});

function exploring(
  agent: Partial<NonNullable<RunnerInput["agent"]>> = {},
  explore: Partial<PlanStep> = {},
): Runtime {
  const step = {
    id: "explore-0",
    description: "Follow a grounded admitted link",
    kind: "action",
    operation: "navigate",
    input: { path: "/" },
    ...explore,
  } as PlanStep;
  const attempt = runtime([step, assertion]);
  Object.assign(attempt.input, {
    agent: {
      resolveSteps: ["explore-0"],
      exploration: true,
      mutationStepIds: [],
      maxRequests: 1,
      ...agent,
    },
  });
  return attempt;
}
const observedPage = (over: Record<string, unknown> = {}) => ({
  title: "Sign in",
  text: "Skip to content",
  controls: [],
  hasPasswordField: false,
  elements: [],
  ...over,
});
/** The browser answers each `observePage` read from the queue, and the last one repeatedly. */
function pageReads(...reads: unknown[]) {
  let next = 0;
  return vi
    .spyOn(context.page, "evaluate")
    .mockImplementation((async (fn: unknown) =>
      fn === observePage
        ? reads[Math.min(next++, reads.length - 1)]
        : "<html>canary</html>") as never);
}
const observationOf = (path = "browser/steps/explore-0-observation.json") =>
  JSON.parse(String(artifacts.find((entry) => entry.path === path)?.bytes));

it("a first observation with no action ends the exploration inconclusive and describes the page", async () => {
  const attempt = exploring({ requireActionable: true });
  const agent = vi.spyOn(attempt.protocol, "agent").mockResolvedValue(null);
  pageReads(
    observedPage({
      hasPasswordField: true,
      controls: [
        {
          tag: "input",
          type: "password",
          role: null,
          name: null,
          placeholder: "Enter your password",
          testId: null,
          visible: true,
        },
        {
          tag: "button",
          type: "submit",
          role: "button",
          name: "Continue",
          placeholder: null,
          testId: null,
          visible: true,
        },
      ],
    }),
  );
  expect(await runBrowser(attempt)).toMatchObject({
    outcome: "inconclusive",
    reasonCode: "insufficient_evidence",
  });
  // The host still sees the observation (it records the Feature state), and it is described, not valued.
  expect(agent).toHaveBeenCalledTimes(1);
  expect(observationOf()).toMatchObject({
    settled: true,
    hasPasswordField: true,
    actions: [],
    controls: [{ type: "password", placeholder: "Enter your password" }, { name: "Continue" }],
  });
  expect(
    events.filter((event) => event.type === "step.finished").map((event) => event.payload),
  ).toMatchObject([
    {
      stepId: "explore-0",
      status: "inconclusive",
      reasonCode: "insufficient_evidence",
      error: {
        message:
          "Exploration observed no same-origin link at http://fixture.test/: 2 form controls, password field present, 0 approved actions.",
      },
    },
    { stepId: "assert", status: "skipped" },
  ]);
  // What was seen is kept even though the closing assertion never ran.
  expect(artifacts.some((entry) => entry.path === "browser/steps/explore-0-after.png")).toBe(true);

  // Control: a seeded exploration treats the page itself as the target, so no link is fine.
  artifacts.length = 0;
  events.length = 0;
  const seeded = exploring({ requireActionable: false });
  vi.spyOn(seeded.protocol, "agent").mockResolvedValue(null);
  expect(await runBrowser(seeded)).toMatchObject({ outcome: "passed" });

  // Control: a first page with an observed link is explored, not refused.
  const linked = exploring({ requireActionable: true });
  const choose = vi.spyOn(linked.protocol, "agent").mockResolvedValue(null);
  pageReads(
    observedPage({
      elements: [
        {
          tag: "a",
          testId: null,
          label: null,
          placeholder: null,
          role: "link",
          name: null,
          text: "Orders",
          href: "http://fixture.test/orders",
        },
      ],
    }),
  );
  expect(await runBrowser(linked)).toMatchObject({ outcome: "passed" });
  expect(choose.mock.calls[0]?.[1]).toMatchObject({
    actions: [{ operation: "navigate", input: { path: "http://fixture.test/orders" } }],
  });
  // Neither passing exploration reported insufficient evidence anywhere.
  expect(
    JSON.stringify(events.filter((event) => event.type === "step.finished").map((e) => e.payload)),
  ).not.toContain("insufficient_evidence");
});

it("waits for two equal reads before observing and reports a page that never settles", async () => {
  const reads = pageReads(
    observedPage({ text: "Loading..." }),
    observedPage({ text: "Sign in form" }),
    observedPage({ text: "Sign in form" }),
  );
  const settling = exploring();
  vi.spyOn(settling.protocol, "agent").mockResolvedValue(null);
  await runBrowser(settling);
  const observations = reads.mock.calls.filter(([fn]) => fn === observePage);
  expect(observations).toHaveLength(3);
  expect(observationOf()).toMatchObject({ settled: true, text: "Sign in form" });

  // The wait is bounded by the step deadline: a page that keeps changing is observed as it stands.
  artifacts.length = 0;
  let tick = 0;
  vi.spyOn(context.page, "evaluate").mockImplementation((async (fn: unknown) =>
    fn === observePage
      ? observedPage({ text: `clock ${tick++}` })
      : "<html>canary</html>") as never);
  const drifting = exploring({}, { timeoutMs: 600 });
  vi.spyOn(drifting.protocol, "agent").mockResolvedValue(null);
  await runBrowser(drifting);
  expect(tick).toBe(2);
  expect(observationOf()).toMatchObject({ settled: false, text: "clock 1" });
});

it("offers an approved mutation when it matches a control by placeholder or by role and name", async () => {
  const approved = (locator: unknown, value: string): PlanStep =>
    ({
      id: "approved",
      description: "Fill",
      kind: "action",
      operation: "fill",
      input: { locator, value: { literal: value } },
    }) as PlanStep;
  const byPlaceholder = approved(
    { by: "placeholder", value: "Enter your email", exact: true },
    "a@example.com",
  );
  const byRole = approved(
    { by: "role", role: "textbox", name: "Email", exact: true },
    "b@example.com",
  );
  const elsewhere = approved({ by: "placeholder", value: "Search", exact: true }, "c");
  const attempt = exploring({ mutationActions: [byPlaceholder, byRole, elsewhere] });
  const choose = vi.spyOn(attempt.protocol, "agent").mockResolvedValue(null);
  pageReads(
    observedPage({
      elements: [
        {
          tag: "input",
          testId: null,
          label: null,
          placeholder: "Enter your email",
          role: "textbox",
          name: "Email",
          text: "",
          href: null,
        },
      ],
    }),
  );
  await runBrowser(attempt);
  // Both approved locators match the one control; the unrelated approval is not offered.
  expect(choose.mock.calls[0]?.[1]).toMatchObject({
    actions: [
      { ...byPlaceholder, id: "explore-0" },
      { ...byRole, id: "explore-0" },
    ],
  });
  expect(choose.mock.calls[0]?.[1]).toHaveProperty("actions.length", 2);
});

function urlCheck(value: string): PlanStep {
  return {
    id: "url",
    kind: "assertion",
    operation: "assert",
    description: "URL",
    input: {},
    expectation: { predicate: "urlEquals", value: { literal: value } },
    timeoutMs: 300,
  } as PlanStep;
}
/** Playwright's waitForURL resolves when the predicate holds for the current URL, else times out. */
function waitForURLLikePlaywright() {
  (context.page.waitForURL as Mock).mockImplementation(async (matcher: (url: URL) => boolean) => {
    if (typeof matcher !== "function" || !matcher(new URL(context.page.href)))
      throw new errors.TimeoutError("waitForURL timed out");
  });
}
it("resolves a relative urlEquals value against the environment base URL, like a navigate path", async () => {
  waitForURLLikePlaywright();
  context.page.href = "http://fixture.test/dashboard";
  for (const expected of ["/dashboard", "http://fixture.test/dashboard", "dashboard"]) {
    events = [];
    expect(await runBrowser(runtime([urlCheck(expected)]))).toMatchObject({ outcome: "passed" });
    expect(
      events.find((event) => event.type === "step.finished" && event.payload.stepId === "url")
        ?.payload,
    ).toMatchObject({
      status: "passed",
      observed: "http://fixture.test/dashboard",
      expected: "http://fixture.test/dashboard",
    });
  }
  // The matcher is a predicate: a string would be read as a glob pattern by Playwright.
  expect(typeof (context.page.waitForURL.mock.calls as unknown[][])[0]?.[0]).toBe("function");
});
it("fails a urlEquals mismatch as assertion_mismatch and records observed and expected URLs", async () => {
  waitForURLLikePlaywright();
  context.page.href = "http://fixture.test/login?next=%2Fdashboard";
  expect(await runBrowser(runtime([urlCheck("/dashboard")]))).toMatchObject({
    outcome: "failed",
    reasonCode: "assertion_mismatch",
  });
  const payload = events.find(
    (event) => event.type === "step.finished" && event.payload.stepId === "url",
  )?.payload as { error: { message: string }; observed: string; expected: string };
  expect(payload.observed).toBe("http://fixture.test/login?next=%2Fdashboard");
  expect(payload.expected).toBe("http://fixture.test/dashboard");
  expect(payload.error.message).toBe(
    "Page URL http://fixture.test/login?next=%2Fdashboard differs from expected URL http://fixture.test/dashboard",
  );
});
it("reports a fatal egress denial, not the closed page it causes, while a URL assertion waits", async () => {
  // The destination page fetches an unapproved origin while the assertion waits for its URL: the
  // denial closes the context, so the pending wait fails with a closed-page error.
  const news = routeFor("https://news.example.test/news.json", "fetch");
  (context.page.waitForURL as Mock).mockImplementation(async () => {
    const handler = (context.route.mock.calls as unknown[][])[0]?.[1] as (
      route: RouteDouble,
    ) => Promise<void>;
    await handler(news);
    throw new Error("page.waitForURL: Target page, context or browser has been closed");
  });
  expect(await runBrowser(runtime([urlCheck("/settings")]))).toMatchObject({
    outcome: "blocked",
    reasonCode: "egress_denied",
  });
  expect(egressEvents()).toEqual([
    expect.objectContaining({ origin: "https://news.example.test", disposition: "fatal" }),
  ]);
});
it("resolves expected URLs with the navigate rules and refuses a relative one without a base", () => {
  expect(resolveExpectedUrl("/a?x=1", "http://h.test/base/")).toBe("http://h.test/a?x=1");
  expect(resolveExpectedUrl("a", "http://h.test/base/")).toBe("http://h.test/base/a");
  expect(resolveExpectedUrl("https://other.test", "http://h.test")).toBe("https://other.test/");
  expect(() => resolveExpectedUrl("/a", undefined)).toThrow(
    expect.objectContaining({ reasonCode: "security_precondition_failed" }),
  );
});
