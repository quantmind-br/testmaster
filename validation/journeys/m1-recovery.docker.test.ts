import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  controlledShop,
  data,
  eventually,
  healthPlan,
  items,
  journey,
  object,
  signalReady,
  terminal,
  text,
} from "./harness.js";

const exec = promisify(execFile);

it("J17 persistent receipt survives a killed waiting client; killed worker reconciles its attempt without a false pass", async () => {
  await journey("j17-worker-recovery", async (session) => {
    const target = await controlledShop();
    try {
      await session.init(target.url);
      const test = await session.createTest(healthPlan());
      const worker = await session.worker();
      target.hold();
      const receipt = await session.command(["test", "run", text(test.id)]);
      expect(receipt.ownership).toBe("worker");
      const runId = text(receipt.runId);
      await session.observe(runId, (run) => run.status === "running");
      const client = session.start(["run", "wait", runId, "--timeout", "120"]);
      await signalReady(client);
      await eventually(
        async () => target.hits(),
        (hits) => hits > 0,
      );
      client.child.kill("SIGKILL");
      const killed = await client.result;
      expect(killed.signal).toBe("SIGKILL");
      expect((await session.current(runId)).outcome).toBeNull();
      target.release();
      const resumed = await session.command(["run", "wait", runId, "--timeout", "120"]);
      expect(resumed.id ?? resumed.runId).toBe(runId);
      expect(resumed.outcome).toBe("passed");
      session.oracles.push({
        check: "durableWorkerClientKill",
        healthy: true,
        runId,
        killedClientSignal: killed.signal,
      });

      target.hold();
      const lost = await session.command(["test", "run", text(test.id)]);
      const lostId = text(lost.runId);
      await session.observe(lostId, (run) => run.status === "running");
      const container = await eventually(
        async () => {
          const result = await exec("docker", [
            "ps",
            "-q",
            "--filter",
            `label=io.testmaster.run=${lostId}`,
          ]);
          return result.stdout.trim();
        },
        (ids) => ids.length > 0,
      );
      const { stdout: inspection } = await exec("docker", [
        "inspect",
        container.split("\n")[0] as string,
      ]);
      const facts = items(JSON.parse(inspection))[0];
      const attemptId = text(object(object(object(facts).Config).Labels)["io.testmaster.attempt"]);
      worker.child.kill("SIGKILL");
      expect((await worker.result).signal).toBe("SIGKILL");
      expect((await session.current(lostId)).gate).not.toBe("passed");
      const replacement = await session.worker();
      const recovered = await session.observe(
        lostId,
        (run) => terminal[text(run.status)] === true,
        100_000,
      );
      expect(recovered.id ?? recovered.runId).toBe(lostId);
      expect(recovered.outcome).not.toBe("passed");
      expect(recovered.gate).not.toBe("passed");
      const events = await session.start(["run", "events", lostId, "--format", "ndjson"]).result;
      expect(events.exitCode).toBe(0);
      const eventRows = events.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => object(JSON.parse(line)));
      expect(eventRows.length).toBeGreaterThan(0);
      expect(JSON.stringify(eventRows)).toContain(attemptId);
      expect(JSON.stringify(eventRows)).toMatch(/lease|lost|reconcil|orphan|inconclusive|blocked/i);
      const { stdout: remaining } = await exec("docker", [
        "ps",
        "-q",
        "--filter",
        `label=io.testmaster.run=${lostId}`,
      ]);
      expect(remaining.trim()).toBe("");
      session.oracles.push({
        check: "workerAttemptReconciliation",
        healthy: true,
        runId: lostId,
        attemptId,
        outcome: recovered.outcome,
        gate: recovered.gate,
      });
      target.release();
      replacement.child.kill("SIGTERM");
      await replacement.result;
    } finally {
      target.release();
      await target.close();
    }
  });
}, 300_000);

it("J17 backup restores to an isolated suspended destination with retained identities and no replayed effects", async () => {
  await journey("j17-backup-restore", async (session) => {
    const target = await controlledShop();
    try {
      const identity = await session.init(target.url);
      const test = await session.createTest(healthPlan());
      const completed = await session.command([
        "test",
        "run",
        text(test.id),
        "--wait",
        "--timeout",
        "120",
      ]);
      const run = object(completed.run);
      const runId = text(run.id ?? object(completed.receipt).runId);
      const originalBundle = await session.command(["artifact", "get", runId]);
      const backupPath = join(session.temporary, "backup");
      await session.command(["backup", "create", "--out", backupPath]);
      const isolated = join(session.temporary, "restored-data");
      const restoration = await session.command([
        "backup",
        "restore",
        backupPath,
        "--out",
        isolated,
      ]);
      expect(restoration.requiresOperatorReview).toBe(true);
      expect(restoration.destination ?? restoration.out).toBe(isolated);
      const restoredRepo = join(session.temporary, "restored-repo");
      await mkdir(restoredRepo);
      const env = { TESTMASTER_DATA_DIR: isolated };
      const hits = target.hits();
      const retained = await session.command(["run", "get", runId], 0, env, restoredRepo);
      expect(retained.id ?? retained.runId).toBe(runId);
      expect(retained.revisionId).toBe(run.revisionId);
      expect(retained.outcome).toBe(run.outcome);
      const project = await session.command(
        ["project", "get", text(identity.projectId)],
        0,
        env,
        restoredRepo,
      );
      expect(project.id).toBe(identity.projectId);
      const retainedTest = await session.command(
        ["test", "get", text(test.id)],
        0,
        env,
        restoredRepo,
      );
      expect(retainedTest.activeRevisionId).toBe(test.activeRevisionId);
      const restoredBundle = await session.command(
        ["artifact", "get", runId],
        0,
        env,
        restoredRepo,
      );
      expect(object(restoredBundle.meta).manifestHash).toBe(
        object(originalBundle.meta).manifestHash,
      );
      const restoredDatabase = new DatabaseSync(join(isolated, "testmaster.db"), {
        readOnly: true,
      });
      try {
        expect(
          restoredDatabase
            .prepare("SELECT value FROM operational_state WHERE key='admission'")
            .get()?.value,
        ).toBe("suspended_restore");
        expect(
          restoredDatabase
            .prepare("SELECT count(*) AS n FROM job_leases WHERE dispatchable=1")
            .get()?.n,
        ).toBe(0);
        expect(
          restoredDatabase.prepare("SELECT count(*) AS n FROM outbox WHERE dispatchable=1").get()
            ?.n,
        ).toBe(0);
      } finally {
        restoredDatabase.close();
      }
      const suspended = await session.start(
        ["test", "run", text(test.id), "--env", text(identity.environmentId), "--wait"],
        env,
        restoredRepo,
      ).result;
      expect(suspended.exitCode).toBe(6);
      expect(suspended.json).toBeDefined();
      expect(target.hits()).toBe(hits);
      expect((await session.current(runId)).outcome).toBe(run.outcome);
      session.oracles.push({
        check: "isolatedRestoreRetainsIdsWithoutEffects",
        healthy: true,
        runId,
        workspaceId: identity.workspaceId,
        projectId: identity.projectId,
        originalHash: object(originalBundle.meta).manifestHash,
        targetRequestsAfterRestore: target.hits() - hits,
      });
    } finally {
      await target.close();
    }
  });
}, 300_000);

