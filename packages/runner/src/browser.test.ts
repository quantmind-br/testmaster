import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { type PlanStep, type RunnerEvent, validate } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import type * as Playwright from "playwright-core";
import { type Browser, errors } from "playwright-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runBrowser } from "./browser.js";
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
