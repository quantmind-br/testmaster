import type {
  FullConfig,
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";
import {
  FAILURE_ARTIFACT_EVENT,
  FAILURE_WARNING_ATTACHMENT,
  FAILURE_WARNING_CHARS,
  failureKind,
  vetAttachment,
} from "./code-evidence.js";
import { describeFailure, isAssertionFailure } from "./failure.js";

/** A failure already reported on a step, and whether it was a failed assertion. */
interface NotedFailure {
  message: string;
  assertion: boolean;
}
/**
 * What a failed test or step proves. An assertion that failed, or a test that ran out of time,
 * is a verdict on the target. Any other error was thrown by the test code before an assertion
 * judged anything: the evidence is insufficient, not a mismatch.
 */
function failedVerdict(assertion: boolean, timedOut: boolean) {
  if (timedOut) return { status: "failed", reasonCode: "assertion_timeout" };
  return assertion
    ? { status: "failed", reasonCode: "assertion_mismatch" }
    : { status: "inconclusive", reasonCode: "insufficient_evidence" };
}
/** The harness owns the authenticated socket; this adapter uses child-process IPC only. */
export default class TestMasterReporter implements Reporter {
  private index = 0;
  private readonly tests = new Map<TestCase, { stepId: string; index: number }>();
  private readonly steps = new Map<TestStep, { stepId: string; index: number }>();
  /**
   * Playwright puts a failure on the failing expect and, with the same message, on every
   * `test.step` and the test around it. This remembers the failure of the innermost reported step
   * that failed, per enclosing step and test, so the enclosing ones are not reported as failures of
   * their own and keep its verdict.
   */
  private readonly failedWithin = new Map<TestStep | TestCase, NotedFailure>();
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
  /**
   * Forwards what the shim attached to a failed test about its page: the screenshot and DOM
   * snapshot for the harness to record, and the reason when it could not capture. Anything else
   * the test attached is the test's own and is not read, and an attachment that is not a plain
   * body of the right type is refused with a warning, never read from a path.
   */
  private sendFailureEvidence(stepId: string, attachments: TestResult["attachments"]): void {
    for (const attachment of attachments) {
      if (attachment.name === FAILURE_WARNING_ATTACHMENT) {
        if (Buffer.isBuffer(attachment.body))
          this.send("log", {
            level: "warn",
            message: attachment.body.toString("utf8").slice(0, FAILURE_WARNING_CHARS),
          });
        continue;
      }
      const kind = failureKind(attachment.name);
      if (!kind) continue;
      const vetted = vetAttachment(kind, attachment);
      if ("refused" in vetted)
        this.send("log", {
          level: "warn",
          message: `Failure evidence refused: ${kind} ${vetted.refused}`,
        });
      else this.send(FAILURE_ARTIFACT_EVENT, { stepId, kind, data: vetted.data });
    }
  }
  onTestEnd(test: TestCase, result: TestResult): void {
    const data = this.tests.get(test);
    if (!data) throw new Error("unknown_imported_test");
    const passed = result.status === test.expectedStatus;
    // The first error is the one that ended the test; Playwright lists any later ones after it.
    const first = result.errors[0];
    const recorded = this.failedWithin.get(test);
    // A step that failed with the same message already carries the details.
    const repeat = recorded !== undefined && recorded.message === first?.message;
    // A test that failed with no error at all failed its expectation of failing.
    const assertion =
      first === undefined || (repeat ? recorded.assertion : isAssertionFailure(first));
    if (!passed) this.sendFailureEvidence(data.stepId, result.attachments);
    this.send("step.finished", {
      ...data,
      ...(passed
        ? { status: result.status === "skipped" ? "skipped" : "passed" }
        : {
            ...failedVerdict(assertion, result.status === "timedOut"),
            ...(result.status === "skipped" ? { status: "skipped" } : {}),
            ...(repeat
              ? {}
              : describeFailure(first, this.testDir, `Test ${result.status}`, assertion)),
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
    const error = step.error;
    const recorded = this.failedWithin.get(step);
    // A failure the steps inside this one already reported is not reported again.
    const repeat = recorded !== undefined && recorded.message === error?.message;
    // An expect step is an assertion by construction, whatever its message says.
    const assertion =
      step.category === "expect" || (repeat ? recorded.assertion : isAssertionFailure(error));
    if (error?.message !== undefined && !repeat)
      this.noteFailure(test, step, { message: error.message, assertion });
    const failure =
      error && !repeat
        ? describeFailure(error, this.testDir, "Imported assertion failed", assertion)
        : undefined;
    this.send("step.finished", {
      ...data,
      ...(error ? { ...failedVerdict(assertion, false), ...failure } : { status: "passed" }),
      durationMs: step.duration,
      evidencePaths: [],
    });
  }
  /** Records `failure` as the failure inside every step around `step`, and inside its test. */
  private noteFailure(test: TestCase, step: TestStep, failure: NotedFailure): void {
    for (let outer = step.parent; outer; outer = outer.parent)
      if (!this.failedWithin.has(outer)) this.failedWithin.set(outer, failure);
    if (!this.failedWithin.has(test)) this.failedWithin.set(test, failure);
  }
  async onEnd(): Promise<void> {
    await this.pending;
  }
}
