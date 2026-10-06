import { semanticHash } from "@testmaster/domain";
import type { EntityDocument } from "@testmaster/persistence";
import { expect, it } from "vitest";
import {
  type AdmissionSnapshot,
  admissionInputHash,
  reproduction,
  verifyAdmission,
} from "./provenance.js";

it("refuses mutated admitted inputs and capabilities without changing replay degree", () => {
  const environment = { id: "environment" } as EntityDocument;
  const revision = { contentHash: "a".repeat(64), runnerKind: "http" } as EntityDocument;
  const effectiveConfig = {
    config: { schemaVersion: "1.0.0" },
    origins: {},
    policyHash: "b".repeat(64),
  };
  const cell: Record<string, unknown> = {
    effectiveConfig,
    executor: "process",
    baseUrl: "http://localhost:8000",
    limits: {},
    seed: 12,
  };
  const snapshot = {
    revisionHash: revision.contentHash,
    environmentHash: semanticHash(environment),
    images: null,
    requiredCapabilities: ["http"],
    seed: 12,
    policyHash: effectiveConfig.policyHash,
    limitations: ["mutable-external-target", "remote-model-snapshot-unavailable"],
    inputHash: admissionInputHash(cell),
  } as AdmissionSnapshot;
  cell.admissionSnapshot = snapshot;
  cell.admissionSnapshotHash = semanticHash(snapshot);
  const run = { matrixCell: cell } as EntityDocument;
  expect(verifyAdmission(run, revision, environment, null).seed).toBe(12);
  cell.baseUrl = "http://localhost:9000";
  expect(() => verifyAdmission(run, revision, environment, null)).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ incompatibility: "execution_input_hash_mismatch" }),
    }),
  );
  cell.baseUrl = "http://localhost:8000";
  snapshot.requiredCapabilities = ["future-runner"];
  cell.admissionSnapshotHash = semanticHash(snapshot);
  expect(() => verifyAdmission(run, revision, environment, null)).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ incompatibility: "capability_incompatible" }),
    }),
  );
  expect(reproduction(snapshot).degree).toBe("strict-execution-replay");
  expect(reproduction(snapshot, undefined, true)).toMatchObject({
    degree: "fresh-llm-regeneration",
    limitations: expect.arrayContaining(["remote-model-snapshot-unavailable"]),
  });
});
