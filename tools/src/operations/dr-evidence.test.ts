import { resolve } from "node:path";
import { expect, it } from "vitest";
import { findDrRehearsalViolations, loadDrRehearsal } from "./dr-evidence.js";

const recordPath = resolve("validation/results/m4-dr-rehearsal.json");

type Json = Record<string, unknown>;
async function copy(): Promise<Json> {
  return structuredClone(await loadDrRehearsal(recordPath));
}
function rows(record: Json): Json[] {
  return (record.comparison as { rows: Json[] }).rows;
}
function element(list: Json[], index: number): Json {
  const found = list[index];
  if (!found) throw new Error(`missing element ${index}`);
  return found;
}
function named(record: Json, name: string): Json {
  const found = rows(record).find((row) => row.name === name);
  if (!found) throw new Error(`missing comparison row ${name}`);
  return found;
}

it("OPS-026 the retained rehearsal restored content, hashes and access on a fresh stack from only the backup and keys", async () => {
  const record = await loadDrRehearsal(recordPath);
  expect(findDrRehearsalViolations(record)).toEqual([]);
  expect(record.rpoSeconds).toBeGreaterThan(0);
  expect(record.rtoSeconds).toBeGreaterThan(0);
  expect(record.s3Loss).toEqual({ status: "deferred", milestone: "M5" });
});

it("OPS-026 a restored hash, an access check, a failed step or a missing measurement is reported instead of accepted", async () => {
  const hash = await copy();
  element((hash.hashTable as { evidenceFiles: Json[] }).evidenceFiles, 0).restored = "0".repeat(64);
  expect(findDrRehearsalViolations(hash)).toContainEqual(
    expect.stringContaining("hash differs after restore"),
  );

  const digest = await copy();
  named(digest, "auditEvents.digest").equal = false;
  expect(findDrRehearsalViolations(digest)).toContain("comparison row auditEvents.digest differs");

  const access = await copy();
  element((access.access as { checks: Json[] }).checks, 2).ok = false;
  expect(findDrRehearsalViolations(access)).toContainEqual(
    expect.stringContaining("access check failed"),
  );

  const isolation = await copy();
  element((isolation.isolation as { checks: Json[] }).checks, 1).ok = false;
  expect(findDrRehearsalViolations(isolation)).toContainEqual(
    expect.stringContaining("isolation check failed"),
  );

  const step = await copy();
  element(step.steps as Json[], 13).exitCode = 1;
  expect(findDrRehearsalViolations(step)).toContainEqual(expect.stringMatching(/step .* exited 1/));

  const unmeasured = await copy();
  delete unmeasured.rtoSeconds;
  expect(findDrRehearsalViolations(unmeasured)).toContain("RTO was not measured");

  const dropped = await copy();
  dropped.comparison = {
    passed: true,
    rows: rows(dropped).filter((row) => row.name !== "postBackupWriteAbsent"),
  };
  expect(findDrRehearsalViolations(dropped)).toContain(
    "comparison does not prove the post-backup write is gone",
  );
});

it("OPS-026 never accepts a claim about S3 loss or a verdict that its rows contradict", async () => {
  const claimed = await copy();
  claimed.s3Loss = { status: "measured", milestone: "M4" };
  expect(findDrRehearsalViolations(claimed)).toContain(
    "S3 loss must stay deferred to M5, not claimed",
  );

  const flipped = await copy();
  named(flipped, "rowCount.runs").equal = false;
  expect(findDrRehearsalViolations(flipped)).toContain(
    "the record's own verdict disagrees with its rows",
  );
  expect(findDrRehearsalViolations({ ...flipped, passed: false })).not.toContain(
    "the record's own verdict disagrees with its rows",
  );
});