it("CLI-001 timeout, graceful signal and partially admitted batch remain one parseable JSON document", async () => {
  await journey("cli-001-interruption", async (session) => {
    const target = await controlledShop();
    try {
      await session.init(target.url);
      const test = await session.createTest(healthPlan());
      const worker = await session.worker();
      target.hold();
      const receipt = await session.command(["test", "run", text(test.id)]);
      const runId = text(receipt.runId);
      await session.observe(runId, (run) => run.status === "running");
      const timeout = await session.command(["run", "wait", runId, "--timeout", "0.1"], 7);
      expect(object(timeout.error).details).toBeDefined();
      expect((await session.current(runId)).outcome).toBeNull();
      const waiting = session.start(["run", "wait", runId, "--timeout", "120"]);
      await signalReady(waiting);
      await eventually(
        async () => (await session.current(runId)).status,
        (status) => status === "running",
      );
      waiting.child.kill("SIGINT");
      const interrupted = await waiting.result;
      expect(interrupted.exitCode).toBe(130);
      expect(interrupted.json).toBeDefined();
      expect(JSON.stringify(interrupted.json)).toContain(runId);
      expect((await session.current(runId)).outcome).toBeNull();
      target.release();
      await session.command(["run", "wait", runId, "--timeout", "120"]);
      const absent = "tst_00000000-0000-4000-8000-000000000000";
      const partial = await session.start([
        "test",
        "run",
        text(test.id),
        absent,
        "--partial-dispatch",
        "--wait",
        "--timeout",
        "120",
      ]).result;
      expect(partial.exitCode).not.toBe(0);
      expect(partial.json).toBeDefined();
      const partialEnvelope = object(partial.json);
      const partialData = partialEnvelope.data
        ? data(partialEnvelope)
        : object(object(partialEnvelope.error).details);
      const partialReceipt = object(partialData.receipt ?? partialData);
      expect(partialReceipt.requested).toBe(2);
      expect(partialReceipt.accepted).toBe(1);
      expect(items(partialReceipt.notDispatched)).toHaveLength(1);
      expect(items(partialReceipt.memberRuns)).toHaveLength(1);
      expect(partialReceipt.gate).not.toBe("passed");
      session.oracles.push({
        check: "timeoutSignalPartialBatchJson",
        healthy: true,
        runId,
        timeoutExit: 7,
        signalExit: interrupted.exitCode,
        batchExit: partial.exitCode,
      });
      worker.child.kill("SIGTERM");
      await worker.result;

      target.hold();
      const ephemeral = session.start(["test", "run", text(test.id), "--wait", "--timeout", "120"]);
      const listed = await eventually(
        () => session.command(["run", "list"]),
        (list) => items(list.items).some((run) => run.status === "running"),
      );
      const ephemeralId = text(items(listed.items).find((run) => run.status === "running")?.id);
      ephemeral.child.kill("SIGTERM");
      const ephemeralResult = await ephemeral.result;
      expect(ephemeralResult.exitCode).toBe(143);
      expect(ephemeralResult.json).toBeDefined();
      expect(JSON.stringify(ephemeralResult.json)).toContain("ephemeral");
      const cancelled = await session.observe(
        ephemeralId,
        (run) => terminal[text(run.status)] === true,
      );
      expect(cancelled.gate).not.toBe("passed");
      const { stdout: containers } = await exec("docker", [
        "ps",
        "-q",
        "--filter",
        `label=io.testmaster.run=${ephemeralId}`,
      ]);
      expect(containers.trim()).toBe("");
      session.oracles.push({
        check: "ephemeralSignalWaitsForCleanup",
        healthy: true,
        runId: ephemeralId,
        signalExit: ephemeralResult.exitCode,
        outcome: cancelled.outcome,
        survivingContainers: 0,
      });
    } finally {
      target.release();
      await target.close();
    }
  });
}, 300_000);
