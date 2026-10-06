import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  controlledShop,
  data,
  eventually,
  healthPlan,
  items,
  journey,
  object,
  root,
  terminal,
  text,
} from "./harness.js";

it("J17 kills publication before DB commit, after DB commit and after finalization without false or duplicate publication", async () => {
  await journey("j17-publication-crash-matrix", async (session) => {
    const target = await controlledShop();
    try {
      await session.init(target.url);
      const test = await session.createTest(healthPlan());
      for (const boundary of [
        "after-claim",
        "during-upload",
        "before-publication",
        "after-publication",
        "after-finalization",
        "publication-failure",
      ]) {
        const marker = join(session.temporary, `${boundary}.marker`);
        const worker = session.start(["worker", "start"], {
          NODE_OPTIONS: `--import=${join(root, "validation/journeys/crash-publication-hook.mjs")}`,
          TESTMASTER_ACCEPTANCE_FAULTS: "1",
          TESTMASTER_ACCEPTANCE_BOUNDARY: boundary,
          TESTMASTER_ACCEPTANCE_MARKER: marker,
        });
        await eventually(
          () => session.command(["worker", "status"]),
          (status) =>
            items(status.items).some(
              (row) => object(row.labels).pid === String(worker.child.pid) && row.state === "ready",
            ),
        );
        const receipt = await session.command(["test", "run", text(test.id)]);
        const runId = text(receipt.runId);
        if (boundary !== "publication-failure") {
          expect((await worker.result).signal).toBe("SIGKILL");
          expect(await readFile(marker, "utf8")).toBe(boundary);
        } else {
          await session.observe(runId, (run) => run.phase === "completed");
          worker.child.kill("SIGTERM");
          await worker.result;
        }
        const database = new DatabaseSync(join(session.dataDir, "testmaster.db"));
        try {
          const published = Number(
            database.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE run_id=?").get(runId)?.n,
          );
          expect(published).toBe(
            ["after-publication", "after-finalization"].includes(boundary) ? 1 : 0,
          );
          const artifacts = Number(
            database.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE run_id=?").get(runId)?.n,
          );
          if (published) expect(artifacts).toBeGreaterThan(0);
          else expect(artifacts).toBe(0);
          const state = database.prepare("SELECT outcome,gate FROM runs WHERE id=?").get(runId);
          if (boundary === "publication-failure") {
            expect(state?.outcome).toBe("passed");
            expect(state?.gate).toBe("failed");
          }
          database
            .prepare(
              "UPDATE job_leases SET lease_expires_at=? WHERE resource_id=? AND state='leased'",
            )
            .run(new Date(0).toISOString(), runId);
        } finally {
          database.close();
        }
        const beforePreview = new DatabaseSync(join(session.dataDir, "testmaster.db"), {
          readOnly: true,
        });
        const beforeRows = {
          jobs: beforePreview.prepare("SELECT * FROM job_leases ORDER BY id").all(),
          runs: beforePreview.prepare("SELECT * FROM runs ORDER BY id").all(),
          events: beforePreview.prepare("SELECT * FROM outbox ORDER BY id").all(),
        };
        beforePreview.close();
        const preview = await session.command(["worker", "reconcile", "--dry-run"]);
        expect(preview.dryRun).toBe(true);
        const afterPreview = new DatabaseSync(join(session.dataDir, "testmaster.db"), {
          readOnly: true,
        });
        try {
          expect({
            jobs: afterPreview.prepare("SELECT * FROM job_leases ORDER BY id").all(),
            runs: afterPreview.prepare("SELECT * FROM runs ORDER BY id").all(),
            events: afterPreview.prepare("SELECT * FROM outbox ORDER BY id").all(),
          }).toEqual(beforeRows);
        } finally {
          afterPreview.close();
        }
        await Promise.all([
          session.command(["worker", "reconcile"]),
          session.command(["worker", "reconcile"]),
        ]);
        const recovered = await session.observe(
          runId,
          (run) => terminal[text(run.status)] === true,
        );
        const db = new DatabaseSync(join(session.dataDir, "testmaster.db"), { readOnly: true });
        try {
          expect(
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM outbox WHERE aggregate_id=? AND type='run.completed'",
              )
              .get(runId)?.n,
          ).toBe(1);
          expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
          if (boundary === "before-publication") expect(recovered.outcome).not.toBe("passed");
        } finally {
          db.close();
        }
        session.oracles.push({
          check: boundary,
          healthy: true,
          runId,
          outcome: recovered.outcome,
          gate: recovered.gate,
        });
      }
    } finally {
      await target.close();
    }
  });
}, 300_000);

