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
  /**
   * Playwright puts a failure on the failing expect and, with the same message, on every
   * `test.step` and the test around it. This remembers the message of the innermost reported step
   * that failed, per enclosing step and test, so the enclosing ones are not reported as failures of
   * their own.
   */
  private readonly failedWithin = new Map<TestStep | TestCase, string>();
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
    const first = result.errors[0];
    const failure = passed
      ? undefined
      : describeFailure(first, this.testDir, `Test ${result.status}`);
    // A step that failed with the same message already carries the details.
    const detailed = first?.message === undefined || this.failedWithin.get(test) !== first.message;
    this.send("step.finished", {
      ...data,
      status: result.status === "skipped" ? "skipped" : passed ? "passed" : "failed",
      ...(passed
        ? {}
        : {
            reasonCode: result.status === "timedOut" ? "assertion_timeout" : "assertion_mismatch",
            ...(detailed ? failure : {}),
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
  onStepEnd(test: TestCase, _result: TestResult, step: TestStep): void {
    const data = this.steps.get(step);
    if (!data) return;
    const message = step.error?.message;
    const detailed = message === undefined || this.failedWithin.get(step) !== message;
    const failure =
      step.error && detailed
        ? describeFailure(step.error, this.testDir, "Imported assertion failed")
        : undefined;
    if (message !== undefined && detailed) this.noteFailure(test, step, message);
    this.send("step.finished", {
      ...data,
      status: step.error ? "failed" : "passed",
      ...(step.error ? { reasonCode: "assertion_mismatch", ...failure } : {}),
      durationMs: step.duration,
      evidencePaths: [],
    });
  }
  /** Records `message` as the failure inside every step around `step`, and inside its test. */
  private noteFailure(test: TestCase, step: TestStep, message: string): void {
    for (let outer = step.parent; outer; outer = outer.parent)
      if (!this.failedWithin.has(outer)) this.failedWithin.set(outer, message);
    if (!this.failedWithin.has(test)) this.failedWithin.set(test, message);
  }
  async onEnd(): Promise<void> {
    await this.pending;
  }
}
