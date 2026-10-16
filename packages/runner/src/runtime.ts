import type { ExecutablePlan, NetworkPolicy, PlanStep } from "@testmaster/contracts";
import {
  AttemptClock,
  type PlanIdentifiers,
  planIdentifiers,
  restorePlanIdentifiers,
  scrubEvidenceText,
  scrubText,
} from "@testmaster/domain";
import type { ProtocolClient } from "./protocol.js";

export interface RunnerInput {
  attemptId: string;
  nonce: string;
  baseUrl: string;
  locale?: string;
  timezone?: string;
  browser?: { viewport?: { width: number; height: number }; testIdAttributes?: string[] };
  plan?: ExecutablePlan;
  networkPolicy: NetworkPolicy;
  secrets: { secretRef: string; secretVersion: number }[];
  variables?: Record<string, { value: unknown; sensitive: boolean }>;
  /** `name` is the fixture file name inside the read-only input bind; used as argv[0] of terminal programs. */
  artifacts?: Record<string, { path: string; mimeType: string; sizeBytes: number; name?: string }>;
  schemas?: Record<string, unknown>;
  policy?: {
    popupAliases?: string[];
    allowFrames?: boolean;
    allowUploads?: boolean;
    allowDownloads?: boolean;
    restrictedRaw?: boolean;
    trace?: boolean;
    video?: boolean;
    httpBodies?: boolean;
  };
  timeoutMs?: number;
  /** Default timeout of a step that declares none (the merged project/profile/run limit). */
  stepTimeoutMs?: number;
  /**
   * Maximum for every step, set only when the run request asked for `limits.stepTimeoutMs`. It
   * shortens a step's own timeout and never lengthens it.
   */
  stepTimeoutCapMs?: number;
  bodyBytes?: number;
  /**
   * `secrets` are the names the code may read through the harness `secrets` fixture. `profile` is set
   * when the code uses the `profileRequest`/`profilePage` fixtures: the run then needs the session of
   * `auth` and is blocked without one.
   */
  imported?: {
    files: string[];
    codeRoot?: string;
    secrets?: { name: string; secretRef: string }[];
    profile?: boolean;
  };
  agent?: {
    resolveSteps: string[];
    exploration?: boolean;
    mutationStepIds: string[];
    maxRequests: number;
    mutationActions?: PlanStep[];
    /**
     * Exploration only. The first observation must offer at least one action (an observed
     * same-origin link or an approved mutation); when it offers none the run is inconclusive
     * (`insufficient_evidence`) instead of passing without having explored anything.
     */
    requireActionable?: boolean;
  };
  /**
   * Dynamic authentication prepared by the host (SEC-022, SEC-024). `storageState` names a vault
   * secret holding a captured browser state; `login` runs vault-referenced steps before the plan
   * and reports the resulting storage state back through the protocol, never through an event.
   * An HTTP run applies the session to requests with `auth: "profile"` only: the cookies of
   * `storageState` that match the request URL and every `credentials` entry (a vault secret sent
   * as `header`, after `prefix` when the secret is a bare token). Imported code with `profile` set
   * receives the same session through its `profileRequest` and `profilePage` fixtures only.
   */
  auth?: {
    storageState?: { secretRef: string };
    login?: { steps: PlanStep[]; captureState: boolean };
    credentials?: { header: string; secretRef: string; prefix?: string }[];
  };
}
export interface RunnerResult {
  outcome: "passed" | "failed" | "blocked" | "cancelled" | "inconclusive";
  reasonCode: string;
  cleanupOutcome?: "not_required" | "passed" | "failed" | "inconclusive";
}
export class RuntimeError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
    readonly outcome: "failed" | "blocked" | "inconclusive" = "blocked",
    /** Low-level cause (e.g. a socket error code) retained as the step error code. */
    readonly diagnosticCode?: string,
  ) {
    super(message);
  }
}
/** A step's timeout: its own (or the default), never above the per-run cap. */
export function stepTimeoutMs(
  step: Pick<PlanStep, "timeoutMs">,
  input: Pick<RunnerInput, "stepTimeoutMs" | "stepTimeoutCapMs">,
): number {
  return Math.min(
    step.timeoutMs ?? input.stepTimeoutMs ?? 30_000,
    input.stepTimeoutCapMs ?? Infinity,
  );
}
/**
 * Browser storage state import is not implemented before M4 (ROADMAP M4-03). Input that
 * carries it is refused as unsupported instead of being ignored, so a run can never look
 * authenticated while silently executing without the requested state.
 */
