import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Application } from "@testmaster/application";
import { describe, expect, it } from "vitest";
import { controlledShop, eventually, healthPlan, journey, object, text } from "./harness.js";

describe("M3 requested deletion persistence", () => {
  it("resumes a held requested deletion after worker process death without changing historical execution", async () => {
    const shop = await controlledShop();
    try {
      await journey("m3-deletion-restart-acceptance", async (session) => {
        await session.init(shop.url);
        const test = await session.createTest(healthPlan());
        const receipt = await session.command([
          "test",
          "run",
          text(test.id),
          "--wait",
          "--timeout",
          "120",
        ]);
        const runId = text(object(receipt.run).id);
        const bundle = await session.committed(runId);
        const artifact = bundle.manifest.entries.find(
          (entry) => entry.state === "available" && !entry.kind.startsWith("restrictedRaw."),
        );
        if (!artifact) throw new Error("Real execution produced no readable artifact");
        let app = await Application.open({
          cwd: session.cwd,
          home: session.home,
          env: session.env,
        });
        try {
          const stream = await app.artifacts.stream(artifact.artifactId);
          let size = 0;
          for await (const bytes of stream.stream) size += bytes.length;
          expect(size).toBe(artifact.sizeBytes);
          const runBefore = app.database.get(
            "SELECT data_json FROM runs WHERE id=?",
            runId,
          )?.data_json;
          const attemptsBefore = app.database.all(
            "SELECT data_json FROM attempts WHERE run_id=? ORDER BY number",
            runId,
          );
          const file = join(bundle.directory, artifact.relativePath);
          expect((await readFile(file)).byteLength).toBe(artifact.sizeBytes);
          const hold = `retention:legal-hold:${app.context.workspaceId}:${artifact.artifactId}`;
          app.database.run("INSERT INTO operational_state(key,value) VALUES(?,'held')", hold);
          const operation = await session.command([
            "artifact",
            "delete",
            artifact.artifactId,
            "--confirm",
            artifact.artifactId,
          ]);
          const id = text(operation.id);
          expect(operation).toMatchObject({
            physicalState: "pending",
            physicalDeletionDeadlineAt: null,
            backupExpiryDeadlineAt: null,
          });
          expect(operation.backupHolds).toContain(hold);
          expect(app.retention.requestDeletion(artifact.artifactId).id).toBe(id);
          await expect(app.artifacts.stream(artifact.artifactId)).rejects.toMatchObject({
            code: "NOT_FOUND",
          });
          const worker = await session.worker();
          expect(app.retention.deletionStatus(id).physicalState).toBe("pending");
          expect((await readFile(file)).byteLength).toBe(artifact.sizeBytes);
          worker.child.kill("SIGKILL");
          expect((await worker.result).signal).toBe("SIGKILL");
          app.close();
          app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
          expect(app.retention.deletionStatus(id).physicalState).toBe("pending");
          app.database.run("UPDATE operational_state SET value='released' WHERE key=?", hold);
          const released = await session.command(["artifact", "deletion-status", id]);
          expect(
            Date.parse(text(released.physicalDeletionDeadlineAt)) -
              Date.parse(text(operation.revokedAt)),
          ).toBe(86400000);
          expect(released.backupHolds).toEqual([]);
          const restarted = await session.worker();
          await eventually(
            async () => app.retention.deletionStatus(id),
            (status) => status.physicalState === "completed",
          );
          expect((await session.command(["artifact", "deletion-status", id])).physicalState).toBe(
            "completed",
          );
          await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(app.artifacts.stream(artifact.artifactId)).rejects.toMatchObject({
            code: "NOT_FOUND",
          });
          expect(app.database.get("SELECT data_json FROM runs WHERE id=?", runId)?.data_json).toBe(
            runBefore,
          );
          expect(
            app.database.all(
              "SELECT data_json FROM attempts WHERE run_id=? ORDER BY number",
              runId,
            ),
          ).toEqual(attemptsBefore);
          restarted.child.kill("SIGTERM");
          await restarted.result;
          session.oracles.push({
            deletionOperationId: id,
            healthyBytes: size,
            restartedPhysicalState: app.retention.deletionStatus(id).physicalState,
            immutableRun: true,
          });
        } finally {
          app.close();
        }
      });
    } finally {
      await shop.close();
    }
  }, 240000);

  it("restores pre-deletion evidence without resurrecting deleted artifacts or revoked secrets and reports separate backup expiry", async () => {
    const shop = await controlledShop();
    try {
      await journey("m3-deletion-secret-restore-acceptance", async (session) => {
        await session.init(shop.url);
        const test = await session.createTest(healthPlan());
        const receipt = await session.command([
          "test",
          "run",
          text(test.id),
          "--wait",
          "--timeout",
          "120",
        ]);
        const runId = text(object(receipt.run).id);
        const bundle = await session.committed(runId);
        const artifact = bundle.manifest.entries.find(
          (entry) => entry.state === "available" && !entry.kind.startsWith("restrictedRaw."),
        );
        if (!artifact) throw new Error("Real execution produced no artifact");
        const app = await Application.open({
          cwd: session.cwd,
          home: session.home,
          env: session.env,
        });
        let restored: Application | undefined;
        try {
          const secret = await app.secrets.set("restore-secret", "synthetic-revoked-secret", {
            ephemeral: true,
            allowedOrigins: [new URL(shop.url).origin],
          });
          expect(await (await app.secrets.release(secret.id)).resolve()).toBe(
            "synthetic-revoked-secret",
          );
          const readable = await app.artifacts.stream(artifact.artifactId);
          for await (const _bytes of readable.stream) {
            /* Complete the positive read. */
          }
          const backup = join(session.temporary, "before-delete-revoke");
          await app.backups.create(backup);
          await app.secrets.remove(secret.id);
          const operation = app.retention.requestDeletion(artifact.artifactId);
          const holds = app.database.all<{ expires_at: string }>(
            "SELECT expires_at FROM backup_object_holds WHERE artifact_id=? ORDER BY expires_at",
            artifact.artifactId,
          );
          expect(holds).toHaveLength(1);
          expect(operation).toMatchObject({
            physicalState: "pending",
            physicalDeletionDeadlineAt: null,
            backupExpiryDeadlineAt: holds.at(-1)!.expires_at,
          });
          expect(
            Date.parse(operation.backupExpiryDeadlineAt!) - Date.parse(operation.revokedAt),
          ).toBeGreaterThan(0);
          expect(
            Date.parse(operation.backupExpiryDeadlineAt!) - Date.parse(operation.revokedAt),
          ).toBeLessThanOrEqual(86400000);
          await app.retention.maintenance();
          expect(app.retention.deletionStatus(operation.id).physicalState).toBe("pending");
          expect((await readFile(join(bundle.directory, artifact.relativePath))).byteLength).toBe(
            artifact.sizeBytes,
          );
          const result = await app.backups.restore(backup, join(session.temporary, "restored"));
          restored = await Application.open({
            cwd: session.cwd,
            home: session.home,
            env: { ...session.env, TESTMASTER_DATA_DIR: result.out },
          });
          expect(restored.secrets.get(secret.id).revokedAt).not.toBeNull();
          await expect(restored.secrets.release(secret.id)).rejects.toMatchObject({
            code: "POLICY_DENIED",
          });
          await expect(restored.artifacts.stream(artifact.artifactId)).rejects.toMatchObject({
            code: "NOT_FOUND",
          });
          expect(restored.retention.deletionStatus(operation.id)).toMatchObject({
            id: operation.id,
            revokedAt: operation.revokedAt,
            physicalState: "pending",
            backupExpiryDeadlineAt: operation.backupExpiryDeadlineAt,
          });
          expect(
            restored.database.get("SELECT value FROM operational_state WHERE key='admission'")
              ?.value,
          ).toBe("suspended_restore");
          session.oracles.push({
            deletionOperationId: operation.id,
            backupExpiryDeadlineAt: operation.backupExpiryDeadlineAt,
            restoredArtifactReadable: false,
            restoredSecretRevoked: true,
          });
        } finally {
          restored?.close();
          app.close();
        }
      });
    } finally {
      await shop.close();
    }
  }, 240000);
});
