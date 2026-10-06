import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { FileEvidenceStore } from "@testmaster/evidence";
import { expect, it } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";

it("streams a large authorized artifact in bounded chunks, resumes interruption, and rejects tampered resume and denied/absent artifacts distinctly", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-stream-"));
  await mkdir(join(root, "home"));
  const app = await Application.open({ cwd: root, home: join(root, "home") });
  let denied: Application | undefined;
  try {
    const init = await app.init();
    const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
    const ids = {
      workspaceId: init.workspaceId,
      runId: uuidV7IdGenerator.next("run"),
      attemptId: uuidV7IdGenerator.next("att"),
      snapshotId: uuidV7IdGenerator.next("snp"),
      revisionId: String(test.activeRevisionId),
    };
    const now = new Date().toISOString();
    app.context.entities.insert("Run", {
      id: ids.runId,
      workspaceId: ids.workspaceId,
      createdAt: now,
      testId: test.id,
      revisionId: ids.revisionId,
      environmentRevisionId: app.environments.get(init.environmentId).activeRevisionId,
      batchId: null,
      matrixCell: {},
      mode: "replay",
      phase: "completed",
      status: "passed",
      outcome: "passed",
      origin: "stream-acceptance",
      gatePolicy: {},
      gate: "passed",
      cleanupOutcome: "not_required",
      analysisStatus: "not_requested",
    });
    const jobId = uuidV7IdGenerator.next("job");
    app.database.run(
      "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,state,available_at,fence) VALUES(?,?,?,?,?,?,?,1)",
      ids.workspaceId,
      jobId,
      now,
      "execution",
      ids.runId,
      "completed",
      now,
    );
    app.context.entities.insert(
      "Attempt",
      {
        id: ids.attemptId,
        workspaceId: ids.workspaceId,
        createdAt: now,
        runId: ids.runId,
        number: 1,
        workerId: null,
        seed: 0,
        phase: "completed",
        startedAt: now,
        endedAt: now,
        outcome: "passed",
      },
      { jobId, fence: 1, leaseOwner: "stream-acceptance" },
    );
    const stage = await new FileEvidenceStore({ rootDir: app.config.dataDir }).openAttempt(ids);
    const writer = await stage.beginArtifact({
      relativePath: "large.bin",
      kind: "download",
      mimeType: "application/octet-stream",
    });
    const chunk = Buffer.alloc(128 * 1024, 0x5a);
    const digest = createHash("sha256");
    const size = 64 * 1024 * 1024;
    for (let bytes = 0; bytes < size; bytes += chunk.length) {
      await writer.write(chunk);
      digest.update(chunk);
    }
    const entry = await writer.end();
    const committed = await stage.commit({ redactionPolicyHash: "0".repeat(64) });
    app.context.entities.insert("Snapshot", {
      id: ids.snapshotId,
      workspaceId: ids.workspaceId,
      createdAt: now,
      runId: ids.runId,
      attemptId: ids.attemptId,
      revisionId: ids.revisionId,
      manifestHash: committed.manifestSha256,
      committedAt: now,
      redactionPolicyHash: "0".repeat(64),
    });
    app.context.entities.insert("Artifact", {
      id: entry.artifactId,
      workspaceId: ids.workspaceId,
      createdAt: now,
      runId: ids.runId,
      attemptId: ids.attemptId,
      revisionId: ids.revisionId,
      snapshotId: ids.snapshotId,
      kind: entry.kind,
      hash: entry.sha256,
      bytes: entry.sizeBytes,
      mime: entry.mimeType,
      redactionStatus: entry.redactionStatus,
      storageKey: `runs/${ids.workspaceId}/${ids.runId}/${ids.attemptId}/${entry.relativePath}`,
      state: entry.state,
    });
    const before = process.memoryUsage().arrayBuffers;
    let peak = before;
    let offset = 0;
    const received = createHash("sha256");
    const first = await app.artifacts.stream(entry.artifactId);
    for await (const bytes of first.stream) {
      expect(bytes.length).toBeLessThanOrEqual(128 * 1024);
      received.update(bytes);
      offset += bytes.length;
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
      if (offset >= 1024 * 1024) break;
    }
    expect(offset).toBeLessThan(size);
    const resumed = await app.artifacts.stream(entry.artifactId, {
      range: { start: offset, end: size - 1 },
    });
    for await (const bytes of resumed.stream) {
      expect(bytes.length).toBeLessThanOrEqual(128 * 1024);
      received.update(bytes);
      offset += bytes.length;
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    }
    expect(offset).toBe(size);
    expect(received.digest("hex")).toBe(digest.digest("hex"));
    // ArrayBuffer memory directly detects accidental 64 MiB readFile/concat buffering.
    expect(peak - before).toBeLessThan(16 * 1024 * 1024);
    await expect(app.artifacts.stream(uuidV7IdGenerator.next("art"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    denied = await Application.open({
      cwd: root,
      home: join(root, "home"),
      identity: { principalId: init.principalId, scopes: [] },
    });
    await expect(denied.artifacts.stream(entry.artifactId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await writeFile(join(committed.bundleDir, "large.bin"), "tampered-after-interruption");
    await expect(
      app.artifacts.stream(entry.artifactId, { range: { start: 1024, end: 2047 } }),
    ).rejects.toThrow("hash/size mismatch");
  } finally {
    denied?.close();
    app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

it("audits raw evidence denials and authorized exports with scoped grants and production-bound approvals", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-raw-audit-"));
  await mkdir(join(root, "home"));
  const app = await Application.open({ cwd: root, home: join(root, "home"), env: {} });
  try {
    const init = await app.init();
    const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
    const production = app.environments.create({
      projectId: init.projectId,
      name: "production",
      baseUrl: "https://shop.example",
      production: true,
    });
    for (const environment of [app.environments.get(init.environmentId), production]) {
      const ids = {
        workspaceId: init.workspaceId,
        runId: uuidV7IdGenerator.next("run"),
        attemptId: uuidV7IdGenerator.next("att"),
        snapshotId: uuidV7IdGenerator.next("snp"),
        revisionId: String(test.activeRevisionId),
      };
      const now = new Date().toISOString();
      app.context.entities.insert("Run", {
        id: ids.runId,
        workspaceId: ids.workspaceId,
        createdAt: now,
        testId: test.id,
        revisionId: ids.revisionId,
        environmentRevisionId: environment.activeRevisionId,
        batchId: null,
        matrixCell: {},
        mode: "replay",
        phase: "completed",
        status: "passed",
        outcome: "passed",
        origin: "raw-audit-acceptance",
        gatePolicy: {},
        gate: "passed",
        cleanupOutcome: "not_required",
        analysisStatus: "not_requested",
      });
      const jobId = uuidV7IdGenerator.next("job");
      app.database.run(
        "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,state,available_at,fence) VALUES(?,?,?,?,?,?,?,1)",
        ids.workspaceId,
        jobId,
        now,
        "execution",
        ids.runId,
        "completed",
        now,
      );
      app.context.entities.insert(
        "Attempt",
        {
          id: ids.attemptId,
          workspaceId: ids.workspaceId,
          createdAt: now,
          runId: ids.runId,
          number: 1,
          workerId: null,
          seed: 0,
          phase: "completed",
          startedAt: now,
          endedAt: now,
          outcome: "passed",
        },
        { jobId, fence: 1, leaseOwner: "raw-audit-acceptance" },
      );
      const stage = await new FileEvidenceStore({ rootDir: app.config.dataDir }).openAttempt(ids);
      const writer = await stage.beginArtifact({
        relativePath: "restricted.bin",
        kind: "trace",
        mimeType: "application/octet-stream",
        sensitivity: "restricted",
      });
      await writer.write(Buffer.from("RAW-CANARY"));
      const entry = await writer.end();
      const committed = await stage.commit({ redactionPolicyHash: "0".repeat(64) });
      app.context.entities.insert("Snapshot", {
        id: ids.snapshotId,
        workspaceId: ids.workspaceId,
        createdAt: now,
        runId: ids.runId,
        attemptId: ids.attemptId,
        revisionId: ids.revisionId,
        manifestHash: committed.manifestSha256,
        committedAt: now,
        redactionPolicyHash: "0".repeat(64),
      });
      app.context.entities.insert("Artifact", {
        id: entry.artifactId,
        workspaceId: ids.workspaceId,
        createdAt: now,
        runId: ids.runId,
        attemptId: ids.attemptId,
        revisionId: ids.revisionId,
        snapshotId: ids.snapshotId,
        kind: entry.kind,
        hash: entry.sha256,
        bytes: entry.sizeBytes,
        mime: entry.mimeType,
        redactionStatus: entry.redactionStatus,
        state: entry.state,
        storageKey: `runs/${ids.workspaceId}/${ids.runId}/${ids.attemptId}/${entry.relativePath}`,
      });
      const reader = app.withIdentity({ principalId: init.principalId, scopes: ["R"] });
      await expect(reader.artifacts.read(ids.runId, "restricted.bin")).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        reader.artifacts.get(ids.runId, {
          out: join(root, `${ids.runId}-reader`),
          allowRestrictedRaw: true,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        app.artifacts.get(ids.runId, { out: join(root, `${ids.runId}-implicit`) }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const raw = app.withIdentity({
        principalId: init.principalId,
        scopes: ["R"],
        grants: [
          {
            resourceType: "Artifact",
            actions: ["raw"],
            projectIds: [init.projectId],
            environmentIds: [environment.id],
            expiresAt: null,
            grantedBy: init.principalId,
          },
        ],
      });
      const deniedGrant = app.withIdentity({
        principalId: init.principalId,
        scopes: ["R"],
        grants: [
          {
            resourceType: "Artifact",
            actions: ["raw"],
            projectIds: [init.projectId],
            environmentIds: [environment.id],
            expiresAt: null,
            grantedBy: init.principalId,
          },
          {
            resourceType: "Artifact",
            actions: ["raw"],
            projectIds: [init.projectId],
            environmentIds: [environment.id],
            expiresAt: null,
            grantedBy: init.principalId,
            deny: true,
          },
        ],
      });
      await expect(
        deniedGrant.artifacts.stream(entry.artifactId, { allowRestrictedRaw: true }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const membership = app.database.get(
        "SELECT id,data_json FROM memberships WHERE principal_id=?",
        init.principalId,
      );
      if (!membership) throw new Error("Membership missing");
      const member = JSON.parse(String(membership.data_json));
      app.context.entities.update(
        "Membership",
        init.workspaceId,
        String(membership.id),
        member.version,
        { ...member, role: "viewer", version: member.version + 1 },
      );
      await expect(
        raw.artifacts.stream(entry.artifactId, { allowRestrictedRaw: true }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      app.context.entities.update(
        "Membership",
        init.workspaceId,
        String(membership.id),
        member.version + 1,
        { ...member, version: member.version + 2 },
      );
      const env = app.context.entities.get(
        "EnvironmentRevision",
        init.workspaceId,
        String(environment.activeRevisionId),
      );
      if (!env) throw new Error("Expected environment revision");
      app.config.effectiveConfig.config.artifacts = {
        trace: "off",
        video: "off",
        httpBodies: "on",
        retentionDays: 30,
      };
      const request = { testId: test.id, environmentId: environment.id };
      const noCaptureGrant = app.withIdentity({
        principalId: init.principalId,
        scopes: ["R", "X"],
      });
      expect(() => noCaptureGrant.runs.prepare(request)).toThrow("artifacts:raw");
      if (env.production)
        expect(() => app.runs.prepare(request)).toThrow("matching current approval");
      let approvalId: string | undefined;
      if (env.production) {
        await expect(
          raw.artifacts.get(ids.runId, {
            out: join(root, `${ids.runId}-unapproved`),
            allowRestrictedRaw: true,
          }),
        ).rejects.toMatchObject({ code: "POLICY_DENIED" });
        const binding = {
          actionSet: ["artifacts:raw"],
          revisionHash: app.revisions.get(ids.revisionId).contentHash,
          environmentRevisionId: env.id,
          originSet: env.targetOrigins as string[],
          policyHash: app.config.effectiveConfig.policyHash,
        };
        const wrong = app.approvals.create({ ...binding, policyHash: "f".repeat(64) });
        await expect(
          raw.artifacts.get(ids.runId, {
            out: join(root, `${ids.runId}-wrong`),
            allowRestrictedRaw: true,
            approvalId: wrong.id,
          }),
        ).rejects.toMatchObject({ code: "POLICY_DENIED" });
        approvalId = app.approvals.create(binding).id;
        expect(() => app.runs.prepare(request)).not.toThrow();
      }
      const out = join(root, `${ids.runId}-authorized`);
      await raw.artifacts.get(ids.runId, {
        out,
        allowRestrictedRaw: true,
        ...(approvalId ? { approvalId } : {}),
      });
      expect(await readFile(join(out, "restricted.bin"), "utf8")).toBe("RAW-CANARY");
      const ledger = app.database.all("SELECT actor,action,data_json FROM audit_events");
      for (const action of [
        "artifact.raw.denied",
        "artifact.raw.allowed",
        "artifact.export.denied",
        "artifact.export.allowed",
      ])
        expect(ledger.some((row) => row.action === action && row.actor === init.principalId)).toBe(
          true,
        );
      expect(JSON.stringify(ledger)).not.toContain("RAW-CANARY");
    }
  } finally {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});
