import type { Analysis } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { XMLValidator } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import {
  diagnosisSummary,
  exportAllure,
  exportHtml,
  exportJson,
  exportJunit,
  exportMarkdown,
  formatDiagnosisSummary,
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
            evidenceState: "committed",
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
    if (!run || run.evidenceState !== "committed") throw new Error("Fixture missing");
    run.manifest.snapshotId = uuidV7IdGenerator.next("snp");
    expect(() => exportJson(input)).toThrow("binding mismatch");
  });
});

it("exports honest partial evidence while retaining original failure in every format", () => {
  const input = snapshot();
  const original = input.runs[0];
  if (!original) throw new Error("Missing fixture");
  input.runs = [
    {
      ...original,
      evidenceState: "unavailable",
      snapshot: null,
      manifest: null,
      evidenceErrors: ["committed bundle missing"],
      result: { ...original.result, outcome: "failed", gate: "failed" },
    },
  ];
  input.completeness = { state: "partial", reasons: ["committed bundle missing"] };
  expect(JSON.parse(exportJson(input)).runs[0].result.outcome).toBe("failed");
  expect(exportMarkdown(input)).toContain("committed bundle missing");
  expect(exportHtml(input)).toContain("committed bundle missing");
  expect(exportJunit(input)).toContain('name="snapshot" value="unavailable"');
  expect(Object.values(exportAllure(input)).join("\n")).toContain("failed");
});

it("bounds large JUnit output and exposes truncation without losing the gate", () => {
  const input = snapshot();
  const run = input.runs[0];
  if (!run || run.evidenceState !== "committed") throw new Error("Missing fixture");
  run.steps = [{ observed: { text: "<hostile>&".repeat(200000) } }] as unknown as typeof run.steps;
  const output = exportJunit(input);
  expect(XMLValidator.validate(output)).toBe(true);
  expect(output).toContain('name="systemOutTruncated" value="true"');
  expect(output).toContain('name="gate" value="failed"');
  expect(Buffer.byteLength(output)).toBeLessThan(16 * 1024 * 1024);
  input.runs = Array.from({ length: 12 }, () => {
    const member = structuredClone(run);
    const id = uuidV7IdGenerator.next("run");
    member.run.id = id;
    member.result.runId = id;
    member.snapshot.runId = id;
    member.manifest.runId = id;
    return member;
  });
  input.selection.requested = input.runs.length;
  expect(() => exportJunit(input)).toThrow("JUnit output exceeds 16 MiB");
});

it("summarizes nonempty excludes and reasons without adding excluded members to test totals", () => {
  const input = snapshot();
  input.selection.excluded = [
    { memberKey: "disabled-catalog", reasonCode: "explicit_selection_exclusion" },
  ];
  const output = exportJunit(input);
  expect(output).toContain('tests="1"');
  expect(output).toContain('name="excluded" value="1"');
  expect(output).toContain("disabled-catalog");
  expect(output).toContain("explicit_selection_exclusion");
  expect(JSON.parse(exportJson(input)).selection.excluded).toEqual(input.selection.excluded);
  expect(exportMarkdown(input)).toContain("excluded: 1");
});

it("renders layered conclusion and next action in Markdown and HTML without probability claims", () => {
  const input = snapshot();
  const item = input.runs[0];
  if (!item) throw new Error("Missing fixture");
  const analysis: Analysis = {
    id: uuidV7IdGenerator.next("ana"),
    runId: item.run.id,
    snapshotId: null,
    parentId: null,
    source: "rules",
    affectedRequirementIds: [],
    failureKind: "product_bug",
    confidence: 0.9,
    modelCallId: null,
    limitations: ["Backend cause not observed"],
    recommendedAction: "collect_more_evidence",
    facts: [{ text: "Creation succeeded", evidenceRefs: [] }],
    hypotheses: [
      {
        text: "Write may not persist",
        supports: [],
        contradicts: [],
        confidence: 0.9,
        calibrated: false,
        support: "partially_supported",
      },
    ],
    diagnosis: {
      observation: {
        stepId: "read",
        operation: "assert",
        summary: "Created item absent",
        expected: "Created item",
        observed: "[]",
        absence: "empty_collection",
        evidenceRefs: [],
      },
      chain: [],
      alternatives: [
        { text: "Different account context", failureKind: "unknown", evidenceRefs: [] },
      ],
      conclusion: {
        status: "cause_partially_supported",
        text: "Expected effect absent; internal cause undetermined",
      },
      nextSteps: [
        {
          text: "Compare create and read identity and environment",
          source: "rules",
          evidenceRefs: [],
        },
      ],
      evidenceGaps: ["No server-side trace"],
      healing: { advice: "not_indicated", reason: "Changing assertion would hide the mismatch" },
    },
  };
  item.analysis = analysis;
  for (const output of [exportMarkdown(input), exportHtml(input)]) {
    expect(output).toContain("Diagnosis");
    expect(output).toContain("Expected effect absent; internal cause undetermined");
    expect(output).toContain("Compare create and read identity and environment");
    expect(output).toContain("partially supported");
    expect(output).toContain("No server");
    expect(output).not.toContain("90%");
  }
  expect(diagnosisSummary(analysis).fields.find((field) => field.label === "Observed")?.text).toBe(
    "[] (empty collection)",
  );
  expect(JSON.parse(exportJson(input)).runs[0].analysis).toEqual(analysis);
});

it("escapes hostile diagnosis hypotheses and warns honestly for historical analyses", () => {
  const input = snapshot();
  const item = input.runs[0];
  if (!item) throw new Error("Missing fixture");
  const hostile = '<img src=x onerror="alert(1)"> [click](javascript:alert(1))\n# injected';
  item.analysis = {
    id: uuidV7IdGenerator.next("ana"),
    runId: item.run.id,
    snapshotId: null,
    parentId: null,
    source: "rules",
    affectedRequirementIds: [],
    failureKind: "unknown",
    confidence: null,
    modelCallId: null,
    limitations: [],
    recommendedAction: "collect_more_evidence",
    facts: [{ text: "Failure observed", evidenceRefs: [] }],
    hypotheses: [
      { text: hostile, supports: [], contradicts: [], confidence: 0.99, calibrated: true },
    ],
  };
  const html = exportHtml(input);
  const md = exportMarkdown(input);
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  expect(html).not.toContain("<img");
  expect(md).toContain("\\[click\\]\\(javascript:alert\\(1\\)\\)");
  expect(md).not.toContain("\n# injected");
  expect(md).not.toContain("[click](javascript:");
  for (const output of [html, md, formatDiagnosisSummary(item.analysis)]) {
    expect(output).toContain("layered diagnosis not recorded for this analysis");
    expect(output).toContain("not established");
    expect(output).not.toContain("99%");
  }
});
