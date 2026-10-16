import type {
  FullConfig,
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";
import { describeFailure } from "./failure.js";
/** The harness owns the authenticated socket; this adapter uses child-process IPC only. */
export default class TestMasterReporter implements Reporter {
  private index = 0;
  private readonly tests = new Map<TestCase, { stepId: string; index: number }>();
  private readonly steps = new Map<TestStep, { stepId: string; index: number }>();
  private pending: Promise<void> = Promise.resolve();
  private testDir = "";
  private send(type: string, payload: unknown): void {
    this.pending = this.pending.then(() => {
      if (!process.send) return Promise.reject(new Error("trusted_harness_ipc_missing"));
      process.send({ type, payload });
      return Promise.resolve();
    });
  }
  onBegin(config: FullConfig): void {
    this.testDir = config.projects[0]?.testDir ?? config.rootDir;
  }
  onError(error: { message?: string; stack?: string }): void {
    this.send("log", {
      level: "error",
      message: (error.stack ?? error.message ?? "Imported test collection failed").slice(0, 8000),
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
    // The first error is the one that ended the test; Playwright lists any later ones after it.
    const failure = passed
      ? undefined
      : describeFailure(result.errors[0], this.testDir, `Test ${result.status}`);
    this.send("step.finished", {
      ...data,
      status: result.status === "skipped" ? "skipped" : passed ? "passed" : "failed",
      ...(passed
        ? {}
        : {
            reasonCode: result.status === "timedOut" ? "assertion_timeout" : "assertion_mismatch",
            ...failure,
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
    const failure = step.error
      ? describeFailure(step.error, this.testDir, "Imported assertion failed")
      : undefined;
    this.send("step.finished", {
      ...data,
      status: failure ? "failed" : "passed",
      ...(failure ? { reasonCode: "assertion_mismatch", ...failure } : {}),
      durationMs: step.duration,
      evidencePaths: [],
    });
  }
  async onEnd(): Promise<void> {
    await this.pending;
  }
}
