import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  controlledShop,
  eventually,
  healthPlan,
  items,
  journey,
  object,
  root,
  text,
} from "./harness.js";

it("OPS-021/024 real concurrent GC and publication survive discrepant refcounts and backup holds", async () => {
  await journey("ops-021-publication-gc-backup-holds", async (session) => {
    const target = await controlledShop();
    try {
      await session.init(target.url);
      const test = await session.createTest(healthPlan());
      const first = await session.command([
        "test",
        "run",
        text(test.id),
        "--wait",
        "--timeout",
        "120",
      ]);
      const firstId = text(object(first.run).id);
      await session.command([
        "backup",
        "create",
        "--out",
        join(session.temporary, "protected-backup"),
      ]);
      const db = new DatabaseSync(join(session.dataDir, "testmaster.db"));
      const keys = db
        .prepare(
          "SELECT workspace_id,storage_key FROM artifacts WHERE run_id=? AND state='available'",
        )
        .all(firstId);
      for (const key of keys)
        db.prepare(
          "UPDATE blob_reference_counts SET references_count=0 WHERE workspace_id=? AND storage_key=?",
        ).run(String(key.workspace_id), String(key.storage_key));
      db.close();
      const preview = await session.command(["artifact", "repair-references"]);
      expect(preview.dryRun).toBe(true);
      expect((preview.changes as unknown[]).length).toBeGreaterThan(0);
      await session.command(["artifact", "repair-references", "--apply"]);
      const marker = join(session.temporary, "publication-ready");
      const worker = session.start(["worker", "start"], {
        NODE_OPTIONS: `--import=${join(root, "validation/journeys/crash-publication-hook.mjs")}`,
        TESTMASTER_ACCEPTANCE_FAULTS: "1",
        TESTMASTER_ACCEPTANCE_BOUNDARY: "pause-publication",
        TESTMASTER_ACCEPTANCE_MARKER: marker,
      });
      await eventually(
        () => session.command(["worker", "status"]),
        (status) =>
          items(status.items).some(
            (row) => row.state === "ready" && object(row.labels).pid === String(worker.child.pid),
          ),
      );
      const receipt = await session.command(["test", "run", text(test.id)]);
      const secondId = text(receipt.runId);
      const renamedDir = await eventually(
        async () => {
          try {
            return await readFile(marker, "utf8");
          } catch {
            return "";
          }
        },
        (path) => path.length > 0,
      );
      const gc = session.command(["worker", "reconcile"], 0, {
        NODE_OPTIONS: `--import=${join(root, "validation/journeys/retention-clock-hook.mjs")}`,
        TESTMASTER_ACCEPTANCE_FAULTS: "1",
      });
      await gc;
      expect(await readFile(join(renamedDir, ".partial"), "utf8")).toContain(secondId);
      await writeFile(`${marker}.release`, "release");
      await session.command(["run", "wait", secondId, "--timeout", "120"]);
      const firstBundle = await session.command(["artifact", "get", firstId]);
      const secondBundle = await session.command(["artifact", "get", secondId]);
      expect(firstBundle.manifest).toBeDefined();
      expect(secondBundle.manifest).toBeDefined();
      const final = new DatabaseSync(join(session.dataDir, "testmaster.db"), { readOnly: true });
      try {
        expect(
          final
            .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE run_id=? AND state='expired'")
            .get(firstId)?.n,
        ).toBe(0);
        expect(
          final
            .prepare("SELECT COUNT(*) AS n FROM blob_reference_counts WHERE references_count=0")
            .get()?.n,
        ).toBe(0);
      } finally {
        final.close();
      }
      worker.child.kill("SIGTERM");
      await worker.result;
      session.oracles.push({
        check: "concurrentPublicationGcBackupHoldRefcountRepair",
        healthy: true,
        firstId,
        secondId,
      });
    } finally {
      target.release();
      await target.close();
    }
  });
}, 180000);

it("OPS-025 restore requires explicit admin review and new Attempt decision without automatic effects", async () => {
  await journey("ops-025-authorized-restore-reopen", async (session) => {
    const target = await controlledShop();
    try {
      await session.init(target.url);
      const test = await session.createTest(healthPlan());
      const worker = await session.worker();
      target.hold();
      const receipt = await session.command(["test", "run", text(test.id)]);
      const runId = text(receipt.runId);
      await session.observe(runId, (run) => run.status === "running");
      await eventually(
        async () => target.hits(),
        (hits) => hits > 0,
      );
      await session.command(["backup", "create", "--out", join(session.temporary, "backup")]);
      const isolated = join(session.temporary, "restore");
      await session.command([
        "backup",
        "restore",
        join(session.temporary, "backup"),
        "--out",
        isolated,
      ]);
      const env = { TESTMASTER_DATA_DIR: isolated };
      const before = target.hits();
      const preview = await session.command(["backup", "review"], 0, env);
      expect(preview.activeRunsRequireDecision).toContain(runId);
      const denied = await session.start(["backup", "review", "--apply"], env).result;
      expect(denied.exitCode).not.toBe(0);
      await session.command(["backup", "review", "--apply", "--revocations-confirmed"], 0, env);
      expect(target.hits()).toBe(before);
      await session.command(["backup", "resume-run", runId], 0, env);
      expect(target.hits()).toBe(before);
      await session.command(["backup", "resume-run", runId, "--apply"], 0, env);
      expect(target.hits()).toBe(before);
      target.release();
      worker.child.kill("SIGTERM");
      await worker.result;
      const restoredWorker = session.start(["worker", "start"], env);
      const restoredRun = await eventually(
        () => session.command(["run", "get", runId], 0, env),
        (run) => run.phase === "completed",
      );
      expect(restoredRun.outcome).toBe("passed");
      restoredWorker.child.kill("SIGTERM");
      await restoredWorker.result;
      const db = new DatabaseSync(join(isolated, "testmaster.db"), { readOnly: true });
      try {
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM audit_events WHERE action='restore.review.approved'",
            )
            .get()?.n,
        ).toBe(1);
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM outbox WHERE aggregate_id=? AND type='restore.run.resume'",
            )
            .get(runId)?.n,
        ).toBe(1);
        expect(db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE run_id=?").get(runId)?.n).toBe(
          2,
        );
      } finally {
        db.close();
      }
      session.oracles.push({
        check: "explicitRestoreReviewNewAttempt",
        healthy: true,
        runId,
        noEffectsBeforeDecision: true,
      });
    } finally {
      target.release();
      await target.close();
    }
  });
}, 180000);
