import type {
  ArtifactManifest,
  Attempt,
  BatchRun,
  BundleMeta,
  Run,
  RunResult,
  StepResult,
} from "@testmaster/contracts";

export interface ReportRun {
  run: Pick<
    Run,
    "id" | "workspaceId" | "testId" | "revisionId" | "environmentRevisionId" | "mode" | "matrixCell"
  >;
  result: RunResult;
  title: string;
  projectId: string;
  environment: string;
  snapshot: BundleMeta;
  manifest: ArtifactManifest;
  steps: readonly StepResult[];
  attempts: readonly Attempt[];
  durationMs: number;
  /** Read-time context comparison; never modifies the committed verdict or evidence seal. */
  freshness?: {
    state: "current" | "stale";
    reasons: readonly ("test_revision_changed" | "environment_revision_changed")[];
    currentRevisionId: string;
    currentEnvironmentRevisionId: string;
  };
}
export interface ReportSnapshot {
  schemaVersion: "1.0.0";
  committedAt: string;
  snapshotId: string;
  title: string;
  runs: readonly ReportRun[];
  batch?: BatchRun;
  selection: {
    requested: number;
    notDispatched: readonly { memberKey: string; reasonCode: string }[];
    excluded: readonly { memberKey: string; reasonCode: string }[];
    allowEmpty: boolean;
    emptyReason?: string;
  };
  completeness: { state: "complete" | "partial"; reasons: readonly string[] };
}
export type ReportGate = "passed" | "failed" | "pending" | "not_applicable";
export function reportGate(snapshot: ReportSnapshot): ReportGate {
  if (!snapshot.runs.length)
    return snapshot.selection.allowEmpty && snapshot.selection.emptyReason
      ? "not_applicable"
      : "failed";
  if (
    snapshot.completeness.state !== "complete" ||
    snapshot.selection.notDispatched.length ||
    snapshot.runs.some((run) => run.result.gate === "failed")
  )
    return "failed";
  if (
    snapshot.runs.some((run) => run.result.phase !== "completed" || run.result.gate === "pending")
  )
    return "pending";
  if (snapshot.runs.some((run) => run.result.gate !== "passed")) return "failed";
  return "passed";
}
function xml(text: unknown): string {
  const safe = [...String(text)]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff)
        ? character
        : "\ufffd";
    })
    .join("");
  return safe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