export function storageStateRefusal(input: RunnerInput): RunnerResult | undefined {
  const present = [input, input.browser, input.policy].some(
    (carrier) =>
      typeof carrier === "object" &&
      carrier !== null &&
      "storageState" in carrier &&
      carrier.storageState !== undefined,
  );
  return present ? { outcome: "blocked", reasonCode: "unsupported_capability" } : undefined;
}
/**
 * What an aborted attempt reports when nothing worse was proven first. The abort reason decides:
 * the attempt deadline is `inconclusive/execution_deadline` (a deadline says nothing about the
 * product), any other abort, a requested cancel included, is `cancelled/user_cancelled`.
 */
export function abortVerdict(signal: AbortSignal): RunnerResult | undefined {
  if (!signal.aborted) return undefined;
  const reason = signal.reason;
  if (reason instanceof Error && reason.message === "attempt_timeout")
    return { outcome: "inconclusive", reasonCode: "execution_deadline" };
  return { outcome: "cancelled", reasonCode: "user_cancelled" };
}
export class Runtime {
  readonly secrets = new Set<string>();
  /** Attempt time: stops while the host resolves a model request, so a slow model never costs deadline. */
  readonly clock = new AttemptClock();
  readonly variables: Map<string, { value: unknown; sensitive: boolean }>;
  private index = 0;
  private readonly evidence = new Map<string, string[]>();
  private readonly comparisons = new Map<string, { observed: unknown; expected: unknown }>();
  private activeStep: string | undefined;
  private readonly identifiers: PlanIdentifiers;
  constructor(
    readonly input: RunnerInput,
    readonly protocol: ProtocolClient,
    readonly signal: AbortSignal = protocol.controller.signal,
  ) {
    this.variables = new Map(Object.entries(input.variables ?? {}));
    for (const entry of this.variables.values())
      if (entry.sensitive) this.secrets.add(String(entry.value));
    this.identifiers = planIdentifiers(input.plan, input.auth, input.agent);
  }
  emit(type: string, payload: unknown): Promise<void> {
    return this.protocol.emit(type, payload);
  }
  /** Asks the host for the next action; the wait for its model answer is outside the attempt deadline. */
  agent(stepId: string, observation: unknown): Promise<PlanStep | null> {
    return this.clock.during(() => this.protocol.agent(stepId, observation));
  }
  artifact(path: string, kind: string, mimeType: string, bytes: Uint8Array): Promise<void> {
    this.reference([path]);
    // A `"stepId"` or `"variableRef"` field names plan text: it stays exact so that consumers
    // (healing matches locator evidence to plan steps) still find the step even when a secret
    // value, such as the user name `root`, occurs inside its id.
    const safe =
      mimeType.startsWith("text/") || /json|xml|javascript/u.test(mimeType)
        ? Buffer.from(
            restorePlanIdentifiers(
              this.scrub(Buffer.from(bytes).toString("utf8")),
              this.identifiers,
              (text) => this.scrub(text),
            ),
          )
        : bytes;
    return this.protocol.artifact(path, kind, mimeType, safe);
  }
  /**
   * Cites artifacts that were already written as evidence of the step running now, so a
   * failed step points at the output it judged even when an earlier step produced it. Callers
   * pass only paths they know exist: the manifest rejects references to unknown artifacts.
   */
  reference(paths: readonly string[]): void {
    if (!this.activeStep) return;
    const cited = this.evidence.get(this.activeStep) ?? [];
    for (const path of paths) if (!cited.includes(path)) cited.push(path);
    this.evidence.set(this.activeStep, cited);
  }
  scrub(text: string): string {
    return scrubEvidenceText(text, [...this.secrets]).text;
  }
  scrubSecrets(text: string): string {
    return scrubText(text, [...this.secrets]).text;
  }
  recordComparison(observed: unknown, expected: unknown): void {
    if (!this.activeStep) return;
    const values = [observed, expected].map((value) => JSON.stringify(value));
    // Omit oversized or secret-derived comparisons rather than storing a truncated value
    // that could support a false diagnosis or expose a sensitive assertion input.
    if (
      values.some(
        (value) =>
          value === undefined || Buffer.byteLength(value) > 8192 || this.scrub(value) !== value,
      )
    )
      return;
    this.comparisons.set(this.activeStep, {
      observed: JSON.parse(values[0]!),
      expected: JSON.parse(values[1]!),
    });
  }
  async resolve(value: unknown): Promise<unknown> {
    if (!value || typeof value !== "object")
      throw new RuntimeError("security_precondition_failed", "Untyped input value");
    if ("literal" in value) return value.literal;
    if ("variableRef" in value) {
      const variable = this.variables.get(String(value.variableRef));
      if (!variable) throw new RuntimeError("upstream_failed", "Variable binding missing");
      if (variable.sensitive) this.secrets.add(String(variable.value));
      return variable.value;
    }
    if ("secretRef" in value) {
      const reference = this.input.secrets.find((ref) => ref.secretRef === value.secretRef);
      if (!reference)
        throw new RuntimeError("missing_secret", "Secret reference absent from snapshot");
      const secret = await this.protocol.secret(reference.secretRef, reference.secretVersion);
      this.secrets.add(secret);
      return secret;
    }
    if ("artifactRef" in value) {
      const artifact = this.input.artifacts?.[String(value.artifactRef)];
      if (!artifact)
        throw new RuntimeError("security_precondition_failed", "Artifact not authorized");
      return artifact.path;
    }
    throw new RuntimeError("security_precondition_failed", "Unknown input value form");
  }
  /**
   * Runs the steps in order. `teardown` flushes what only exists once the run is over (the
   * evidence of sessions nobody waited on). It runs once, while the step after which nothing
   * more executes is still active, so that evidence is attached to the failing step, or to
   * the last step when none failed, instead of belonging to no step.
   */
  async runSteps(
    steps: PlanStep[],
    perform: (step: PlanStep) => Promise<void>,
    teardown?: () => Promise<void>,
  ): Promise<RunnerResult> {
    let result: RunnerResult = { outcome: "passed", reasonCode: "assertions_satisfied" };
    let tornDown = teardown === undefined;
    for (const [position, step] of steps.entries()) {
      const index = this.index++;
      const last = position === steps.length - 1;
      if (result.outcome !== "passed" || this.signal.aborted) {
        const verdict = abortVerdict(this.signal);
        if (verdict && result.outcome === "passed") result = verdict;
        const previousStep = this.activeStep;
        try {
          if (!tornDown) {
            tornDown = true;
            this.activeStep = step.id;
            await teardown?.();
          }
          await this.emit("step.finished", {
            stepId: step.id,
            index,
            status: "skipped",
            reasonCode: this.signal.aborted ? "cancelled_before_step" : "stopped_after_failure",
            durationMs: 0,
            evidencePaths: this.evidence.get(step.id) ?? [],
          });
        } finally {
          this.activeStep = previousStep;
        }
        continue;
      }
      await this.emit("step.started", { stepId: step.id, index });
      const previousStep = this.activeStep;
      this.activeStep = step.id;
      this.comparisons.delete(step.id);
      const started = performance.now();
      try {
        await perform(step);
        const durationMs = Math.round(performance.now() - started);
        if (!tornDown && (last || this.signal.aborted)) {
          tornDown = true;
          await teardown?.();
        }
        // An action that returns normally after the abort (a killed process tree does) was cut
        // short, not completed; an assertion that returned holds a real observation.
        const interrupted = step.kind === "assertion" ? undefined : abortVerdict(this.signal);
        await this.emit("step.finished", {
          stepId: step.id,
          index,
          status: interrupted?.outcome ?? "passed",
          ...(interrupted ? { reasonCode: interrupted.reasonCode } : {}),
          durationMs,
          evidencePaths: this.evidence.get(step.id) ?? [],
          ...this.comparisons.get(step.id),
        });
        if (interrupted && step.required !== false) result = interrupted;
      } catch (error) {
        const verdict = abortVerdict(this.signal);
        const reason = verdict
          ? verdict.reasonCode
          : error instanceof RuntimeError
            ? error.reasonCode
            : step.kind === "assertion"
              ? "assertion_timeout"
              : "insufficient_evidence";
        const outcome = verdict
          ? verdict.outcome
          : error instanceof RuntimeError
            ? error.outcome
            : step.kind === "assertion"
              ? "failed"
              : "inconclusive";
        const durationMs = Math.round(performance.now() - started);
        if (!tornDown && (last || this.signal.aborted || step.required !== false)) {
          tornDown = true;
          await teardown?.();
        }
        await this.emit("step.finished", {
          stepId: step.id,
          index,
          status: outcome,
          reasonCode: reason,
          error: {
            code:
              error instanceof RuntimeError && error.diagnosticCode
                ? error.diagnosticCode
                : error instanceof Error
                  ? error.name
                  : "Error",
            message: this.scrub(error instanceof Error ? error.message : String(error)).slice(
              0,
              8000,
            ),
          },
          durationMs,
          evidencePaths: this.evidence.get(step.id) ?? [],
          ...this.comparisons.get(step.id),
        });
        if (step.required !== false) result = { outcome, reasonCode: reason };
      } finally {
        this.activeStep = previousStep;
      }
    }
    return result;
  }
}
