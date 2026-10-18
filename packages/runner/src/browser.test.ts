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
  disabled = false;
  frame: PageStub | undefined;
  readonly click = vi.fn(async () => {
    this.owner.onClick?.();
  });
  readonly fill = vi.fn(async () => undefined);
  readonly waitFor = vi.fn(async () => undefined);
  readonly selectOption = vi.fn(async () => []);
  readonly setInputFiles = vi.fn(async () => undefined);
  constructor(
    readonly owner: PageStub,
    readonly key: string,
  ) {}
  /** A chained locator is its own stub, keyed by the chain, like Playwright's lazy resolution. */
  getByTestId(value: string) {
    return this.owner.locator(`${this.key} >> ${value}`);
  }
  /** `.nth(i)` matches the one element at index i of this locator's matches, or none past the end. */
  nth(index: number) {
    const picked = this.owner.locator(`${this.key} >> nth=${index}`);
    picked.countValue = index < this.countValue ? 1 : 0;
    return picked;
  }
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
    return !this.disabled;
  }
  async isDisabled() {
    return this.disabled;
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
      locator = new LocatorStub(this, selector);
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
function runtime(
  steps: PlanStep[],
  policy: RunnerInput["policy"] = {},
  limits: Pick<RunnerInput, "stepTimeoutMs" | "stepTimeoutCapMs"> = {},
): Runtime {
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
      ...limits,
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
  vi.unstubAllGlobals();
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
/**
 * The locator evidence collector runs inside the page, so these tests execute the very callback
 * handed to `evaluateAll` against a small DOM. It implements only the surface the collector reads.
 */
class DomText {
  readonly nodeType = 3;
  parentElement: DomElement | null = null;
  constructor(readonly textContent: string) {}
}
class DomElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly localName: string;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly childNodes: (DomElement | DomText)[] = [];
  parentElement: DomElement | null = null;
  constructor(
    tag: string,
    readonly attrs: Record<string, string> = {},
    children: (DomElement | string)[] = [],
  ) {
    this.tagName = tag.toUpperCase();
    this.localName = tag;
    for (const child of children) {
      const node = typeof child === "string" ? new DomText(child) : child;
      node.parentElement = this;
      this.childNodes.push(node);
    }
  }
  hasAttribute(name: string) {
    return name in this.attrs;
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  closest(selector: string): DomElement | null {
    const parts = selector.split(",");
    for (let node: DomElement | null = this; node; node = node.parentElement) {
      const candidate = node;
      if (parts.some((part) => candidate.matches(part))) return candidate;
    }
    return null;
  }
  private matches(part: string) {
    const [, name, value] = /^\[([a-z-]+)(?:\*=(.+))?\]$/u.exec(part) ?? [];
    if (!name) return this.tagName === part.toUpperCase();
    const actual = this.attrs[name];
    return actual !== undefined && (value === undefined || actual.includes(value));
  }
  checkVisibility() {
    return true;
  }
  getBoundingClientRect() {
    return { width: 10, height: 10 };
  }
}
class DomDocument {
  readonly location = { origin: "http://fixture.test" };
  constructor(readonly documentElement: DomElement) {}
  getElementById() {
    return null;
  }
  createTreeWalker(
    root: DomElement,
    whatToShow: number,
    filter?: { acceptNode: (node: DomElement) => number },
  ) {
    const nodes: (DomElement | DomText)[] = [];
    const collect = (node: DomElement) => {
      for (const child of node.childNodes) {
        // FILTER_REJECT (2) skips the element and its whole subtree, as in the DOM.
        if (child instanceof DomElement && filter?.acceptNode(child) === 2) continue;
        if (child.nodeType === (whatToShow === 1 ? 1 : 3)) nodes.push(child);
        if (child instanceof DomElement) collect(child);
      }
    };
    collect(root);
    let position = 0;
    const walker = {
      currentNode: root as DomElement | DomText,
      nextNode: () => {
        const next = nodes[position++];
        if (next) walker.currentNode = next;
        return next ?? null;
      },
    };
    return walker;
  }
}
/** An element in the SVG namespace, as an inline <svg> in an HTML page creates it. */
function svgElement(
  tag: string,
  attrs: Record<string, string> = {},
  children: DomElement[] = [],
): DomElement {
  const element = new DomElement(tag, attrs, children);
  element.namespaceURI = "http://www.w3.org/2000/svg";
  return element;
}
/** Replaces the locator's candidate collection with the real in-page callback run on `body`. */
function observeDom(
  target: LocatorStub,
  body: (DomElement | string)[],
  matches: DomElement[] = [],
) {
  const dom = new DomDocument(
    new DomElement("html", {}, [
      new DomElement("head", {}, [new DomElement("title", {}, ["Fixture"])]),
      new DomElement("body", {}, body),
    ]),
  );
  const readiness = target.evaluateAll.bind(target);
  target.evaluateAll = (async (callback: (...args: unknown[]) => unknown, attributes?: unknown) => {
    if (attributes === undefined) return readiness(callback);
    vi.stubGlobal("document", dom);
    vi.stubGlobal("NodeFilter", {
      SHOW_ELEMENT: 1,
      SHOW_TEXT: 4,
      FILTER_ACCEPT: 1,
      FILTER_REJECT: 2,
    });
    vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
    return callback(matches, attributes);
  }) as never;
}
function recordedLocator(phase: "before" | "after" = "before") {
  return JSON.parse(
    artifacts
      .find((entry) => entry.path === `browser/steps/click-locator-0-${phase}.json`)!
      .bytes.toString(),
  ) as {
    cardinality: number;
    truncated: boolean;
    candidates: { tag: string; role: string; name: string; matched: boolean; visible: boolean }[];
  };
}
it("records a named control that follows more than a hundred anonymous wrappers", async () => {
  const wrappers = Array.from({ length: 150 }, () => new DomElement("div"));
  observeDom(context.page.locator("submit"), [
    ...wrappers,
    new DomElement("button", {}, ["Sign in"]),
  ]);
  expect(await runBrowser(runtime([click]))).toMatchObject({ outcome: "passed" });
  const record = recordedLocator();
  expect(record.candidates).toEqual([
    expect.objectContaining({ tag: "button", role: "button", name: "Sign in", matched: false }),
  ]);
  expect(record.truncated).toBe(false);
});
it("skips an icon sprite's hundreds of identified symbols and records the form after it", async () => {
  const symbols = Array.from({ length: 150 }, (_, index) =>
    svgElement("symbol", { id: `t-icon-${index}` }, [svgElement("path", { id: `p-${index}` })]),
  );
  observeDom(context.page.locator("submit"), [
    svgElement("svg", { "aria-hidden": "true" }, [svgElement("defs", {}, symbols)]),
    new DomElement("input", { placeholder: "Email" }),
  ]);
  expect(await runBrowser(runtime([click]))).toMatchObject({ outcome: "passed" });
  const record = recordedLocator();
  expect(record.candidates).toEqual([
    expect.objectContaining({ tag: "input", role: "textbox", matched: false }),
  ]);
  expect(record.truncated).toBe(false);
});
it("always records matched elements, even anonymous ones behind a full budget of identified controls", async () => {
  const controls = Array.from(
    { length: 120 },
    (_, index) => new DomElement("button", {}, [`Control ${index}`]),
  );
  const matchedWrapper = new DomElement("div");
  observeDom(context.page.locator("submit"), [...controls, matchedWrapper], [matchedWrapper]);
  expect(await runBrowser(runtime([click]))).toMatchObject({ outcome: "passed" });
  const record = recordedLocator();
  expect(record.cardinality).toBe(1);
  expect(record.candidates).toHaveLength(100);
  expect(record.candidates.filter((candidate) => candidate.matched)).toEqual([
    expect.objectContaining({ tag: "div", role: "", name: "" }),
  ]);
  expect(record.truncated).toBe(true);
});
it("reports a tree walk cut by its visit bound as truncated", async () => {
  const wrappers = Array.from({ length: 10_100 }, () => new DomElement("div"));
  observeDom(context.page.locator("submit"), [
    ...wrappers,
    new DomElement("button", {}, ["Sign in"]),
  ]);
  expect(await runBrowser(runtime([click]))).toMatchObject({ outcome: "passed" });
  const record = recordedLocator();
  expect(record.candidates).toEqual([]);
  expect(record.truncated).toBe(true);
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
it("caps a step's own timeout at the per-run limit", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const target = context.page.locator("submit");
  target.countValue = 0;
  target.waitFor.mockImplementation(async () => {
    now += 75;
    target.countValue = 1;
  });
  // The saved step carries the project default of 30 s; the run asked for 200 ms at most.
  expect(
    await runBrowser(runtime([{ ...click, timeoutMs: 30_000 }], {}, { stepTimeoutCapMs: 200 })),
  ).toMatchObject({ outcome: "passed" });
  expect(target.click).toHaveBeenCalledWith(expect.objectContaining({ timeout: 125 }));
});
it("never lengthens a step's own timeout to a higher per-run limit", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const target = context.page.locator("submit");
  target.countValue = 0;
  target.waitFor.mockImplementation(async () => {
    now += 75;
    target.countValue = 1;
  });
  expect(
    await runBrowser(runtime([{ ...click, timeoutMs: 200 }], {}, { stepTimeoutCapMs: 60_000 })),
  ).toMatchObject({ outcome: "passed" });
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
it("does not charge the wait for a host model answer to the attempt deadline", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  pageReads(observedPage());
  // The model answers long after the nominal 50 ms attempt deadline.
  const slowModel = exploring({ requireActionable: false });
  slowModel.input.timeoutMs = 50;
  vi.spyOn(slowModel.protocol, "agent").mockImplementation(async () => {
    now += 10_000;
    return null;
  });
  expect(await runBrowser(slowModel)).toMatchObject({ outcome: "passed" });

  // Control: the same time spent on the page itself still expires the attempt deadline.
  events.length = 0;
  const slowPage = exploring({ requireActionable: false });
  slowPage.input.timeoutMs = 50;
  vi.spyOn(slowPage.protocol, "agent").mockResolvedValue(null);
  vi.spyOn(context.page, "evaluate").mockImplementation((async (fn: unknown) => {
    if (fn !== observePage) return "<html>canary</html>";
    now += 10_000;
    return observedPage();
  }) as never);
  expect(await runBrowser(slowPage)).toMatchObject({ reasonCode: "execution_deadline" });
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
it("clicks the second of two identical buttons with nth and never reports ambiguity", async () => {
  context.page.locator("submit").countValue = 2;
  const second: PlanStep = {
    ...click,
    id: "click-second",
    input: { locator: { by: "testId", value: "submit", nth: 1 } },
  };
  expect(await runBrowser(runtime([second]))).toMatchObject({ outcome: "passed" });
  expect(context.page.locator("submit >> nth=1").click).toHaveBeenCalledOnce();
  expect(context.page.locator("submit").click).not.toHaveBeenCalled();
});
it("fails an nth past the last match as a target that never attached", async () => {
  context.page.locator("submit").countValue = 2;
  context.page
    .locator("submit >> nth=2")
    .waitFor.mockRejectedValue(new errors.TimeoutError("Attachment deadline"));
  const third: PlanStep = {
    ...click,
    id: "click-third",
    input: { locator: { by: "testId", value: "submit", nth: 2 } },
  };
  expect(await runBrowser(runtime([third]))).toMatchObject({
    outcome: "failed",
    reasonCode: "assertion_timeout",
  });
  expect(context.page.locator("submit >> nth=2").click).not.toHaveBeenCalled();
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
it.each([
  ["script", "GET"],
  ["xhr", "GET"],
  ["fetch", "POST"],
  ["document", "GET"],
  ["image", "GET"],
  ["eventsource", "GET"],
  ["other", "PUT"],
])(
  "aborts and records a %s %s request to an ignored origin without failing the run",
  async (type, method) => {
    const attempt = runtime([click, assertion]);
    attempt.input.networkPolicy.ignoredOrigins = ["https://js.example.test"];
    const request = routeFor("https://js.example.test/v3/app.js?id=url-canary", type, method);
    requestsOnClick(request);
    expect(await runBrowser(attempt)).toMatchObject({
      outcome: "passed",
      reasonCode: "assertions_satisfied",
    });
    expect(request.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(request.continue).not.toHaveBeenCalled();
    expect(egressEvents()).toEqual([
      {
        stepId: "click",
        origin: "https://js.example.test",
        method,
        resourceType: type,
        disposition: "ignored",
        count: 1,
      },
    ]);
    // Origin only: neither the path nor the query leaves the route handler.
    expect(JSON.stringify(egressEvents())).not.toContain("url-canary");
  },
);
it("counts ignored requests per origin and type and still blocks on an unapproved origin beside them", async () => {
  const attempt = runtime([click, assertion]);
  attempt.input.networkPolicy.ignoredOrigins = ["https://js.example.test"];
  const first = routeFor("https://js.example.test/a.js", "script");
  const second = routeFor("https://js.example.test/b.js", "script");
  const tracker = routeFor("https://tracker.example.test/collect", "fetch");
  requestsOnClick(first, second, tracker);
  expect(await runBrowser(attempt)).toMatchObject({
    outcome: "blocked",
    reasonCode: "egress_denied",
  });
  expect(egressEvents()).toEqual([
    expect.objectContaining({
      origin: "https://js.example.test",
      disposition: "ignored",
      count: 2,
    }),
    expect.objectContaining({ origin: "https://tracker.example.test", disposition: "fatal" }),
  ]);
});
it("never treats an ambiguous URL as an ignored origin", async () => {
  const attempt = runtime([click, assertion]);
  attempt.input.networkPolicy.ignoredOrigins = ["https://js.example.test"];
  const ambiguous = routeFor("https://js.example.test\\@evil.example.test/a.js", "script");
  const credentials = routeFor("https://user:pass@js.example.test/a.js", "script");
  requestsOnClick(ambiguous, credentials);
  expect(await runBrowser(attempt)).toMatchObject({
    outcome: "blocked",
    reasonCode: "egress_denied",
  });
  // The ignore list never covers them: both stay fatal, whatever origin they spell.
  expect(egressEvents()).toEqual([
    expect.objectContaining({ origin: "https://js.example.test", disposition: "fatal", count: 2 }),
  ]);
});
interface SocketDouble {
  url: () => string;
  close: Mock;
  connectToServer: Mock;
}
function socketFor(url: string): SocketDouble {
  return { url: () => url, close: vi.fn(async () => undefined), connectToServer: vi.fn() };
}
/** Fires the WebSocket handler Chromium would call for each page socket while the click step runs. */
function socketsOnClick(...sockets: SocketDouble[]): void {
  context.page.onClick = () => {
    const handler = (context.routeWebSocket.mock.calls as unknown[][])[0]?.[1] as
      | ((socket: SocketDouble) => void)
      | undefined;
    if (!handler) throw new Error("WebSocket handler was not installed");
    for (const socket of sockets) handler(socket);
  };
}
it("connects a same-origin WebSocket to the server and does not deny the run", async () => {
  const secure = socketFor("ws://fixture.test/api/events?token=url-canary");
  socketsOnClick(secure);
  expect(await runBrowser(runtime([click, assertion]))).toMatchObject({
    outcome: "passed",
    reasonCode: "assertions_satisfied",
  });
  expect(secure.connectToServer).toHaveBeenCalledOnce();
  expect(secure.close).not.toHaveBeenCalled();
  expect(egressEvents()).toEqual([]);
});
it("maps wss to https and ws to http, so approving one scheme does not approve the other", async () => {
  const withLiveOrigin = () => {
    const attempt = runtime([click, assertion]);
    attempt.input.networkPolicy.allowedOrigins.push("https://live.example.test");
    attempt.input.networkPolicy.additionalOrigins = ["https://live.example.test"];
    return attempt;
  };
  const approved = socketFor("wss://live.example.test/stream");
  socketsOnClick(approved);
  expect(await runBrowser(withLiveOrigin())).toMatchObject({ outcome: "passed" });
  expect(approved.connectToServer).toHaveBeenCalledOnce();
  context = new ContextStub();
  launch.mockResolvedValue({
    newContext: async () => context,
    close: closeBrowser,
  } as unknown as Browser);
  const plain = socketFor("ws://live.example.test/stream");
  socketsOnClick(plain);
  expect(await runBrowser(withLiveOrigin())).toMatchObject({
    outcome: "blocked",
    reasonCode: "egress_denied",
  });
  expect(plain.connectToServer).not.toHaveBeenCalled();
  expect(egressEvents()).toEqual([
    expect.objectContaining({ origin: "http://live.example.test", resourceType: "websocket" }),
  ]);
});
it("closes a third-party WebSocket, names its origin and blocks the run", async () => {
  const foreign = socketFor("wss://tracker.example.test:8443/collect?id=url-canary");
  socketsOnClick(foreign);
  expect(await runBrowser(runtime([click, assertion]))).toMatchObject({
    outcome: "blocked",
    reasonCode: "egress_denied",
  });
  expect(foreign.connectToServer).not.toHaveBeenCalled();
  expect(foreign.close).toHaveBeenCalledWith(expect.objectContaining({ code: 1008 }));
  expect(egressEvents()).toEqual([
    {
      stepId: "click",
      origin: "https://tracker.example.test:8443",
      method: "GET",
      resourceType: "websocket",
      disposition: "fatal",
      count: 1,
    },
  ]);
  const message = failedStepMessages().find((text) => text.includes("not authorized"));
  expect(message).toContain("https://tracker.example.test:8443 (websocket request)");
  expect(message).not.toContain("url-canary");
});
it("does not blame an authorized origin when the browser cannot connect its WebSocket", async () => {
  const broken = socketFor("ws://fixture.test/api/events");
  broken.connectToServer.mockImplementation(() => {
    throw new Error("Page closed");
  });
  socketsOnClick(broken);
  expect(await runBrowser(runtime([click, assertion]))).toMatchObject({
    outcome: "blocked",
    reasonCode: "egress_denied",
  });
  expect(broken.close).toHaveBeenCalledWith(expect.objectContaining({ code: 1011 }));
  const message = failedStepMessages().find((text) => text.includes("could not connect"));
  expect(message).toContain("authorized origin http://fixture.test");
  expect(egressEvents()).toEqual([]);
});
it("closes an ignored-origin WebSocket with 1008, records it as ignored and does not deny the run", async () => {
  const attempt = runtime([click, assertion]);
  attempt.input.networkPolicy.ignoredOrigins = ["https://js.example.test"];
  const ignored = socketFor("wss://js.example.test/stream?token=url-canary");
  socketsOnClick(ignored);
  expect(await runBrowser(attempt)).toMatchObject({
    outcome: "passed",
    reasonCode: "assertions_satisfied",
  });
  expect(ignored.connectToServer).not.toHaveBeenCalled();
  expect(ignored.close).toHaveBeenCalledWith(expect.objectContaining({ code: 1008 }));
  expect(egressEvents()).toEqual([
    {
      stepId: "click",
      origin: "https://js.example.test",
      method: "GET",
      resourceType: "websocket",
      disposition: "ignored",
      count: 1,
    },
  ]);
  expect(JSON.stringify(egressEvents())).not.toContain("url-canary");
});
const failedStepMessages = () =>
  events.flatMap((event) =>
    event.type === "step.finished" && event.payload.error ? [event.payload.error.message] : [],
  );
it("names the denied origin and resource type, and how to allow the origin, in the failed step", async () => {
  const news = routeFor(
    "https://raw.githubusercontent.com/org/repo/news.json?id=url-canary",
    "fetch",
  );
  requestsOnClick(news);
  expect(await runBrowser(runtime([click, assertion]))).toMatchObject({
    outcome: "blocked",
    reasonCode: "egress_denied",
  });
  const message = failedStepMessages().find((text) => text.includes("not authorized"));
  expect(message).toContain("https://raw.githubusercontent.com (fetch request)");
  expect(message).toContain("--additional-origin https://raw.githubusercontent.com");
  expect(message).not.toContain("url-canary");
});
it("does not blame an authorized origin when the browser fails to forward its request", async () => {
  const attempt = runtime([click, assertion]);
  attempt.input.networkPolicy.allowedOrigins.push("https://cdn.example.test");
  attempt.input.networkPolicy.additionalOrigins = ["https://cdn.example.test"];
  const approved = routeFor("https://cdn.example.test/app.js", "script");
  approved.continue.mockRejectedValue(new Error("Request is already handled"));
  requestsOnClick(approved);
  // Behaviour is unchanged: the attempt still stops as an egress denial.
  expect(await runBrowser(attempt)).toMatchObject({
    outcome: "blocked",
    reasonCode: "egress_denied",
  });
  expect(approved.abort).toHaveBeenCalledWith("blockedbyclient");
  const message = failedStepMessages().find((text) => text.includes("could not forward"));
  expect(message).toContain("authorized origin https://cdn.example.test (script request)");
  expect(failedStepMessages().some((text) => text.includes("origin is not authorized"))).toBe(
    false,
  );
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
it("emits evidence for the longest step ids, a frame child and the longest output name, all publishable as Artifact storage keys", async () => {
  const frameId = "f".repeat(64);
  const childId = "c".repeat(64);
  const downloadId = "d".repeat(64);
  const checkId = "k".repeat(64);
  const outputName = "o".repeat(200);
  const bytes = Buffer.from("approved");
  context.page.locator("frame").frame = new PageStub();
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
  const steps: PlanStep[] = [
    {
      id: frameId,
      kind: "action",
      operation: "frame",
      description: "Enter frame",
      input: {
        locator: { by: "testId", value: "frame" },
        childSteps: [{ ...click, id: childId }],
      },
    },
    {
      id: downloadId,
      kind: "action",
      operation: "download",
      description: "Download",
      input: {
        trigger: { operation: "click", input: { locator: { by: "testId", value: "submit" } } },
        outputName,
      },
    },
    {
      id: checkId,
      kind: "assertion",
      operation: "assert",
      description: "Check download",
      input: { outputName },
      expectation: { predicate: "downloadMatches", outputName, sizeBytes: bytes.length },
    },
  ];
  const attempt = runtime(steps, { allowDownloads: true, allowFrames: true });
  expect(() => validate("ExecutablePlan", attempt.input.plan)).not.toThrow();
  expect(await runBrowser(attempt)).toMatchObject({ outcome: "passed" });
  const paths = artifacts.map((artifact) => artifact.path);
  expect(paths).toContain(`browser/steps/${childId}-locator-0-before.json`);
  expect(paths).toContain(`browser/downloads/${outputName}`);
  // The worker publishes every artifact at runs/<workspace>/<run>/<attempt>/<relativePath>.
  const [workspace, run, att] = [
    "ws_01900000-0000-7000-8000-000000000001",
    "run_01900000-0000-7000-8000-000000000001",
    "att_01900000-0000-7000-8000-000000000001",
  ];
  for (const path of paths)
    expect(() =>
      validate("Artifact", {
        id: "art_01900000-0000-7000-8000-000000000001",
        runId: run,
        attemptId: att,
        revisionId: "rev_01900000-0000-7000-8000-000000000001",
        snapshotId: "snp_01900000-0000-7000-8000-000000000001",
        kind: "log",
        hash: "a".repeat(64),
        bytes: 1,
        mime: "text/plain",
        storageKey: `runs/${workspace}/${run}/${att}/${path}`,
        state: "available",
        redactionStatus: "redacted",
      }),
    ).not.toThrow();
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
it("asserts a disabled control, and fails with the recorded observation when it is enabled", async () => {
  const disabledStep: PlanStep = {
    id: "assert-disabled",
    kind: "assertion",
    operation: "assert",
    description: "Sign in is disabled",
    input: { locator: { by: "testId", value: "sign-in" } },
    expectation: { predicate: "disabled" },
    timeoutMs: 300,
  };
  const plan = runtime([disabledStep]).input.plan;
  expect(() => validate("ExecutablePlan", plan)).not.toThrow();
  const signIn = context.page.locator("sign-in");
  signIn.disabled = true;
  expect(await runBrowser(runtime([disabledStep]))).toMatchObject({ outcome: "passed" });
  signIn.disabled = false;
  events = [];
  expect(await runBrowser(runtime([disabledStep]))).toMatchObject({
    outcome: "failed",
    reasonCode: "assertion_mismatch",
  });
  expect(
    events.findLast(
      (event) => event.type === "step.finished" && event.payload.stepId === "assert-disabled",
    )?.payload,
  ).toMatchObject({ observed: false, expected: true });
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

const inPanel = (value: string) => ({
  by: "testId" as const,
  value,
  container: { by: "testId" as const, value: "panel" },
});
const absenceChecks: [string, PlanStep][] = [
  [
    "a hidden assertion",
    {
      id: "check",
      kind: "assertion",
      operation: "assert",
      description: "Gone",
      input: { locator: inPanel("gone") },
      expectation: { predicate: "hidden" },
      timeoutMs: 300,
    },
  ],
  [
    "a countEquals 0 assertion",
    {
      id: "check",
      kind: "assertion",
      operation: "assert",
      description: "Gone",
      input: { locator: inPanel("gone") },
      expectation: { predicate: "countEquals", value: 0 },
      timeoutMs: 300,
    },
  ],
  [
    "a countAtMost 0 assertion",
    {
      id: "check",
      kind: "assertion",
      operation: "assert",
      description: "Gone",
      input: { locator: inPanel("gone") },
      expectation: { predicate: "countAtMost", value: 0 },
      timeoutMs: 300,
    },
  ],
  ...(["hidden", "detached"] as const).map((state): [string, PlanStep] => [
    `a ${state} wait`,
    {
      id: "check",
      kind: "action",
      operation: "waitFor",
      description: "Wait",
      input: { locator: inPanel("gone"), state, deadlineMs: 300 },
    },
  ]),
];
/** The container never attaches (Playwright times its attachment wait out); the target is absent. */
function absentPanel() {
  const panel = context.page.locator("panel");
  panel.countValue = 0;
  panel.waitFor.mockRejectedValue(new errors.TimeoutError("Container never attached"));
  context.page.locator("panel >> gone").countValue = 0;
  return panel;
}
it.each(absenceChecks)(
  "%s on a target in an absent container passes without waiting for the container",
  async (_name, step) => {
    const panel = absentPanel();
    expect(await runBrowser(runtime([step]))).toMatchObject({ outcome: "passed" });
    expect(panel.waitFor).not.toHaveBeenCalled();
  },
);
it.each(absenceChecks)(
  "%s on a target in an ambiguous container still fails as ambiguous",
  async (_name, step) => {
    context.page.locator("panel").countValue = 2;
    context.page.locator("panel >> gone").countValue = 0;
    expect(await runBrowser(runtime([step]))).toMatchObject({
      outcome: "failed",
      reasonCode: "assertion_mismatch",
    });
  },
);
it.each([
  ["countEquals", 3, [2, 4], [3]],
  ["countAtLeast", 3, [2], [3, 4]],
  ["countAtMost", 3, [4], [2, 3]],
] as const)(
  "a %s %i assertion fails and passes at the boundary of the observed count",
  async (predicate, value, failing, passing) => {
    const rows: PlanStep = {
      id: "check",
      kind: "assertion",
      operation: "assert",
      description: "Rows",
      input: { locator: { by: "testId", value: "rows" } },
      expectation: { predicate, value },
      timeoutMs: 300,
    };
    for (const count of failing) {
      context.page.locator("rows").countValue = count;
      events = [];
      expect(await runBrowser(runtime([rows]))).toMatchObject({
        outcome: "failed",
        reasonCode: "assertion_mismatch",
      });
      expect(
        events.findLast(
          (event) => event.type === "step.finished" && event.payload.stepId === "check",
        )?.payload,
      ).toMatchObject({ observed: count, expected: value });
    }
    for (const count of passing) {
      context.page.locator("rows").countValue = count;
      expect(await runBrowser(runtime([rows]))).toMatchObject({ outcome: "passed" });
    }
  },
);
it("a visible assertion on a target in an absent container fails as an attachment timeout", async () => {
  absentPanel();
  const visible: PlanStep = {
    id: "check",
    kind: "assertion",
    operation: "assert",
    description: "Shown",
    input: { locator: inPanel("gone") },
    expectation: { predicate: "visible" },
    timeoutMs: 300,
  };
  expect(await runBrowser(runtime([visible]))).toMatchObject({
    outcome: "failed",
    reasonCode: "assertion_timeout",
  });
});
it("records locator evidence with cardinality 0 and the page candidates when the container is absent", async () => {
  absentPanel();
  const clickInPanel: PlanStep = {
    id: "click",
    kind: "action",
    operation: "click",
    description: "Click",
    input: { locator: inPanel("gone") },
    timeoutMs: 20,
  };
  expect(await runBrowser(runtime([clickInPanel]))).toMatchObject({
    outcome: "failed",
    reasonCode: "assertion_timeout",
  });
  for (const phase of ["before", "after"]) {
    const artifact = artifacts.find(
      (entry) => entry.path === `browser/steps/click-locator-0-${phase}.json`,
    );
    expect(artifact?.kind).toBe("locator-evidence");
    const record = JSON.parse(artifact!.bytes.toString());
    expect(record.cardinality).toBe(0);
    expect(record.candidates.length).toBeGreaterThan(0);
  }
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
it("passes urlMatches on a URL with any query and on leaving a page, and records a mismatch", async () => {
  waitForURLLikePlaywright();
  const matches = (pattern: string): PlanStep =>
    ({ ...urlCheck("/"), expectation: { predicate: "urlMatches", pattern } }) as PlanStep;
  const finished = () =>
    events.find((event) => event.type === "step.finished" && event.payload.stepId === "url")
      ?.payload as {
      status: string;
      observed: string;
      expected: unknown;
      error?: { message: string };
    };
  context.page.href = "http://fixture.test/login?return_to=%2F";
  events = [];
  expect(await runBrowser(runtime([matches("/login(?:[?#]|$)")]))).toMatchObject({
    outcome: "passed",
  });
  expect(finished()).toMatchObject({
    status: "passed",
    observed: "http://fixture.test/login?return_to=%2F",
    expected: { matches: "/login(?:[?#]|$)" },
  });
  context.page.href = "http://fixture.test/";
  events = [];
  expect(await runBrowser(runtime([matches("^(?!.*/login(?:[?#]|$))")]))).toMatchObject({
    outcome: "passed",
  });
  // Still on the login page: the page did not leave it, so the inequality fails.
  context.page.href = "http://fixture.test/login?error=1";
  events = [];
  expect(await runBrowser(runtime([matches("^(?!.*/login(?:[?#]|$))")]))).toMatchObject({
    outcome: "failed",
    reasonCode: "assertion_mismatch",
  });
  expect(finished()).toMatchObject({
    status: "failed",
    observed: "http://fixture.test/login?error=1",
    expected: { matches: "^(?!.*/login(?:[?#]|$))" },
    error: {
      message:
        "Page URL http://fixture.test/login?error=1 does not match pattern ^(?!.*/login(?:[?#]|$))",
    },
  });
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
function navigateFrameOnClick(url: string): void {
  context.page.onClick = () => context.page.emit("framenavigated", { url: () => url });
}
it("authorizes a frame of an approved additional origin although Playwright appends a URL fragment", async () => {
  const attempt = runtime([click, assertion]);
  attempt.input.networkPolicy.allowedOrigins.push("https://js.example.test");
  attempt.input.networkPolicy.additionalOrigins = ["https://js.example.test"];
  navigateFrameOnClick("https://js.example.test/v3/controller.html#url=https%3A%2F%2Ffixture.test");
  expect(await runBrowser(attempt)).toMatchObject({
    outcome: "passed",
    reasonCode: "assertions_satisfied",
  });
  expect(egressEvents()).toEqual([]);
});
it("keeps about:blank frames out of the egress check and still refuses an unapproved frame origin with a fragment", async () => {
  navigateFrameOnClick("about:blank");
  expect(await runBrowser(runtime([click, assertion]))).toMatchObject({ outcome: "passed" });
  navigateFrameOnClick("https://js.example.test/v3/controller.html#url=1");
  expect(await runBrowser(runtime([click, assertion]))).toMatchObject({
    outcome: "blocked",
    reasonCode: "egress_denied",
  });
});
it("leaves Chromium's error page of an aborted frame out of the egress log", async () => {
  navigateFrameOnClick("chrome-error://chromewebdata/");
  expect(await runBrowser(runtime([click, assertion]))).toMatchObject({ outcome: "passed" });
  expect(egressEvents()).toEqual([]);
});
it("blocks the run when a frame navigates to an unapproved origin, records it and names only the origin", async () => {
  navigateFrameOnClick("https://tracker.example.test/embed?id=url-canary#frag-canary");
  expect(await runBrowser(runtime([click, assertion]))).toMatchObject({
    outcome: "blocked",
    reasonCode: "egress_denied",
  });
  expect(egressEvents()).toEqual([
    expect.objectContaining({
      stepId: "click",
      origin: "https://tracker.example.test",
      resourceType: "document",
      disposition: "fatal",
      count: 1,
    }),
  ]);
  expect(JSON.stringify(egressEvents())).not.toContain("url-canary");
  expect(JSON.stringify(egressEvents())).not.toContain("frag-canary");
  const finished = events.find(
    (event) => event.type === "step.finished" && event.payload.stepId === "click",
  )?.payload as { status: string; reasonCode: string; error?: { message: string } };
  expect(finished).toMatchObject({ status: "blocked", reasonCode: "egress_denied" });
  expect(finished.error?.message).toBe(
    "Frame navigation is not authorized: https://tracker.example.test",
  );
});
it("ends blocked, not inconclusive, when a frame denial lands after the closed-page error already ended the step", async () => {
  const attempt = runtime([click, assertion]);
  context.page
    .locator("submit")
    .click.mockRejectedValue(
      new Error("locator.click: Target page, context or browser has been closed"),
    );
  // The denial arrives while the step result is being reported, after the step was mapped to inconclusive.
  const emit = vi.mocked(attempt.protocol.emit);
  const report = emit.getMockImplementation() as (type: string, payload: unknown) => Promise<void>;
  emit.mockImplementation(async (type: string, payload: unknown) => {
    await report(type, payload);
    if (type === "step.finished")
      context.page.emit("framenavigated", { url: () => "https://tracker.example.test/embed#a" });
  });
  expect(await runBrowser(attempt)).toMatchObject({
    outcome: "blocked",
    reasonCode: "egress_denied",
  });
  expect(
    events.find((event) => event.type === "step.finished" && event.payload.stepId === "click")
      ?.payload,
  ).toMatchObject({ status: "inconclusive", reasonCode: "insufficient_evidence" });
  expect(egressEvents()).toEqual([
    expect.objectContaining({ origin: "https://tracker.example.test", disposition: "fatal" }),
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
