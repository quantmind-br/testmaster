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

it("OPS-005 SIGKILL before and after revision/admission commit preserves all-or-none ownership", async () => {
  await journey("ops-005-authoring-admission-crash", async (session) => {
    const target = await controlledShop();
    try {
      await session.init(target.url);
      const worker = await session.worker();
      const planPath = await session.plan(healthPlan());
      for (const boundary of ["before-revision", "after-revision"]) {
        const result = await session.start(["test", "create", "--plan", planPath], {
          NODE_OPTIONS: `--import=${join(root, "validation/journeys/crash-publication-hook.mjs")}`,
          TESTMASTER_ACCEPTANCE_FAULTS: "1",
          TESTMASTER_ACCEPTANCE_BOUNDARY: boundary,
        }).result;
        expect(result.signal).toBe("SIGKILL");
      }
      const db = new DatabaseSync(join(session.dataDir, "testmaster.db"), { readOnly: true });
      let testId: string;
      try {
        expect(db.prepare("SELECT COUNT(*) AS n FROM tests").get()?.n).toBe(1);
        expect(db.prepare("SELECT COUNT(*) AS n FROM test_revisions").get()?.n).toBe(1);
        testId = String(db.prepare("SELECT id FROM tests").get()?.id);
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
      }
      for (const boundary of ["before-admission", "after-admission"]) {
        const result = await session.start(["test", "run", testId], {
          NODE_OPTIONS: `--import=${join(root, "validation/journeys/crash-publication-hook.mjs")}`,
          TESTMASTER_ACCEPTANCE_FAULTS: "1",
          TESTMASTER_ACCEPTANCE_BOUNDARY: boundary,
        }).result;
        expect(result.signal).toBe("SIGKILL");
      }
      const retained = new DatabaseSync(join(session.dataDir, "testmaster.db"), { readOnly: true });
      try {
        expect(retained.prepare("SELECT COUNT(*) AS n FROM runs").get()?.n).toBe(1);
        expect(retained.prepare("SELECT COUNT(*) AS n FROM job_leases").get()?.n).toBe(1);
        expect(
          retained.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='run.accepted'").get()?.n,
        ).toBe(1);
        expect(retained.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      } finally {
        retained.close();
      }
      worker.child.kill("SIGTERM");
      await worker.result;
      session.oracles.push({
        check: "revisionAdmissionAllOrNoneCommitKill",
        healthy: true,
        revisions: 1,
        runs: 1,
      });
    } finally {
      await target.close();
    }
  });
}, 180000);

it("OPS-012 duplicate reconcilers create exactly one eligible retry Attempt", async () => {
  await journey("ops-012-eligible-retry-race", async (session) => {
    const target = await controlledShop();
    try {
      await session.init(target.url);
      const configPath = join(session.cwd, "testmaster.config.json");
      const config = object(JSON.parse(await readFile(configPath, "utf8")));
      config.execution = { ...object(config.execution), maxAttempts: 2 };
      await writeFile(configPath, JSON.stringify(config));
      const test = await session.createTest(healthPlan());
      const lost = session.start(["worker", "start"], {
        NODE_OPTIONS: `--import=${join(root, "validation/journeys/crash-publication-hook.mjs")}`,
        TESTMASTER_ACCEPTANCE_FAULTS: "1",
        TESTMASTER_ACCEPTANCE_BOUNDARY: "after-claim",
      });
      await eventually(
        () => session.command(["worker", "status"]),
        (status) =>
          items(status.items).some(
            (row) => row.state === "ready" && object(row.labels).pid === String(lost.child.pid),
          ),
      );
      const receipt = await session.command(["test", "run", text(test.id)]);
      const runId = text(receipt.runId);
      expect((await lost.result).signal).toBe("SIGKILL");
      const db = new DatabaseSync(join(session.dataDir, "testmaster.db"));
      db.prepare("UPDATE job_leases SET lease_expires_at=? WHERE resource_id=?").run(
        new Date(0).toISOString(),
        runId,
      );
      db.close();
      await Promise.all([
        session.command(["worker", "reconcile"]),
        session.command(["worker", "reconcile"]),
      ]);
      const replacement = await session.worker();
      const completed = await session.observe(runId, (run) => run.phase === "completed");
      expect(completed.outcome).toBe("passed");
      const result = new DatabaseSync(join(session.dataDir, "testmaster.db"), { readOnly: true });
      try {
        expect(
          result.prepare("SELECT COUNT(*) AS n FROM attempts WHERE run_id=?").get(runId)?.n,
        ).toBe(2);
        expect(
          result
            .prepare(
              "SELECT COUNT(*) AS n FROM outbox WHERE aggregate_id=? AND type='run.completed'",
            )
            .get(runId)?.n,
        ).toBe(1);
      } finally {
        result.close();
      }
      replacement.child.kill("SIGTERM");
      await replacement.result;
      session.oracles.push({
        check: "eligibleRetryDuplicateReconciler",
        healthy: true,
        runId,
        attempts: 2,
      });
    } finally {
      await target.close();
    }
  });
}, 180000);
