import { uuidV7IdGenerator } from "@testmaster/domain";
import { XMLValidator } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import {
  exportAllure,
  exportHtml,
  exportJson,
  exportJunit,
  exportMarkdown,
  type ReportSnapshot,
  reportGate,
} from "./index.js";

function snapshot(empty = false): ReportSnapshot {
  const runId = uuidV7IdGenerator.next("run"),
    revisionId = uuidV7IdGenerator.next("rev"),
    attemptId = uuidV7IdGenerator.next("att"),
    snapshotId = uuidV7IdGenerator.next("snp"),
    workspaceId = uuidV7IdGenerator.next("ws");
  return {
    schemaVersion: "1.0.0",
    committedAt: new Date().toISOString(),
    snapshotId,
    title: "Hostile <script>alert(1)</script> ]]> \u0000",
    runs: empty
      ? []
      : [
          {
            run: {
              id: runId,
              workspaceId,
              testId: uuidV7IdGenerator.next("tst"),
              revisionId,
              environmentRevisionId: uuidV7IdGenerator.next("evr"),
              mode: "replay",
              matrixCell: {},
            },
            result: {
              runId,
              phase: "completed",
              status: "passed",
              outcome: "passed",
              gate: "failed",
              cleanupOutcome: "failed",
              analysisStatus: "not_requested",
              firstAttemptOutcome: "passed",
              passedOnRetry: false,
            },
            title: '<script> ]]>&" \u0001',
            projectId: uuidV7IdGenerator.next("prj"),
            environment: "local",
            durationMs: 10,
            snapshot: {
              schemaVersion: "1.0.0",
              workspaceId,
              runId,
              revisionId,
              attemptId,
              snapshotId,
              manifestHash: "0".repeat(64),
              redactionPolicyHash: "0".repeat(64),
              committedAt: new Date().toISOString(),
            },
            manifest: {
              schemaVersion: "1.0.0",
              workspaceId,
              runId,
              revisionId,
              attemptId,
              snapshotId,
              entries: [
                {
                  relativePath: "evidence/dom.txt",
                  artifactId: uuidV7IdGenerator.next("art"),
                  kind: "dom",
                  mimeType: "text/plain",
                  state: "missing",
                  sha256: null,
                  sizeBytes: 0,
                  redactionStatus: "not_applicable",
                  omissionReason: "redaction_failed",
                },
              ],
            },
            steps: [],
            attempts: [],
          },
        ],
    selection: {
      requested: empty ? 0 : 1,
      notDispatched: [],
      excluded: [],
      allowEmpty: true,
      emptyReason: "No selected tests",
    },
    completeness: { state: "complete", reasons: [] },
  };
}
describe("snapshot reporters", () => {
  it("preserves business pass but emits cleanup error and canonical properties", () => {
    const input = snapshot();
    const xml = exportJunit(input);
    expect(xml).toContain('<error type="cleanup_failed"');
    expect(xml).toContain('name="businessOutcome" value="passed"');
    expect(xml).toContain('name="gate" value="failed"');
    expect(xml).not.toContain("]]> ");
    expect(xml).not.toContain("<script>");
    expect(
      [...xml].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 32 && ![9, 10, 13].includes(code);
      }),
    ).toBe(false);
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toContain("redaction_failed");
    const html = exportHtml(input);
    expect(html).not.toContain("<script");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("redaction_failed");
    expect(JSON.parse(exportJson(input)).runs[0].manifest.entries[0].omissionReason).toBe(
      "redaction_failed",
    );
    expect(exportMarkdown(input)).toContain("redaction");
    const allure = Object.values(exportAllure(input)).map((file) => JSON.parse(file));
    expect(allure.some((file) => file.status === "broken")).toBe(true);
  });
  it("never renders empty selection green in any format", () => {
    const input = snapshot(true);
    expect(reportGate(input)).toBe("not_applicable");
    expect(JSON.parse(exportJson(input)).gate).not.toBe("passed");
    expect(exportMarkdown(input)).toContain("not_applicable");
    expect(exportHtml(input)).toContain("not_applicable");
    expect(exportJunit(input)).toContain('<error type="incomplete_selection"');
    expect(JSON.parse(exportAllure(input)["selection-result.json"] ?? "{}").status).toBe("broken");
  });
  it("maps assertion failure, infra and cancellation without approving partial results", () => {
    const input = snapshot();
    const run = input.runs[0];
    if (!run) throw new Error("Fixture missing");
    run.result.outcome = "failed";
    run.result.status = "failed";
    expect(exportJunit(input)).toContain("<failure");
    run.result.outcome = "blocked";
    run.result.status = "blocked";
    expect(exportJunit(input)).toContain("<error");
    run.result.outcome = "cancelled";
    run.result.status = "cancelled";
    expect(exportJunit(input)).toContain("<skipped");
    expect(reportGate(input)).not.toBe("passed");
    run.result.phase = "running";
    run.result.outcome = null;
    run.result.status = "running";
    run.result.gate = "pending";
    expect(exportJunit(input)).toContain("partial_result");
    expect(reportGate(input)).not.toBe("passed");
  });
  it("refuses mixed snapshots", () => {
    const input = snapshot();
    const run = input.runs[0];
    if (!run) throw new Error("Fixture missing");
    run.manifest.snapshotId = uuidV7IdGenerator.next("snp");
    expect(() => exportJson(input)).toThrow("binding mismatch");
  });
});
