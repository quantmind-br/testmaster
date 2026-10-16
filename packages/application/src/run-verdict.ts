import type { RunResult } from "@testmaster/contracts";
import { environmentSecretValues, scrubEvidenceText } from "@testmaster/domain";

export type RunExecutionError = NonNullable<RunResult["executionError"]>;

export interface RunVerdict {
  reasonCode?: string;
  unavailableEvidence?: NonNullable<RunResult["unavailableEvidence"]>;
  executionError?: RunExecutionError;
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const MAX_ISSUES = 10;

/** One bounded, single-line, scrubbed string; `undefined` when nothing is left. */
function bounded(value: unknown, secrets: readonly string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = scrubEvidenceText(value.replace(/\s+/gu, " ").trim(), secrets).text.slice(0, 200);
  return text || undefined;
}

/**
 * The error recorded by a `run.execution_error` event payload, bounded and scrubbed: the error
 * code, its message, the reason code and the paths of the validation issues. Never the raw
 * `details`, which can carry values.
 */
export function readExecutionError(payload: unknown): RunExecutionError {
  const record = asObject(payload);
  const secrets = environmentSecretValues();
  const rawIssues = asObject(record.details).issues;
  const issues = (Array.isArray(rawIssues) ? rawIssues : []).slice(0, MAX_ISSUES).map((raw) => {
    const issue = asObject(raw);
    const rule = bounded(issue.rule, secrets);
    const message = bounded(issue.message, secrets);
    return {
      path: bounded(issue.path, secrets) ?? "/",
      ...(rule ? { rule } : {}),
      ...(message ? { message } : {}),
    };
  });
  const message = bounded(record.message, secrets);
  const reasonCode = bounded(record.reasonCode, secrets);
  return {
    code: bounded(record.error, secrets) ?? "INTERNAL",
    ...(message ? { message } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    issues,
  };
}

/** The execution error a finished Run recorded after its steps, if any. */
export function runExecutionError(
  events: readonly Record<string, unknown>[],
): RunExecutionError | undefined {
  const event = events.findLast((candidate) => candidate.type === "run.execution_error");
  return event ? readExecutionError(event.payload) : undefined;
}

/** One line naming the error: `CODE "message" (path rule, ...); reason code`. */
export function describeExecutionError(error: RunExecutionError): string {
  const issues = error.issues
    .slice(0, 5)
    .map((issue) => (issue.rule ? `${issue.path} ${issue.rule}` : issue.path))
    .join(", ");
  const more = error.issues.length > 5 ? `, and ${error.issues.length - 5} more` : "";
  return `${error.code}${error.message ? ` "${error.message}"` : ""}${issues ? ` (${issues}${more})` : ""}${error.reasonCode ? `; reason ${error.reasonCode}` : ""}`;
}

/**
 * The reason a finished Run carries and, when its gate failed on evidence, the manifest entries
 * that were unavailable. One reading for the CLI, MCP and reports, so a run whose assertions
 * passed but whose gate failed never presents as a bare pass. A Run that recorded an execution
 * error (for example, evidence that could not be published) carries that error too.
 */
export function runVerdict(
  run: { outcome?: unknown },
  events: readonly Record<string, unknown>[],
): RunVerdict {
  const reduced = asObject(events.findLast((event) => event.type === "run.reduced")?.payload);
  // A Run refused at admission is never reduced; its completion event carries the reason.
  const completed = asObject(events.findLast((event) => event.type === "run.completed")?.payload);
  const executionError = runExecutionError(events);
  const reasonCode =
    reduced.reasonCode ??
    (run.outcome === "blocked" || executionError ? completed.reasonCode : undefined);
  return {
    ...(typeof reasonCode === "string" ? { reasonCode } : {}),
    ...(Array.isArray(reduced.unavailableEvidence) && reduced.unavailableEvidence.length
      ? { unavailableEvidence: reduced.unavailableEvidence as RunVerdict["unavailableEvidence"] }
      : {}),
    ...(executionError ? { executionError } : {}),
  } as RunVerdict;
}
