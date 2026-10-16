import { expect, it, vi } from "vitest";
import TestMasterReporter from "./reporter.js";

it("does not publish failed provisional probes inside a still-running polling oracle", async () => {
  const reporter = new TestMasterReporter();
  const parent = { category: "expect" };
  const step = { category: "expect", parent };
  // The real Docker export control exercises eventual pass and a mutant failure.
  // Here no IPC channel exists: publishing this provisional event would reject onEnd.
  reporter.onStepBegin({} as never, {} as never, step as never);
  reporter.onStepEnd({} as never, {} as never, { ...step, error: { message: "not yet" } } as never);
  await expect(reporter.onEnd()).resolves.toBeUndefined();
});

const matcherMessage = (expected: string, received: string) =>
  `\u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m\u001b[2m).\u001b[22mtoBe\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m) // Object.is equality\u001b[22m\n\nExpected: \u001b[32m${expected}\u001b[39m\nReceived: \u001b[31m${received}\u001b[39m`;
const location = { file: "/tmp/imported/code/health.spec.ts", line: 4, column: 38 };
type Sent = { type: string; payload: Record<string, unknown> };
async function report(run: (reporter: TestMasterReporter) => void): Promise<Sent[]> {
  const sent: Sent[] = [];
  const send = vi.fn((message: Sent) => sent.push(message));
  vi.stubGlobal("process", Object.assign(Object.create(process), { send }));
  try {
    const reporter = new TestMasterReporter();
    reporter.onBegin({ projects: [{ testDir: "/tmp/imported/code" }] } as never, {} as never);
    run(reporter);
    await reporter.onEnd();
  } finally {
    vi.unstubAllGlobals();
  }
  return sent;
}
const failedTest = (errors: unknown[], status = "failed") => ({
  test: { expectedStatus: "passed" },
  result: { status, errors, duration: 12, attachments: [] },
});

it("reports a failed test's message, location, expected and observed values instead of an empty failure", async () => {
  const { test, result } = failedTest([
    { message: matcherMessage("200", "404"), location, stack: "stack" },
  ]);
  const sent = await report((reporter) => {
    reporter.onTestBegin(test as never);
    reporter.onTestEnd(test as never, result as never);
  });
  expect(sent.map((message) => message.type)).toEqual(["step.started", "step.finished"]);
  expect(sent[1]?.payload).toMatchObject({
    stepId: "imported-test-0",
    status: "failed",
    reasonCode: "assertion_mismatch",
    expected: 200,
    observed: 404,
    error: {
      code: "assertion_mismatch",
      message: expect.stringContaining("expect(received).toBe(expected)"),
    },
  });
  const error = sent[1]?.payload.error as { message: string };
  expect(error.message).toContain("Expected: 200");
  expect(error.message).toContain("Received: 404");
  expect(error.message).toMatch(/\n {4}at health\.spec\.ts:4:38$/u);
  expect(error.message).not.toContain("\u001b");
});

it("reports an error the test code threw as inconclusive with its message, not as an assertion mismatch", async () => {
  const { test, result } = failedTest([
    { message: "Error: Cannot complete check_manifest: no schema supplied", location },
  ]);
  const sent = await report((reporter) => {
    reporter.onTestBegin(test as never);
    reporter.onTestEnd(test as never, result as never);
  });
  const payload = sent[1]?.payload ?? {};
  expect(payload).toMatchObject({
    status: "inconclusive",
    reasonCode: "insufficient_evidence",
    error: { code: "Error", message: expect.stringContaining("Cannot complete check_manifest") },
  });
  // The payload is what the harness forwards; its error is `{ code, message }`.
  const error = payload.error as { message: string };
  expect(error.message).toMatch(/\n {4}at health\.spec\.ts:4:38$/u);
  expect(payload).not.toHaveProperty("expected");
  expect(payload).not.toHaveProperty("observed");
});

