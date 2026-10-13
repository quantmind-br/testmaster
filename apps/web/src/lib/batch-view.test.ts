import { describe, expect, it } from "vitest";
import {
  describeRunContext,
  gateBadge,
  normalizeBatch,
  shortId,
  summarizeBatchCancel,
} from "./batch-view";
import type { RunRecord } from "./run-types";

function runWith(matrixCell: RunRecord["matrixCell"]): RunRecord {
  return {
    id: "run_aaaaaaaa-0000-4000-8000-000000000000",
    testId: "tst_1",
    revisionId: "rev_1",
    environmentRevisionId: "evr_1",
    batchId: "bat_1",
    mode: "replay",
    phase: "completed",
    status: "passed",
    outcome: "passed",
    origin: "api",
    gate: "passed",
    cleanupOutcome: "not_required",
    analysisStatus: "not_requested",
    createdAt: "2026-10-13T00:00:00.000Z",
    version: 1,
    ...(matrixCell ? { matrixCell } : {}),
  };
}

describe("batch normalisation", () => {
  it("UX-036 reads the stored batch: Run IDs only in allMembers, rejected members as not dispatched", () => {
    const view = normalizeBatch(
      {
        id: "bat_1",
        requestedCount: 3,
        memberRuns: ["run_a", "run_b"],
        rejectedMembers: [{ memberKey: "1:tst_x", reasonCode: "upstream_failed" }],
        aggregate: {
          counts: { passed: 2, failed: 0, blocked: 0, cancelled: 0, inconclusive: 0, inFlight: 0 },
          gate: "failed",
          expanded: { count: 0 },
          allMembers: [{ runId: "run_a" }, { runId: "run_b" }, { runId: null }],
        },
      },
      "fallback",
    );
    expect(view.batchId).toBe("bat_1");
    expect(view.allMembers).toEqual(["run_a", "run_b"]);
    expect(view.requested).toBe(3);
    expect(view.notDispatched).toEqual([{ memberKey: "1:tst_x", reasonCode: "upstream_failed" }]);
    expect(view.gate).toBe("failed");
  });

  it("UX-036 also reads an admission receipt, and an empty answer never invents members", () => {
    const receipt = normalizeBatch(
      {
        batchId: "bat_2",
        requested: 1,
        accepted: 1,
        notDispatched: [],
        allMembers: ["run_a"],
        counts: { passed: 0, failed: 0, blocked: 0, cancelled: 0, inconclusive: 0, inFlight: 1 },
        gate: "pending",
      },
      "fallback",
    );
    expect(receipt.allMembers).toEqual(["run_a"]);
    const empty = normalizeBatch(null, "bat_3");
    expect(empty.batchId).toBe("bat_3");
    expect(empty.allMembers).toEqual([]);
    expect(empty.notDispatched).toEqual([]);
  });
});

describe("batch gate badge", () => {
  it("UX-036 an incomplete batch never shows a passed gate", () => {
    const degraded = gateBadge({ completeness: "incomplete" }, "passed");
    expect(degraded.status).toBe("degraded");
    expect(degraded.label).toContain("not final");
    expect(gateBadge({ completeness: "incomplete" }, "pending").status).toBe("degraded");
    expect(gateBadge({ completeness: "incomplete" }, "failed").status).toBe("failed");
  });

  it("UX-036 a complete batch keeps the gate the server computed", () => {
    expect(gateBadge({ completeness: "complete" }, "passed")).toEqual({
      status: "passed",
      label: "Gate passed",
    });
    expect(gateBadge({ completeness: "complete" }, "failed").status).toBe("failed");
    expect(gateBadge({ completeness: "complete" }, "not_applicable").label).toBe(
      "Gate not applicable",
    );
  });
});

describe("run context in a matrix cell", () => {
  it("UX-036 exposes browser, version, runner image, viewport, locale, time zone and environment", () => {
    const context = describeRunContext(
      runWith({
        environmentName: "staging",
        admissionSnapshot: {
          runnerImageDigest: "sha256:runner",
          runtimeIdentity: { browserName: "firefox", browserVersion: "141.0" },
        },
        effectiveConfig: {
          config: {
            browser: { name: "firefox", viewport: { width: 1280, height: 720 } },
            environment: { locale: "pt-BR", timezone: "America/Sao_Paulo" },
          },
        },
      } as RunRecord["matrixCell"]),
    );
    expect(context).toEqual({
      environment: "staging",
      browser: "firefox",
      browserVersion: "141.0",
      runnerImage: "sha256:runner",
      viewport: "1280×720",
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
    });
  });

  it("UX-036 a value the Run did not record says so instead of showing a default", () => {
    const context = describeRunContext(runWith(undefined));
    for (const value of Object.values(context)) expect(value).toBe("Not recorded");
  });
});

describe("batch helpers", () => {
  it("UX-036 shortens Run identifiers without their prefix", () => {
    expect(shortId("run_aaaaaaaa-0000-4000-8000-000000000000")).toBe("aaaaaaaa");
    expect(shortId("plain")).toBe("plain");
  });

  it("UX-036 summarises a batch cancellation by what happened to each member", () => {
    const summary = summarizeBatchCancel([
      { result: "requested" },
      { result: "requested" },
      { result: "already_terminal" },
      { result: "rejected" },
    ]);
    expect(summary).toMatchObject({ requested: 2, alreadyTerminal: 1, rejected: 1 });
    expect(summary.text).toContain("requested for 2 Run(s)");
    expect(summarizeBatchCancel([]).requested).toBe(0);
  });
});