function markdown(text: unknown): string {
  return xml(text)
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&")
    .replace(/\r?\n/g, " ");
}
function validateSnapshot(snapshot: ReportSnapshot): void {
  const seen = new Set<string>();
  for (const item of snapshot.runs) {
    if (seen.has(item.run.id)) throw new Error("Duplicate report Run");
    seen.add(item.run.id);
    if (
      item.result.runId !== item.run.id ||
      item.snapshot.runId !== item.run.id ||
      item.manifest.runId !== item.run.id ||
      item.snapshot.revisionId !== item.run.revisionId ||
      item.manifest.revisionId !== item.run.revisionId ||
      item.manifest.snapshotId !== item.snapshot.snapshotId ||
      item.manifest.attemptId !== item.snapshot.attemptId
    )
      throw new Error("Report snapshot binding mismatch");
    if (
      item.snapshot.workspaceId !== item.run.workspaceId ||
      item.manifest.workspaceId !== item.run.workspaceId
    )
      throw new Error("Report workspace binding mismatch");
    if (!Number.isFinite(item.durationMs) || item.durationMs < 0)
      throw new Error("Invalid report duration");
  }
  if (snapshot.selection.requested < snapshot.runs.length + snapshot.selection.notDispatched.length)
    throw new Error("Invalid selection counts");
}
function missing(item: ReportRun): string[] {
  return item.manifest.entries
    .filter((entry) => entry.state !== "available")
    .map(
      (entry) =>
        `${entry.relativePath}: ${entry.state} (${entry.omissionReason ?? "reason unavailable"})`,
    );
}
export function exportJson(snapshot: ReportSnapshot): string {
  validateSnapshot(snapshot);
  return JSON.stringify({ ...snapshot, gate: reportGate(snapshot) }, null, 2);
}
export function exportMarkdown(snapshot: ReportSnapshot): string {
  validateSnapshot(snapshot);
  const lines = [
    `# ${markdown(snapshot.title)}`,
    ``,
    `Gate: **${reportGate(snapshot)}**`,
    `Snapshot: ${markdown(snapshot.snapshotId)}`,
    `Completeness: ${snapshot.completeness.state}`,
    `Selection: ${snapshot.selection.requested}; not dispatched: ${snapshot.selection.notDispatched.length}; excluded: ${snapshot.selection.excluded.length}`,
    ...snapshot.completeness.reasons.map((reason) => `- Incomplete: ${markdown(reason)}`),
  ];
  if (!snapshot.runs.length)
    lines.push(
      `No tests executed: ${markdown(snapshot.selection.emptyReason ?? "selection empty without authorization")}`,
    );
  for (const item of snapshot.runs)
    lines.push(
      ``,
      `## ${markdown(item.title)}`,
      `Run: ${markdown(item.run.id)}; revision: ${markdown(item.run.revisionId)}; environment: ${markdown(item.environment)}`,
      `Outcome: ${item.result.outcome ?? "nonterminal"}; gate: ${item.result.gate}; cleanup: ${item.result.cleanupOutcome}`,
      `First attempt: ${item.result.firstAttemptOutcome ?? "unknown"}; passed on retry: ${item.result.passedOnRetry}`,
      ...(item.freshness
        ? [
            `Context: ${item.freshness.state}${item.freshness.reasons.length ? ` (${item.freshness.reasons.join(", ")})` : ""}`,
          ]
        : []),
      ...missing(item).map((reason) => `- Evidence: ${markdown(reason)}`),
    );
  for (const cell of snapshot.selection.notDispatched)
    lines.push(`- Not dispatched: ${markdown(cell.memberKey)} (${markdown(cell.reasonCode)})`);
  for (const cell of snapshot.selection.excluded)
    lines.push(`- Excluded: ${markdown(cell.memberKey)} (${markdown(cell.reasonCode)})`);
  return `${lines.join("\n")}\n`;
}
export function exportHtml(snapshot: ReportSnapshot): string {
  validateSnapshot(snapshot);
  const runs = snapshot.runs
    .map(
      (item) =>
        `<section><h2>${xml(item.title)}</h2><dl><dt>Run</dt><dd>${xml(item.run.id)}</dd><dt>Revision</dt><dd>${xml(item.run.revisionId)}</dd><dt>Environment</dt><dd>${xml(item.environment)}</dd><dt>Outcome</dt><dd>${xml(item.result.outcome ?? "nonterminal")}</dd><dt>Gate</dt><dd>${xml(item.result.gate)}</dd><dt>Cleanup</dt><dd>${xml(item.result.cleanupOutcome)}</dd><dt>First attempt</dt><dd>${xml(item.result.firstAttemptOutcome ?? "unknown")}</dd><dt>Passed on retry</dt><dd>${item.result.passedOnRetry}</dd></dl><ul>${missing(
          item,
        )
          .map((reason) => `<li>Evidence: ${xml(reason)}</li>`)
          .join(
            "",
          )}${item.freshness ? `<li>Context: ${xml(item.freshness.state)}${item.freshness.reasons.length ? ` (${xml(item.freshness.reasons.join(", "))})` : ""}</li>` : ""}</ul></section>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"><title>${xml(snapshot.title)}</title></head><body><h1>${xml(snapshot.title)}</h1><p>Gate: ${reportGate(snapshot)}</p><p>Snapshot: ${xml(snapshot.snapshotId)}; completeness: ${snapshot.completeness.state}</p><p>Selection: ${snapshot.selection.requested}; not dispatched: ${snapshot.selection.notDispatched.length}; excluded: ${snapshot.selection.excluded.length}</p>${snapshot.runs.length ? runs : `<p>No tests executed: ${xml(snapshot.selection.emptyReason ?? "selection empty without authorization")}</p>`}<ul>${[...snapshot.completeness.reasons, ...snapshot.selection.notDispatched.map((cell) => `Not dispatched: ${cell.memberKey}: ${cell.reasonCode}`), ...snapshot.selection.excluded.map((cell) => `Excluded: ${cell.memberKey}: ${cell.reasonCode}`)].map((reason) => `<li>${xml(reason)}</li>`).join("")}</ul></body></html>`;
}
function junitKind(item: ReportRun): "failure" | "error" | "skipped" | null {
  if (item.result.outcome === "failed") return "failure";
  if (item.result.outcome === "cancelled") return "skipped";
  if (
    item.result.phase !== "completed" ||
    item.result.outcome !== "passed" ||
    item.result.gate !== "passed"
  )
    return "error";
  return null;
}
export function exportJunit(snapshot: ReportSnapshot): string {
  validateSnapshot(snapshot);
  const kinds = snapshot.runs.map(junitKind);
  const syntheticError =
    !snapshot.runs.length ||
    snapshot.completeness.state !== "complete" ||
    snapshot.selection.notDispatched.length > 0;
  const counts = {
    failure: kinds.filter((kind) => kind === "failure").length,
    error: kinds.filter((kind) => kind === "error").length + Number(syntheticError),
    skipped: kinds.filter((kind) => kind === "skipped").length,
  };
  const cases = snapshot.runs.map((item) => {
    const kind = junitKind(item);
    const properties: Record<string, unknown> = {
      runId: item.run.id,
      revisionId: item.run.revisionId,
      environment: item.environment,
      mode: item.run.mode,
      snapshot: item.snapshot.snapshotId,
      attemptId: item.snapshot.attemptId,
      outcome: item.result.outcome ?? "nonterminal",
      businessOutcome: item.result.outcome ?? "nonterminal",
      firstAttemptOutcome: item.result.firstAttemptOutcome ?? "unknown",
      passedOnRetry: item.result.passedOnRetry,
      cleanupOutcome: item.result.cleanupOutcome,
      gate: item.result.gate,
    };
    const reason =
      item.result.outcome === "passed" && item.result.cleanupOutcome === "failed"
        ? "cleanup_failed"
        : (item.result.reasonCode ??
          (item.result.phase !== "completed"
            ? "partial_result"
            : item.result.gate !== "passed"
              ? "gate_failed"
              : item.result.outcome));
    return `<testcase name="${xml(item.title)}" classname="${xml(`${item.projectId}.${item.run.testId}`)}" time="${item.durationMs / 1000}"><properties>${Object.entries(
      properties,
    )
      .map(([name, value]) => `<property name="${xml(name)}" value="${xml(value)}"/>`)
      .join(
        "",
      )}</properties>${kind ? `<${kind} type="${xml(reason)}" message="${xml(reason)}">${xml(missing(item).join("\n"))}</${kind}>` : ""}<system-out>${xml(JSON.stringify({ steps: item.steps, evidence: missing(item) }).slice(0, 1024 * 1024))}</system-out></testcase>`;
  });
  if (syntheticError)
    cases.push(
      `<testcase name="Selection/completeness" classname="testmaster.selection"><error type="incomplete_selection" message="${xml(snapshot.selection.emptyReason ?? "No complete nonempty selection")}">${xml(JSON.stringify({ notDispatched: snapshot.selection.notDispatched, reasons: snapshot.completeness.reasons }))}</error></testcase>`,
    );
  return `<?xml version="1.0" encoding="UTF-8"?><testsuites><testsuite name="${xml(snapshot.title)}" tests="${cases.length}" failures="${counts.failure}" errors="${counts.error}" skipped="${counts.skipped}" time="${snapshot.runs.reduce((sum, item) => sum + item.durationMs, 0) / 1000}"><properties><property name="gate" value="${reportGate(snapshot)}"/><property name="snapshot" value="${xml(snapshot.snapshotId)}"/><property name="excluded" value="${snapshot.selection.excluded.length}"/></properties>${cases.join("")}</testsuite></testsuites>`;
}
export function exportAllure(snapshot: ReportSnapshot): Record<string, string> {
  validateSnapshot(snapshot);
  const files: Record<string, string> = {};
  for (const item of snapshot.runs) {
    const kind = junitKind(item);
    const status =
      kind === "failure"
        ? "failed"
        : kind === "error"
          ? "broken"
          : kind === "skipped"
            ? "skipped"
            : "passed";
    files[`${item.run.id}-result.json`] = JSON.stringify({
      uuid: item.run.id,
      historyId: `${item.projectId}.${item.run.testId}.${JSON.stringify(item.run.matrixCell)}`,
      name: item.title,
      fullName: `${item.projectId}.${item.run.testId}`,
      status,
      stage: item.result.phase === "completed" ? "finished" : "interrupted",
      statusDetails: {
        message: item.result.reasonCode ?? item.result.cleanupOutcome,
        trace: missing(item).join("\n"),
      },
      labels: [
        { name: "suite", value: snapshot.title },
        { name: "testmaster.gate", value: item.result.gate },
      ],
      parameters: [
        { name: "revisionId", value: item.run.revisionId },
        { name: "snapshot", value: item.snapshot.snapshotId },
        { name: "environment", value: item.environment },
        { name: "mode", value: item.run.mode },
        { name: "businessOutcome", value: item.result.outcome },
        { name: "firstAttemptOutcome", value: item.result.firstAttemptOutcome },
        { name: "passedOnRetry", value: String(item.result.passedOnRetry) },
      ],
      steps: item.steps.map((step) => ({
        name: step.planStepId,
        status:
          step.status === "passed" ? "passed" : step.status === "failed" ? "failed" : "broken",
        stage: "finished",
        statusDetails: { message: step.reasonCode ?? "" },
      })),
    });
  }
  if (
    !snapshot.runs.length ||
    snapshot.selection.notDispatched.length ||
    snapshot.completeness.state !== "complete"
  )
    files["selection-result.json"] = JSON.stringify({
      uuid: snapshot.snapshotId,
      name: "Selection/completeness",
      status: "broken",
      stage: "finished",
      statusDetails: { message: snapshot.selection.emptyReason ?? "Incomplete selection" },
    });
  files["testmaster-summary.json"] = exportJson(snapshot);
  return files;
}