it("J17 backup during active Docker execution is coherent, incomplete objects are explicit and restore merges later revocation", async () => {
  await journey("j17-active-backup-revocation", async (session) => {
    const target = await controlledShop();
    try {
      await session.init(target.url);
      const secret = await session.command(
        [
          "secret",
          "set",
          "backup-token",
          "--from-env",
          "BACKUP_CANARY",
          "--allowed-origin",
          target.url,
        ],
        0,
        {
          BACKUP_CANARY: "tm-canary-backup-never-public",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-testmaster-bus",
        },
      );
      const test = await session.createTest(healthPlan());
      const worker = await session.worker();
      target.hold();
      const receipt = await session.command(["test", "run", text(test.id)]);
      const runId = text(receipt.runId);
      await session.observe(runId, (run) => run.status === "running");
      const active = join(session.temporary, "active-backup");
      const manifest = await session.command(["backup", "create", "--out", active]);
      expect(manifest.secretIncluded).toBe(false);
      expect(manifest.keyIds).toHaveLength(1);
      expect(manifest.configDigests).toHaveLength(1);
      expect(await readFile(join(active, "manifest.json"), "utf8")).not.toContain(
        "tm-canary-backup-never-public",
      );
      const db = new DatabaseSync(join(active, "testmaster.db"), { readOnly: true });
      try {
        expect(db.prepare("SELECT phase FROM runs WHERE id=?").get(runId)?.phase).not.toBe(
          "completed",
        );
        expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      } finally {
        db.close();
      }
      await session.command(["secret", "remove", text(secret.id)]);
      const restored = join(session.temporary, "restored");
      await session.command(["backup", "restore", active, "--out", restored]);
      const restoredDb = new DatabaseSync(join(restored, "testmaster.db"), { readOnly: true });
      try {
        expect(
          restoredDb
            .prepare("SELECT revoked_at FROM secret_references WHERE id=?")
            .get(text(secret.id))?.revoked_at,
        ).toBeTruthy();
        expect(
          restoredDb.prepare("SELECT COUNT(*) AS n FROM job_leases WHERE dispatchable=1").get()?.n,
        ).toBe(0);
      } finally {
        restoredDb.close();
      }
      target.release();
      await session.command(["run", "wait", runId, "--timeout", "120"]);
      const bundle = await session.committed(runId);
      const artifact = bundle.manifest.entries.find((entry) => entry.state === "available");
      expect(artifact).toBeDefined();
      await rm(join(bundle.directory, artifact?.relativePath ?? ""));
      const incomplete = join(session.temporary, "incomplete-backup");
      await session.command(["backup", "create", "--out", incomplete]);
      const index = object(
        JSON.parse(await readFile(join(incomplete, "evidence-index.json"), "utf8")),
      );
      expect(index.complete).toBe(false);
      expect(index.missingObjects).toContain(artifact?.artifactId);
      worker.child.kill("SIGTERM");
      await worker.result;
      session.oracles.push({
        check: "activeBackupRevocationMissingObject",
        healthy: true,
        runId,
        secretIncluded: false,
        evidenceComplete: index.complete,
      });
    } finally {
      target.release();
      await target.close();
    }
  });
}, 300_000);

it("NFR-007 real server restart retains the receipt and exactly one terminal event", async () => {
  await journey("nfr-007-server-restart", async (session) => {
    const target = await controlledShop();
    try {
      const identity = await session.init(target.url);
      const configPath = join(session.cwd, "testmaster.config.json");
      const config = object(JSON.parse(await readFile(configPath, "utf8")));
      config.artifacts = { ...object(config.artifacts), trace: "off", video: "off" };
      await writeFile(configPath, JSON.stringify(config));
      const test = await session.createTest(healthPlan());
      const start = async () => {
        const server = session.start(["server", "start", "--port", "17491"]);
        const receipt = await eventually(
          async () => {
            try {
              return data(JSON.parse(server.stdout().trim()));
            } catch {
              return {};
            }
          },
          (value) => typeof value.address === "string",
        );
        const token = (await readFile(text(receipt.tokenPath), "utf8")).trim();
        await eventually(
          () => session.command(["worker", "status"]),
          (status) =>
            items(status.items).some(
              (row) => object(row.labels).pid === String(server.child.pid) && row.state === "ready",
            ),
        );
        return {
          server,
          address: text(receipt.address),
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": "server-restart-receipt-001",
          },
        };
      };
      const first = await start();
      const response = await fetch(`${first.address}/v1/runs`, {
        method: "POST",
        headers: first.headers,
        body: JSON.stringify({ testId: test.id, environmentId: identity.environmentId }),
      });
      const responseBody = await response.json();
      expect(response.status, JSON.stringify(responseBody)).toBeLessThan(300);
      const receipt = data(responseBody);
      const runId = text(receipt.runId);
      await session.observe(runId, (run) => run.phase === "completed");
      first.server.child.kill("SIGKILL");
      expect((await first.server.result).signal).toBe("SIGKILL");
      const second = await start();
      const replay = await fetch(`${second.address}/v1/runs`, {
        method: "POST",
        headers: second.headers,
        body: JSON.stringify({ testId: test.id, environmentId: identity.environmentId }),
      });
      expect(replay.status).toBeLessThan(300);
      expect(data(await replay.json()).runId).toBe(runId);
      const db = new DatabaseSync(join(session.dataDir, "testmaster.db"), { readOnly: true });
      try {
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM outbox WHERE aggregate_id=? AND type='run.completed'",
            )
            .get(runId)?.n,
        ).toBe(1);
      } finally {
        db.close();
      }
      second.server.child.kill("SIGTERM");
      await second.server.result;
      session.oracles.push({
        check: "serverProcessRestartReceiptSingleTerminal",
        healthy: true,
        runId,
      });
    } finally {
      await target.close();
    }
  });
}, 180_000);
