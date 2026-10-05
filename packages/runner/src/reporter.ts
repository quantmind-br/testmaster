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
  onError(error: { message?: string; stack?: string }): void {
    this.send("log", {
      level: "error",
      message: (error.stack ?? error.message ?? "Imported test collection failed").slice(0, 16384),
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
    // Nested expect probes are provisional (for example expect.poll); only their outer
    // assertion has an oracle verdict after its bounded retry deadline.
    if (step.parent?.category === "expect") return;
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
      ...(step.error
        ? {
            error: {
              code: "assertion_mismatch",
              message: (step.error.message ?? "Imported assertion failed").slice(0, 16384),
            },
          }
        : {}),
      durationMs: step.duration,
      evidencePaths: [],
    });
  }
  async onEnd(): Promise<void> {
    await this.pending;
  }
}