it("keeps the verdict of the innermost failure on the steps around it", async () => {
  const thrown = { message: "Error: boom", location };
  const test = { expectedStatus: "passed" };
  const result = { status: "failed", errors: [thrown], duration: 12, attachments: [] };
  const outer = { category: "test.step", error: thrown };
  const inner = { category: "test.step", parent: outer, error: thrown };
  const sent = await report((reporter) => {
    reporter.onTestBegin(test as never);
    reporter.onStepBegin(test as never, result as never, outer as never);
    reporter.onStepBegin(test as never, result as never, inner as never);
    reporter.onStepEnd(test as never, result as never, inner as never);
    reporter.onStepEnd(test as never, result as never, outer as never);
    reporter.onTestEnd(test as never, result as never);
  });
  const finished = sent.filter((message) => message.type === "step.finished");
  expect(finished.map((message) => message.payload.reasonCode)).toEqual([
    "insufficient_evidence",
    "insufficient_evidence",
    "insufficient_evidence",
  ]);
  // A failed expect is an assertion whatever message the test gave it.
  const custom = {
    message: "Error: manifest must be served\n\nExpected: 200\nReceived: 500",
    location,
  };
  const expectStep = { category: "expect", error: custom };
  const asserted = await report((reporter) => {
    reporter.onTestBegin(test as never);
    reporter.onStepBegin(test as never, result as never, expectStep as never);
    reporter.onStepEnd(test as never, result as never, expectStep as never);
    reporter.onTestEnd(test as never, { ...result, errors: [custom] } as never);
  });
  expect(asserted[2]?.payload).toMatchObject({
    status: "failed",
    reasonCode: "assertion_mismatch",
    expected: 200,
    observed: 500,
    error: { code: "assertion_mismatch" },
  });
  expect(asserted[3]?.payload).toMatchObject({
    status: "failed",
    reasonCode: "assertion_mismatch",
  });
});

it("reports a timed out test with its error and no invented comparison", async () => {
  const { test, result } = failedTest(
    [{ message: "Error: locator.click: Timeout 5000ms exceeded.", location }],
    "timedOut",
  );
  const sent = await report((reporter) => {
    reporter.onTestBegin(test as never);
    reporter.onTestEnd(test as never, result as never);
  });
  const payload = sent[1]?.payload ?? {};
  expect(payload).toMatchObject({
    status: "failed",
    reasonCode: "assertion_timeout",
    error: { code: "Error", message: expect.stringContaining("Timeout 5000ms exceeded") },
  });
  expect(payload).not.toHaveProperty("expected");
  expect(payload).not.toHaveProperty("observed");
});

it("reports a failed expect step with the same error mapping and a passed test without one", async () => {
  const step = {
    category: "expect",
    error: { message: matcherMessage('"OK"', '"Gone"'), location },
  };
  const passed = { test: { expectedStatus: "passed" }, result: { status: "passed", errors: [] } };
  const sent = await report((reporter) => {
    reporter.onTestBegin(passed.test as never);
    reporter.onStepBegin({} as never, {} as never, step as never);
    reporter.onStepEnd({} as never, {} as never, step as never);
    reporter.onTestEnd(passed.test as never, passed.result as never);
  });
  expect(sent[2]?.payload).toMatchObject({
    stepId: "imported-step-1",
    status: "failed",
    expected: "OK",
    observed: "Gone",
    error: { code: "assertion_mismatch" },
  });
  expect(sent[3]?.payload).toMatchObject({ stepId: "imported-test-0", status: "passed" });
  expect(sent[3]?.payload).not.toHaveProperty("error");
});

