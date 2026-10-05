import type { ExecutablePlan, NetworkPolicy, PlanStep } from "@testmaster/contracts";
import type { ProtocolClient } from "./protocol.js";

export interface RunnerInput {
  attemptId: string;
  nonce: string;
  baseUrl: string;
  plan?: ExecutablePlan;
  networkPolicy: NetworkPolicy;
  secrets: { secretRef: string; secretVersion: number }[];
  variables?: Record<string, { value: unknown; sensitive: boolean }>;
  artifacts?: Record<string, { path: string; mimeType: string; sizeBytes: number }>;
  schemas?: Record<string, unknown>;
  policy?: {
    popupAliases?: string[];
    allowFrames?: boolean;
    allowUploads?: boolean;
    allowDownloads?: boolean;
    restrictedRaw?: boolean;
    trace?: boolean;
    video?: boolean;
  };
  timeoutMs?: number;
  stepTimeoutMs?: number;
  bodyBytes?: number;
  imported?: { files: string[]; codeRoot?: string };
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
  ) {
    super(message);
  }
}
export class Runtime {
  readonly secrets = new Set<string>();
  readonly variables: Map<string, { value: unknown; sensitive: boolean }>;
  private index = 0;
  private readonly evidence = new Map<string, string[]>();
  private activeStep: string | undefined;
  constructor(
    readonly input: RunnerInput,
    readonly protocol: ProtocolClient,
    readonly signal: AbortSignal = protocol.controller.signal,
  ) {
    this.variables = new Map(Object.entries(input.variables ?? {}));
    for (const entry of this.variables.values())
      if (entry.sensitive) this.secrets.add(String(entry.value));
  }
  emit(type: string, payload: unknown): Promise<void> {
    return this.protocol.emit(type, payload);
  }
  artifact(path: string, kind: string, mimeType: string, bytes: Uint8Array): Promise<void> {
    if (this.activeStep) {
      const paths = this.evidence.get(this.activeStep) ?? [];
      paths.push(path);
      this.evidence.set(this.activeStep, paths);
    }
    const safe =
      mimeType.startsWith("text/") || /json|xml|javascript/u.test(mimeType)
        ? Buffer.from(this.scrub(Buffer.from(bytes).toString("utf8")))
        : bytes;
    return this.protocol.artifact(path, kind, mimeType, safe);
  }
  scrub(text: string): string {
    for (const secret of this.secrets)
      if (secret) {
        text = text.split(secret).join("[REDACTED]");
        text = text.split(encodeURIComponent(secret)).join("[REDACTED]");
      }
    return text;
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
  async runSteps(
    steps: PlanStep[],
    perform: (step: PlanStep) => Promise<void>,
  ): Promise<RunnerResult> {
    let result: RunnerResult = { outcome: "passed", reasonCode: "assertions_satisfied" };
    for (const step of steps) {
      const index = this.index++;
      if (result.outcome !== "passed" || this.signal.aborted) {
        if (this.signal.aborted && result.outcome === "passed")
          result = { outcome: "cancelled", reasonCode: "user_cancelled" };
        await this.emit("step.finished", {
          stepId: step.id,
          index,
          status: "skipped",
          reasonCode: this.signal.aborted ? "cancelled_before_step" : "stopped_after_failure",
          durationMs: 0,
          evidencePaths: [],
        });
        continue;
      }
      await this.emit("step.started", { stepId: step.id, index });
      const previousStep = this.activeStep;
      this.activeStep = step.id;
      const started = performance.now();
      try {
        await perform(step);
        await this.emit("step.finished", {
          stepId: step.id,
          index,
          status: "passed",
          durationMs: Math.round(performance.now() - started),
          evidencePaths: this.evidence.get(step.id) ?? [],
        });
      } catch (error) {
        const reason = this.signal.aborted
          ? "user_cancelled"
          : error instanceof RuntimeError
            ? error.reasonCode
            : step.kind === "assertion"
              ? "assertion_timeout"
              : "insufficient_evidence";
        const outcome = this.signal.aborted
          ? "cancelled"
          : error instanceof RuntimeError
            ? error.outcome
            : step.kind === "assertion"
              ? "failed"
              : "inconclusive";
        await this.emit("step.finished", {
          stepId: step.id,
          index,
          status: outcome,
          reasonCode: reason,
          error: {
            code: error instanceof Error ? error.name : "Error",
            message: this.scrub(error instanceof Error ? error.message : String(error)).slice(
              0,
              8192,
            ),
          },
          durationMs: Math.round(performance.now() - started),
          evidencePaths: this.evidence.get(step.id) ?? [],
        });
        if (step.required !== false) result = { outcome, reasonCode: reason };
      } finally {
        this.activeStep = previousStep;
      }
    }
    return result;
  }
}
