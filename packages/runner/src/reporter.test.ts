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
  result: { status, errors, duration: 12 },
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