it("reports a failure once, on the innermost step, and not again on the test.step and the test around it", async () => {
  const error = { message: matcherMessage("200", "401"), location };
  const test = { expectedStatus: "passed" };
  const result = { status: "failed", errors: [error], duration: 12, attachments: [] };
  const outer = { category: "test.step", error };
  const inner = { category: "expect", parent: outer, error };
  const sent = await report((reporter) => {
    reporter.onTestBegin(test as never);
    reporter.onStepBegin(test as never, result as never, outer as never);
    reporter.onStepBegin(test as never, result as never, inner as never);
    // Playwright ends the inner step first, then the one that encloses it, then the test.
    reporter.onStepEnd(test as never, result as never, inner as never);
    reporter.onStepEnd(test as never, result as never, outer as never);
    reporter.onTestEnd(test as never, result as never);
  });
  const finished = Object.fromEntries(
    sent
      .filter((message) => message.type === "step.finished")
      .map((message) => [message.payload.stepId as string, message.payload]),
  );
  expect(finished["imported-step-2"]).toMatchObject({
    status: "failed",
    expected: 200,
    observed: 401,
    error: { code: "assertion_mismatch" },
  });
  for (const stepId of ["imported-step-1", "imported-test-0"]) {
    expect(finished[stepId]).toMatchObject({ status: "failed", reasonCode: "assertion_mismatch" });
    for (const field of ["error", "expected", "observed"])
      expect(finished[stepId], `${stepId} ${field}`).not.toHaveProperty(field);
  }
  // A different failure on the enclosing step is its own: only an equal message is a repeat.
  const other = { category: "test.step", error: { message: "boom", location } };
  const caught = { category: "expect", parent: other, error };
  const own = await report((reporter) => {
    reporter.onTestBegin(test as never);
    reporter.onStepBegin(test as never, result as never, other as never);
    reporter.onStepBegin(test as never, result as never, caught as never);
    reporter.onStepEnd(test as never, result as never, caught as never);
    reporter.onStepEnd(test as never, result as never, other as never);
  });
  expect(own.at(-1)?.payload).toMatchObject({
    stepId: "imported-step-1",
    error: { message: expect.stringContaining("boom") },
  });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const screenshot = (extra: object = {}) => ({
  name: "testmaster-failure-screenshot",
  contentType: "image/png",
  body: PNG,
  ...extra,
});
const dom = {
  name: "testmaster-failure-dom",
  contentType: "text/html",
  body: Buffer.from("<p>x</p>"),
};
const withAttachments = (status: string, attachments: unknown[]) => {
  const { test, result } = failedTest([{ message: "Error: boom", location }], status);
  return { test, result: { ...result, attachments } };
};

it("forwards the page evidence of a failed test before the step that cites it, and nothing for a passed test", async () => {
  const failed = withAttachments("failed", [screenshot(), dom]);
  const sent = await report((reporter) => {
    reporter.onTestBegin(failed.test as never);
    reporter.onTestEnd(failed.test as never, failed.result as never);
  });
  expect(sent.map((message) => message.type)).toEqual([
    "step.started",
    "failure.artifact",
    "failure.artifact",
    "step.finished",
  ]);
  expect(sent[1]?.payload).toEqual({
    stepId: "imported-test-0",
    kind: "screenshot",
    data: PNG.toString("base64"),
  });
  expect(sent[2]?.payload).toMatchObject({ stepId: "imported-test-0", kind: "dom" });
  // A test that passed (or was skipped) never leaves page evidence, whatever it attached.
  const passed = withAttachments("passed", [screenshot(), dom]);
  const quiet = await report((reporter) => {
    reporter.onTestBegin(passed.test as never);
    reporter.onTestEnd(passed.test as never, passed.result as never);
  });
  expect(quiet.map((message) => message.type)).toEqual(["step.started", "step.finished"]);
});

it("refuses an evidence attachment that points at a file or is not what its name says, with a warning and no artifact", async () => {
  const failed = withAttachments("failed", [
    screenshot({ body: undefined, path: "../../etc/passwd" }),
    screenshot({ body: Buffer.from("not a png") }),
    { ...dom, contentType: "application/octet-stream" },
    { name: "other-attachment", contentType: "text/plain", body: Buffer.from("x") },
  ]);
  const sent = await report((reporter) => {
    reporter.onTestBegin(failed.test as never);
    reporter.onTestEnd(failed.test as never, failed.result as never);
  });
  expect(sent.map((message) => message.type)).toEqual([
    "step.started",
    "log",
    "log",
    "log",
    "step.finished",
  ]);
  expect(sent.slice(1, 4).map((message) => message.payload.level)).toEqual([
    "warn",
    "warn",
    "warn",
  ]);
  expect(JSON.stringify(sent)).not.toContain("etc/passwd");
  // The verdict is the test's own.
  expect(sent[4]?.payload).toMatchObject({ status: "inconclusive" });
});

it("turns the shim's capture warning into a warn log without changing the verdict", async () => {
  const failed = withAttachments("failed", [
    {
      name: "testmaster-failure-warning",
      contentType: "text/plain",
      body: Buffer.from("Page evidence of the failed test is unavailable: closed"),
    },
  ]);
  const sent = await report((reporter) => {
    reporter.onTestBegin(failed.test as never);
    reporter.onTestEnd(failed.test as never, failed.result as never);
  });
  expect(sent[1]).toEqual({
    type: "log",
    payload: { level: "warn", message: "Page evidence of the failed test is unavailable: closed" },
  });
  expect(sent[2]?.payload).toMatchObject({ status: "inconclusive" });
});
