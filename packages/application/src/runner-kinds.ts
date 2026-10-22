import type { ImageLock } from "@testmaster/sandbox";

/** The fields of a test revision that decide which runner executes it. */
export interface RevisionRunner {
  runnerKind?: unknown;
  plan?: unknown;
  probe?: unknown;
  [field: string]: unknown;
}

/**
 * The runner a revision executes in. A property probe keeps the `probe` runner it shipped with;
 * every other probe kind names itself, so a worker advertises each probe kind it can run.
 */
export function runnerOf(revision: RevisionRunner): string {
  const kind = (revision.probe as { kind?: unknown } | null | undefined)?.kind;
  if (typeof kind === "string" && kind !== "property") return `probe:${kind}`;
  return String(
    revision.runnerKind ?? (revision.plan as { runner?: unknown } | null)?.runner ?? "playwright",
  );
}

/**
 * The aggregate step of a probe Run, named after the probe kind; the runner emits it last, like
 * `imported-code` (ADR-033).
 */
export function probeStepId(revision: RevisionRunner): string {
  const kind = (revision.probe as { kind?: unknown } | null | undefined)?.kind;
  return typeof kind === "string" ? kind : "property";
}

/**
 * The pinned image a runner executes in: pytest code and property probes run in the Python
 * runner, DAST probes in the ZAP runner, everything else in the Node runner (ADR-033).
 */
export function runnerImageOf(runner: string): keyof ImageLock {
  if (runner === "python" || runner === "probe") return "testmaster-runner-python";
  if (runner === "probe:dast") return "testmaster-runner-zap";
  return "testmaster-runner";
}
