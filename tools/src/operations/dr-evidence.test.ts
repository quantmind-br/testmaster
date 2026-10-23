import { resolve } from "node:path";
import { expect, it } from "vitest";
import { findDrRehearsalViolations, findS3LossViolations, loadDrRehearsal } from "./dr-evidence.js";

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

const measuredS3Loss = (): Json => ({
  status: "measured",
  milestone: "M5",
  scenario: "evidence-bucket-loss",
  evidenceObjectsLost: 3,
  backup: {
    backupId: "bak_1",
    bucket: "tm-backups",
    objectLockMode: "COMPLIANCE",
    objects: 5,
    authentic: true,
  },
  lock: { deleteRefused: true, appCredentialDenied: true },
  restore: {
    exitCode: 0,
    emptiedBucketVerified: true,
    evidenceFiles: [
      { path: "runs/a", source: "a".repeat(64), restored: "a".repeat(64), equal: true },
    ],
  },
  rpoSeconds: 12,
  rtoSeconds: 90,
  notMeasured: ["multi-region replication"],
});

it("OPS-026 the retained S3 loss rehearsal restored every evidence object from the locked backup and names what it did not measure", async () => {
  const record = await loadDrRehearsal(resolve("validation/results/m5-s3-loss-rehearsal.json"));
  expect(findS3LossViolations(record)).toEqual([]);
  expect(record.notMeasured).not.toEqual([]);
});

it("OPS-026 an S3 loss is accepted only with the rows that prove it", async () => {
  const measured = await copy();
  measured.s3Loss = measuredS3Loss();
  expect(findS3LossViolations(measuredS3Loss())).toEqual([]);
  expect(findDrRehearsalViolations(measured)).toEqual([]);

  const claimed = await copy();
  claimed.s3Loss = { status: "measured", milestone: "M5" };
  expect(findDrRehearsalViolations(claimed)).toContainEqual(expect.stringContaining("S3 loss"));
  const unknown = await copy();
  unknown.s3Loss = { status: "later", milestone: "M6" };
  expect(findDrRehearsalViolations(unknown)).toContain(
    "S3 loss is neither measured nor honestly deferred",
  );

  const broken: [string, (record: Json) => void, string][] = [
    [
      "a file hash",
      (r) => {
        element((r.restore as { evidenceFiles: Json[] }).evidenceFiles, 0).restored = "b".repeat(
          64,
        );
      },
      "hash differs after restore",
    ],
    [
      "an unlocked bucket",
      (r) => {
        (r.backup as Json).objectLockMode = "GOVERNANCE";
      },
      "COMPLIANCE Object Lock",
    ],
    [
      "an unproven lock",
      (r) => {
        (r.lock as Json).deleteRefused = false;
      },
      "cannot be deleted",
    ],
    [
      "app access to the backup",
      (r) => {
        (r.lock as Json).appCredentialDenied = false;
      },
      "app credential",
    ],
    [
      "a restore that did not start empty",
      (r) => {
        (r.restore as Json).emptiedBucketVerified = false;
      },
      "emptied evidence bucket",
    ],
    [
      "a failed restore",
      (r) => {
        (r.restore as Json).exitCode = 1;
      },
      "restore exited 1",
    ],
    [
      "an unauthentic backup",
      (r) => {
        (r.backup as Json).authentic = false;
      },
      "authentic",
    ],
    [
      "an unmeasured RTO",
      (r) => {
        delete r.rtoSeconds;
      },
      "RTO was not measured",
    ],
    [
      "an undeclared gap",
      (r) => {
        delete r.notMeasured;
      },
      "did not measure",
    ],
  ];
  for (const [, mutate, expected] of broken) {
    const record = measuredS3Loss();
    mutate(record);
    expect(findS3LossViolations(record)).toContainEqual(expect.stringContaining(expected));
  }
});

it("OPS-026 never accepts a verdict that its rows contradict", async () => {
  const flipped = await copy();
  named(flipped, "rowCount.runs").equal = false;
  expect(findDrRehearsalViolations(flipped)).toContain(
    "the record's own verdict disagrees with its rows",
  );
  expect(findDrRehearsalViolations({ ...flipped, passed: false })).not.toContain(
    "the record's own verdict disagrees with its rows",
  );
});
