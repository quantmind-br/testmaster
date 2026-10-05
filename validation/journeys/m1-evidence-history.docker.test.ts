import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { controlledShop, healthPlan, items, journey, object, text } from "./harness.js";

it("J17/J06 expiry and stale context are read-time views, and foreign snapshot evidence cannot validate the old run", async () => {
  await journey("j17-evidence-history", async (session) => {
    const target = await controlledShop();
    try {
      const identity = await session.init(target.url);
      const test = await session.createTest(healthPlan());
      const execution = await session.command([
        "test",
        "run",
        text(test.id),
        "--wait",
        "--timeout",
        "120",
      ]);
      const run = object(execution.run);
      const runId = text(run.id);
      expect(run.outcome).toBe("passed");
      const committed = await session.committed(runId);
      const sealedManifest = await readFile(join(committed.directory, "manifest.json"));
      const sealedMeta = await readFile(join(committed.directory, "meta.json"));
      const databasePath = join(session.dataDir, "testmaster.db");
      const history = () => {
        const db = new DatabaseSync(databasePath, { readOnly: true });
        try {
          return {
            run: db.prepare("SELECT * FROM runs WHERE id=?").get(runId),
            snapshots: db.prepare("SELECT * FROM snapshots WHERE run_id=? ORDER BY id").all(runId),
            audit: db.prepare("SELECT * FROM audit_events ORDER BY rowid").all(),
          };
        } finally {
          db.close();
        }
      };
      const before = history();
      const report = async (name: string) => {
        const out = join(session.cwd, `${name}.json`);
        await session.command(["report", "export", runId, "--format", "json", "--out", out]);
        return object(JSON.parse(await readFile(out, "utf8")));
      };
      expect(object(items((await report("original")).runs)[0]?.freshness).state).toBe("current");

      // Use two real committed executions; replace the complete identity seal, not just corrupt bytes.
      const foreignExecution = await session.command([
        "test",
        "run",
        text(test.id),
        "--wait",
        "--timeout",
        "120",
      ]);
      const foreignRunId = text(object(foreignExecution.run).id);
      const foreign = await session.committed(foreignRunId);
      try {
        await writeFile(
          join(committed.directory, "manifest.json"),
          await readFile(join(foreign.directory, "manifest.json")),
        );
        await writeFile(
          join(committed.directory, "meta.json"),
          await readFile(join(foreign.directory, "meta.json")),
        );
        const rejected = await session.start([
          "artifact",
          "get",
          runId,
          "--out",
          join(session.cwd, "foreign-download"),
        ]).result;
        expect(rejected.exitCode).not.toBe(0);
        expect(object(rejected.json).error).toBeDefined();
        session.oracles.push({
          check: "foreignSnapshotDenied",
          healthy: true,
          runId,
          foreignRunId,
          exitCode: rejected.exitCode,
        });
      } finally {
        await writeFile(join(committed.directory, "manifest.json"), sealedManifest);
        await writeFile(join(committed.directory, "meta.json"), sealedMeta);
      }
      await session.command(["artifact", "get", runId]);

      // Advance only the maintenance process's clock. No production clock flag or historical row mutation.
      const clock = join(session.temporary, "retention-clock.mjs");
      await writeFile(clock, `const now=Date.now();Date.now=()=>now+31*86400000;`);
      const maintenance = await session.command(["worker", "reconcile"], 0, {
        NODE_OPTIONS: `--import=${clock}`,
      });
      const expired = await session.command([
        "artifact",
        "get",
        runId,
        "--out",
        join(session.cwd, "expired-download"),
      ]);
      const expiredEntries = items(object(expired.manifest).entries);
      expect(
        expiredEntries.some(
          (entry) => entry.state === "expired" && entry.omissionReason === "artifact_expired",
        ),
      ).toBe(true);
      const partial = await report("expired");
      expect(partial.completeness).toMatchObject({
        state: "partial",
        reasons: expect.arrayContaining(["artifact_expired"]),
      });
      expect(object(items(partial.runs)[0]?.result).outcome).toBe("passed");
      const afterExpiry = history();
      expect(afterExpiry.run).toEqual(before.run);
      expect(afterExpiry.snapshots).toEqual(before.snapshots);
      expect(afterExpiry.audit.slice(0, before.audit.length)).toEqual(before.audit);
      expect(
        afterExpiry.audit
          .slice(before.audit.length)
          .some((row) => String(row.action).startsWith("artifact.")),
      ).toBe(true);
      expect(await readFile(join(committed.directory, "manifest.json"))).toEqual(sealedManifest);
      expect(await readFile(join(committed.directory, "meta.json"))).toEqual(sealedMeta);

      const environment = await session.command(["env", "get", text(identity.environmentId)]);
      const nextEnvironment = await session.command([
        "env",
        "update",
        text(environment.id),
        "--locale",
        "en-US",
        "--expected-version",
        String(environment.version),
      ]);
      const candidate = await session.command([
        "test",
        "revision",
        "create",
        text(test.id),
        "--plan",
        await session.plan(healthPlan("degraded"), "changed-source.json"),
        "--parent",
        text(run.revisionId),
      ]);
      const current = await session.command(["test", "get", text(test.id)]);
      await session.command([
        "test",
        "revision",
        "promote",
        text(candidate.id),
        "--expected-version",
        String(current.version),
      ]);
      const stale = await report("stale");
      const staleRun = object(items(stale.runs)[0]);
      expect(staleRun.freshness).toMatchObject({
        state: "stale",
        reasons: ["test_revision_changed", "environment_revision_changed"],
        currentRevisionId: candidate.id,
        currentEnvironmentRevisionId: nextEnvironment.activeRevisionId,
      });
      expect(staleRun.run).toMatchObject({
        revisionId: run.revisionId,
        environmentRevisionId: run.environmentRevisionId,
      });
      expect(staleRun.snapshot).toEqual(object(items(partial.runs)[0]?.snapshot));
      expect(staleRun.result).toEqual(object(items(partial.runs)[0]?.result));
      expect((await session.current(runId)).outcome).toBe("passed");
      const afterContext = history();
      expect(afterContext.run).toEqual(before.run);
      expect(afterContext.snapshots).toEqual(before.snapshots);
      expect(afterContext.audit.slice(0, afterExpiry.audit.length)).toEqual(afterExpiry.audit);
      expect(await readFile(join(committed.directory, "manifest.json"))).toEqual(sealedManifest);
      expect(await readFile(join(committed.directory, "meta.json"))).toEqual(sealedMeta);
      session.oracles.push({
        check: "retentionAndStaleContextPreserveHistory",
        healthy: true,
        runId,
        maintenance,
        expiredArtifactIds: expiredEntries
          .filter((entry) => entry.state === "expired")
          .map((entry) => entry.artifactId),
        completeness: stale.completeness,
        freshness: staleRun.freshness,
        originalOutcome: run.outcome,
        sealedMetadataUnchanged: true,
        historicalAuditPrefixUnchanged: true,
      });
    } finally {
      await target.close();
    }
  });
}, 180_000);
