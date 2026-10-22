import type { ImageLock } from "@testmaster/sandbox";

/** The aggregate step of a probe Run; the Python runner emits it last, like `imported-code`. */
export const PROBE_STEP_ID = "property";

/**
 * The pinned image a revision's runner kind executes in: pytest code and property probes run in
 * the Python runner (ADR-033), everything else in the Node runner.
 */
export function runnerImageOf(runnerKind: unknown): keyof ImageLock {
  return runnerKind === "python" || runnerKind === "probe"
    ? "testmaster-runner-python"
    : "testmaster-runner";
}
