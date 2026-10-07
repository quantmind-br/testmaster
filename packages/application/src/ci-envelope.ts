import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { ContractError, type RunResult, validate } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import { ConfinedRoot } from "@testmaster/evidence";
import { type ReportSnapshot, reportGate } from "@testmaster/reporting";
import type { CiResult } from "./ci.js";
export interface CiEnvelope {
  schemaVersion: "1.0.0";
  result: CiResult;
  report: ReportSnapshot | null;
}
export function byteHash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
export function parseCiEnvelope(value: unknown): CiEnvelope {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["schemaVersion", "result", "report"].includes(key)) ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== "1.0.0" ||
    !("result" in value) ||
    !("report" in value)
  )
    throw new ContractError("INVALID_ARGUMENT", "Invalid CI envelope");
  const result = validate<CiResult>("CiResult", value.result);
  if (!value.report || typeof value.report !== "object" || Array.isArray(value.report)) {
    if (
      value.report !== null ||
      result.kind !== "admission_rejected" ||
      result.gate !== "failed" ||
      result.reportHash !==
        semanticHash({ kind: result.kind, error: result.error, provenance: result.provenance })
    )
      throw new ContractError("INVALID_ARGUMENT", "CI admission envelope is invalid");
    return { schemaVersion: "1.0.0", result, report: null };
  }
  const report = value.report;
  if (
    !("runs" in report) ||
    !Array.isArray(report.runs) ||
    !("selection" in report) ||
    !report.selection ||
    typeof report.selection !== "object" ||
    !("completeness" in report) ||
    !report.completeness ||
    typeof report.completeness !== "object"
  )
    throw new ContractError("INVALID_ARGUMENT", "Malformed CI report");
  if (
    Object.keys(report).some(
      (key) =>
        ![
          "schemaVersion",
          "committedAt",
          "snapshotId",
          "title",
          "runs",
          "batch",
          "coverage",
          "executionMetrics",
          "selection",
          "completeness",
          "provenance",
        ].includes(key),
    ) ||
    !("state" in report.completeness) ||
    !["complete", "partial"].includes(String(report.completeness.state)) ||
    !("notDispatched" in report.selection) ||
    !Array.isArray(report.selection.notDispatched) ||
    !("allowEmpty" in report.selection) ||
    typeof report.selection.allowEmpty !== "boolean"
  )
    throw new ContractError("INVALID_ARGUMENT", "CI report metadata is invalid");
  for (const entry of report.runs) {
    if (!entry || typeof entry !== "object" || !("result" in entry))
      throw new ContractError("INVALID_ARGUMENT", "Malformed CI run");
    validate<RunResult>("RunResult", entry.result);
    if (
      !("run" in entry) ||
      !entry.run ||
      typeof entry.run !== "object" ||
      !("id" in entry.run) ||
      typeof entry.run.id !== "string"
    )
      throw new ContractError("INVALID_ARGUMENT", "CI run identity is invalid");
    if (
      Object.keys(entry).some(
        (key) =>
          ![
            "run",
            "result",
            "title",
            "projectId",
            "environment",
            "evidenceState",
            "snapshot",
            "manifest",
            "evidenceErrors",
            "steps",
            "attempts",
            "durationMs",
            "timings",
            "reproduction",
            "freshness",
            "analysis",
            "privacy",
            "externalEffects",
          ].includes(key),
      )
    )
      throw new ContractError("INVALID_ARGUMENT", "CI run has unknown metadata");
  }
  // JSON was checked structurally above; all verdict-bearing results have contract validation.
  const snapshot = report as ReportSnapshot;
  if (
    semanticHash(snapshot) !== result.reportHash ||
    (result.gate === "passed" && reportGate(snapshot) !== "passed") ||
    (result.kind === "empty" && snapshot.runs.length !== 0)
  )
    throw new ContractError("POLICY_DENIED", "CI verdict or report hash mismatch");
  if (JSON.stringify(snapshot.provenance) !== JSON.stringify(result.provenance))
    throw new ContractError("POLICY_DENIED", "CI report provenance differs from envelope");
  if (
    result.provenance.binding === "verified" &&
    (result.provenance.targetBinding !== "local-checkout" ||
      !result.provenance.assessedSha ||
      !result.provenance.checkoutSha)
  )
    throw new ContractError("POLICY_DENIED", "Verified CI binding lacks local checkout identity");
  if (result.provenance.binding === "verified") {
    if (!snapshot.runs.length)
      throw new ContractError("POLICY_DENIED", "Empty report cannot prove target binding");
    for (const entry of snapshot.runs) {
      const cell = entry.run.matrixCell;
      if (
        !cell ||
        typeof cell !== "object" ||
        Array.isArray(cell) ||
        !("admissionSnapshot" in cell) ||
        !cell.admissionSnapshot ||
        typeof cell.admissionSnapshot !== "object" ||
        Array.isArray(cell.admissionSnapshot) ||
        !("repository" in cell.admissionSnapshot) ||
        !cell.admissionSnapshot.repository ||
        typeof cell.admissionSnapshot.repository !== "object" ||
        Array.isArray(cell.admissionSnapshot.repository)
      )
        throw new ContractError("POLICY_DENIED", "Source binding lacks frozen admission");
      const repository = cell.admissionSnapshot.repository;
      if (
        !("binding" in repository) ||
        repository.binding !== "verified" ||
        !("dirtyHash" in repository) ||
        repository.dirtyHash !== null ||
        !("commitSha" in repository) ||
        repository.commitSha !== result.provenance.assessedSha ||
        !("checkoutSha" in repository) ||
        repository.checkoutSha !== result.provenance.checkoutSha
      )
        throw new ContractError("POLICY_DENIED", "Source binding differs from captured Run");
    }
  }
  if (
    result.kind === "empty" &&
    (!result.selection.emptyReason?.trim() || result.gate !== "not_applicable")
  )
    throw new ContractError("POLICY_DENIED", "Empty coverage cannot approve a gate");
  return { schemaVersion: "1.0.0", result, report: snapshot };
}
export async function validateCiEnvelope(path: string): Promise<CiEnvelope> {
  if (basename(path) !== "report.json")
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Publisher accepts only a completed report.json envelope",
    );
  const root = new ConfinedRoot(dirname(path));
  try {
    const completion = await root.openFile("completion.json");
    let metadata: unknown;
    try {
      metadata = JSON.parse(await completion.readFile("utf8"));
    } finally {
      await completion.close();
    }
    if (
      !metadata ||
      typeof metadata !== "object" ||
      !("schemaVersion" in metadata) ||
      metadata.schemaVersion !== "1.0.0" ||
      !("files" in metadata) ||
      !metadata.files ||
      typeof metadata.files !== "object"
    )
      throw new ContractError("INVALID_ARGUMENT", "CI completion manifest is invalid");
    let content = "";
    for (const name of ["report.json", "junit.xml", "summary.md", "bundle-index.json"]) {
      const file = await root.openFile(name);
      let bytes: string;
      try {
        if ((await file.stat()).size > 32 * 1024 * 1024)
          throw new ContractError("PAYLOAD_TOO_LARGE", "CI report exceeds publisher limit");
        bytes = await file.readFile("utf8");
      } finally {
        await file.close();
      }
      if (!(name in metadata.files) || Reflect.get(metadata.files, name) !== byteHash(bytes))
        throw new ContractError("POLICY_DENIED", "CI export hash mismatch", { file: name });
      if (name === "report.json") content = bytes;
    }
    return parseCiEnvelope(JSON.parse(content));
  } finally {
    root.close();
  }
}
