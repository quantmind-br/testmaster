import type {
  FullConfig,
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";
import { EGRESS_ATTACHMENT, parseEgressAttachment } from "./code-egress.js";
import {
  FAILURE_ARTIFACT_EVENT,
  FAILURE_WARNING_ATTACHMENT,
  FAILURE_WARNING_CHARS,
  failureKind,
  vetAttachment,
} from "./code-evidence.js";
import {
  describeFailure,
  isAssertionFailure,
  isStrictViolation,
  isTestTimeout,
  isTimeoutFailure,
  locatorTimeout,
  type PlaywrightFailure,
} from "./failure.js";

/** A failure already reported on a step, and whether it was a failed assertion. */
interface NotedFailure {
  message: string;
  assertion: boolean;
}
/**
 * What a failed test or step proves, the same whether the failure ends the test body or a
 * `test.step` around it. A failed assertion, a test that ran out of time and a locator action
 * that hit a strict mode violation (the locator matched several elements) or timed out without
 * ever matching an element are verdicts on the target, like the plan runner's ambiguous and
 * never-attached locators. A locator action that matched an element but did not complete (not
 * enabled, covered) and any other error the test code threw before an assertion judged anything
 * leave the evidence insufficient, not a mismatch.
 */
function failedVerdict(
  assertion: boolean,
  failure: PlaywrightFailure | undefined,
  testTimedOut = false,
) {
  if (testTimedOut || isTestTimeout(failure) || (assertion && isTimeoutFailure(failure)))
    return { status: "failed", reasonCode: "assertion_timeout" };
  if (assertion || isStrictViolation(failure))
    return { status: "failed", reasonCode: "assertion_mismatch" };
  if (locatorTimeout(failure) === "never_attached")
    return { status: "failed", reasonCode: "assertion_timeout" };
  return { status: "inconclusive", reasonCode: "insufficient_evidence" };
}
/** Longest title a step or test carries on the wire; the Python runner cuts at the same length. */
const STEP_TITLE_CHARS = 500;
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
    const data = {
      stepId: `imported-test-${index}`,
      index,
      title: test.title.slice(0, STEP_TITLE_CHARS),
    };
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
  /**
   * Forwards the requests the shim's route hook denied in the test's browser contexts as
   * `egress.denied` events, whether or not the test passed. An attachment that is not a plain,
   * bounded list of well-formed denials is refused with a warning and never read from a path.
   */
  private sendEgressDenials(
    stepId: string,
    attachments: TestResult["attachments"] | undefined,
  ): void {
    for (const attachment of attachments ?? []) {
      if (attachment.name !== EGRESS_ATTACHMENT) continue;
      const parsed = parseEgressAttachment(stepId, attachment);
      if ("refused" in parsed)
        this.send("log", {
          level: "warn",
          message: `Egress denials refused: ${parsed.refused}`,
        });
      else for (const denial of parsed.denials) this.send("egress.denied", denial);
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
    this.sendEgressDenials(data.stepId, result.attachments);
    this.send("step.finished", {
      ...data,
      ...(passed
        ? { status: result.status === "skipped" ? "skipped" : "passed" }
        : {
            ...failedVerdict(assertion, first, result.status === "timedOut"),
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
    const data = {
      stepId: `imported-step-${index}`,
      index,
      title: step.title.slice(0, STEP_TITLE_CHARS),
    };
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
      ...(error ? { ...failedVerdict(assertion, error), ...failure } : { status: "passed" }),
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
