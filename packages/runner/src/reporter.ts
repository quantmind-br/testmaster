import type { Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";
/** The harness owns the authenticated socket; this adapter uses child-process IPC only. */
export default class TestMasterReporter implements Reporter {
  private index = 0;
  private readonly tests = new Map<TestCase, { stepId: string; index: number }>();
  private readonly steps = new Map<TestStep, { stepId: string; index: number }>();
  private pending: Promise<void> = Promise.resolve();
  private send(type: string, payload: unknown): void {
    this.pending = this.pending.then(() => {
      if (!process.send) return Promise.reject(new Error("trusted_harness_ipc_missing"));
      process.send({ type, payload });
      return Promise.resolve();
    });
  }
  onTestBegin(test: TestCase): void {
    const index = this.index++;
    const data = { stepId: `imported-test-${index}`, index };
    this.tests.set(test, data);
    this.send("step.started", data);
  }
  onTestEnd(test: TestCase, result: TestResult): void {
    const data = this.tests.get(test);
    if (!data) throw new Error("unknown_imported_test");
    const passed = result.status === test.expectedStatus;
    this.send("step.finished", {
      ...data,
      status: result.status === "skipped" ? "skipped" : passed ? "passed" : "failed",
      ...(passed
        ? {}
        : {
            reasonCode: result.status === "timedOut" ? "assertion_timeout" : "assertion_mismatch",
          }),
      durationMs: result.duration,
      evidencePaths: [],
    });
  }
  onStepBegin(_test: TestCase, _result: TestResult, step: TestStep): void {
    if (step.category !== "test.step" && step.category !== "expect") return;
    const index = this.index++;
    const data = { stepId: `imported-step-${index}`, index };
    this.steps.set(step, data);
    this.send("step.started", data);
  }
  onStepEnd(_test: TestCase, _result: TestResult, step: TestStep): void {
    const data = this.steps.get(step);
    if (!data) return;
    this.send("step.finished", {
      ...data,
      status: step.error ? "failed" : "passed",
      ...(step.error ? { reasonCode: "assertion_mismatch" } : {}),
      durationMs: step.duration,
      evidencePaths: [],
    });
  }
  async onEnd(): Promise<void> {
    await this.pending;
  }
}
