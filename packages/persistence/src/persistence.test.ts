import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { uuidV7IdGenerator } from "@testmaster/domain";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { constraintErrorClass, constraintFixtures, constraintSeed } from "./constraint-fixtures.js";
import {
  fileSha256,
  loadMigrations,
  MigrationChecksumError,
  PersistenceDatabase,
} from "./database.js";
import {
  AuditRepository,
  EntityRepository,
  ExecutionRepository,
  IdempotencyRepository,
  LeaseRepository,
  OutboxRepository,
  StaleFenceError,
} from "./repositories.js";
import { SqliteBudgetLedger, SqliteConsentStore, SqliteModelCallRecorder } from "./usage.js";

const directories: string[] = [];
const connections: PersistenceDatabase[] = [];
afterEach(async () => {
  for (const db of connections.splice(0)) if (db.db.isOpen) db.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function createDatabase(): Promise<PersistenceDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "tm-persistence-"));
  directories.push(dir);
  const db = await PersistenceDatabase.open(join(dir, "testmaster.db"));
  connections.push(db);
  return db;
}
async function createSeeded(): Promise<{
  db: PersistenceDatabase;
  ws: string;
  project: string;
  run: string;
  revision: string;
  environmentRevision: string;
}> {
  const db = await createDatabase();
  const entities = new EntityRepository(db);
  const ws = uuidV7IdGenerator.next("ws");
  const project = uuidV7IdGenerator.next("prj");
  const test = uuidV7IdGenerator.next("tst");
  const revision = uuidV7IdGenerator.next("rev");
  const environment = uuidV7IdGenerator.next("env");
  const environmentRevision = uuidV7IdGenerator.next("evr");
  const run = uuidV7IdGenerator.next("run");
  db.withTx(() => {
    entities.insert("Workspace", {
      workspaceId: ws,
      id: ws,
      name: "Local",
      mode: "single-user",
      settingsVersion: 1,
      quotaPolicyId: "local",
    });
    entities.insert("Project", {
      workspaceId: ws,
      id: project,
      name: "Project",
      slug: "project",
      defaultEnvironmentId: null,
      archivedAt: null,
    });
    entities.insert("Environment", {
      workspaceId: ws,
      id: environment,
      projectId: project,
      name: "local",
      activeRevisionId: environmentRevision,
      archivedAt: null,
    });
    entities.insert(
      "EnvironmentRevision",
      {
        workspaceId: ws,
        id: environmentRevision,
        targetOrigins: ["http://127.0.0.1:3000"],
        networkProfile: "local-loopback",
        authProfileRefs: [],
        locale: "en-US",
        timezone: "UTC",
        variables: {},
        production: false,
      },
      { environmentId: environment },
    );
    entities.insert("TestCase", {
      workspaceId: ws,
      id: test,
      projectId: project,
      name: "health",
      activeRevisionId: revision,
      tags: [],
      priority: "normal",
      archivedAt: null,
    });
    entities.insert("TestRevision", {
      workspaceId: ws,
      id: revision,
      testId: test,
      ordinal: 1,
      contentHash: "a".repeat(64),
      plan: null,
      codeArtifactId: null,
      runnerKind: "http",
      author: "local",
      parentId: null,
      origin: "manual",
    });
    entities.insert("Run", {
      workspaceId: ws,
      id: run,
      testId: test,
      revisionId: revision,
      environmentRevisionId: environmentRevision,
      batchId: null,
      matrixCell: {},
      mode: "replay",
      phase: "queued",
      status: "queued",
      outcome: null,
      origin: "manual",
      gatePolicy: {},
      gate: "pending",
      cleanupOutcome: "not_required",
      analysisStatus: "not_requested",
    });
    new LeaseRepository(db).enqueue(ws, run, "http");
  });
  return { db, ws, project, run, revision, environmentRevision };
}
function child(script: string, args: string[]): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const process = spawn(
    globalThis.process.execPath,
    ["--input-type=module", "-e", script, ...args],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  let err = "";
  process.stdout.on("data", (chunk) => {
    out += String(chunk);
  });
  process.stderr.on("data", (chunk) => {
    err += String(chunk);
  });
  process.on("error", reject);
  process.on("exit", (code) => {
    if (code !== 0) reject(new Error(err));
    else resolve(out);
  });
  return promise;
}
describe("SQLite persistence", () => {
  it("applies immutable checksummed migrations and refuses altered bytes", async () => {
    const db = await createDatabase();
    expect(db.status().currentVersion).toBe((await loadMigrations()).length);
    const dir = join(directories[0] ?? "", "tampered");
    await mkdir(dir);
    const migration = (await loadMigrations())[0];
    if (!migration) throw new Error("missing migration");
    await writeFile(join(dir, "0001_initial.sql"), `${migration.sql}\n-- changed`);
    await expect(db.migrate(dir)).rejects.toBeInstanceOf(MigrationChecksumError);
  });
  it("rolls back a migration that dies after DDL", async () => {
    const db = await createDatabase();
    const dir = join(directories[0] ?? "", "upgrade");
    await mkdir(dir);
    const migrations = await loadMigrations();
    const before = db.status().currentVersion;
    for (const migration of migrations)
      await writeFile(
        join(dir, `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`),
        migration.sql,
      );
    await writeFile(
      join(dir, `${String(before + 1).padStart(4, "0")}_failure.sql`),
      "CREATE TABLE transient(x INTEGER); INSERT INTO missing VALUES(1);",
    );
    await expect(db.migrate(dir)).rejects.toThrow();
    expect(db.status().currentVersion).toBe(before);
    expect(db.get("SELECT name FROM sqlite_master WHERE name='transient'")).toBeUndefined();
    expect(db.get("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
  });
  it("upgrades populated evidence while preserving code artifact foreign keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tm-artifact-upgrade-"));
    directories.push(directory);
    const initialDirectory = join(directory, "initial");
    await mkdir(initialDirectory);
    const initial = (await loadMigrations())[0];
    if (!initial) throw new Error("missing initial migration");
    await writeFile(
      join(initialDirectory, `${String(initial.version).padStart(4, "0")}_${initial.name}.sql`),
      initial.sql,
    );
    const db = await PersistenceDatabase.open(join(directory, "testmaster.db"), {
      migrationsDir: initialDirectory,
    });
    connections.push(db);
    db.withTx(() => {
      for (const statement of constraintSeed) db.run(statement);
      db.run(
        "INSERT INTO artifacts(workspace_id,id,created_at,run_id,attempt_id,revision_id,snapshot_id,hash,bytes,storage_key,state,redaction_status) VALUES('ws-a','art-existing','2026-10-05T00:00:00.000Z','run-a','att-a','rev-a','snp-a','hash',1,'existing','available','not_applicable')",
      );
      db.run(
        "INSERT INTO test_revisions(workspace_id,id,created_at,test_id,ordinal,content_hash,runner_kind,origin,code_artifact_id) VALUES('ws-a','rev-code','2026-10-05T00:00:00.000Z','tst-a',2,'hash','playwright','imported','art-existing')",
      );
    });
    await db.migrate();
    expect(
      db.get("SELECT code_artifact_id FROM test_revisions WHERE id='rev-code'")?.code_artifact_id,
    ).toBe("art-existing");
    expect(db.get("SELECT storage_key FROM artifacts WHERE id='art-existing'")?.storage_key).toBe(
      "existing",
    );
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(db.get("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
    db.withTx(() =>
      db.run(
        "INSERT INTO artifacts(workspace_id,id,created_at,revision_id,hash,bytes,storage_key,state,redaction_status) VALUES('ws-a','art-authored-new','2026-10-05T00:00:00.000Z','rev-code','hash',1,'authored','available','not_applicable')",
      ),
    );
  });
  it("rolls back an invalid rebuild upgrade and restores runtime foreign keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tm-invalid-upgrade-"));
    directories.push(directory);
    const initialDirectory = join(directory, "initial");
    const upgradeDirectory = join(directory, "upgrade");
    await mkdir(initialDirectory);
    await mkdir(upgradeDirectory);
    const migrations = await loadMigrations();
    const initial = migrations[0];
    if (!initial) throw new Error("missing initial migration");
    await writeFile(join(initialDirectory, "0001_initial.sql"), initial.sql);
    for (const migration of migrations)
      await writeFile(
        join(
          upgradeDirectory,
          `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`,
        ),
        migration.sql,
      );
    await writeFile(
      join(
        upgradeDirectory,
        `${String(migrations.length + 1).padStart(4, "0")}_invalid_reference.sql`,
      ),
      "INSERT INTO tests(workspace_id,id,created_at,project_id,name) VALUES('missing-ws','bad','2026-10-05T00:00:00.000Z','missing-project','Invalid')",
    );
    const db = await PersistenceDatabase.open(join(directory, "testmaster.db"), {
      migrationsDir: initialDirectory,
    });
    connections.push(db);
    await expect(db.migrate(upgradeDirectory)).rejects.toThrow("foreign key violation");
    expect(db.status().currentVersion).toBe(1);
    expect(db.get("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
    expect(db.get("SELECT id FROM tests WHERE id='bad'")).toBeUndefined();
    expect(() =>
      db.withTx(() =>
        db.run(
          "INSERT INTO tests(workspace_id,id,created_at,project_id,name) VALUES('missing-ws','bad','2026-10-05T00:00:00.000Z','missing-project','Invalid')",
        ),
      ),
    ).toThrow();
  });
  it("same key replays the original receipt, changed request conflicts", async () => {
    const { db, ws } = await createSeeded();
    const repo = new IdempotencyRepository(db);
    let count = 0;
    const req = {
      workspaceId: ws,
      actorScope: "local",
      operation: "run",
      key: "idempotency-key-0001",
      body: { test: "one" },
    };
    const first = repo.execute(req, () => ({ id: ++count }));
    expect(repo.execute(req, () => ({ id: ++count }))).toEqual({
      replayed: true,
      receipt: first.receipt,
    });
    expect(count).toBe(1);
    expect(() => repo.execute({ ...req, body: { test: "other" } }, () => ({}))).toThrow(
      "different request body",
    );
  });
  it("outbox and state mutation roll back together", async () => {
    const { db, ws, project } = await createSeeded();
    expect(() =>
      db.withTx(() => {
        db.run("UPDATE projects SET name='changed' WHERE id=?", project);
        new OutboxRepository(db).append(ws, project, "project.changed", { name: "changed" });
        throw new Error("fail commit");
      }),
    ).toThrow();
    expect(db.get("SELECT name FROM projects WHERE id=?", project)?.name).toBe("Project");
    expect(db.all("SELECT * FROM outbox")).toHaveLength(0);
  });
  it("rejects stale owner fencing after expiry and a new claim", async () => {
    const { db, ws, run } = await createSeeded();
    const leases = new LeaseRepository(db);
    const a = leases.claim({ workspaceId: ws, owner: "A", queue: "http" });
    if (!a) throw new Error("no claim");
    const future = new Date(Date.now() + 31000).toISOString();
    leases.expire(future);
    leases.resume(ws, a.jobId, a.fence);
    const b = leases.claim({ workspaceId: ws, owner: "B", queue: "http" });
    if (!b) throw new Error("no reclaim");
    expect(b.fence).toBe(2);
    expect(b.attemptId).not.toBe(a.attemptId);
    expect(() => leases.heartbeat(a)).toThrow(StaleFenceError);
    const repository = new ExecutionRepository(db);
    const previous = new EntityRepository(db).get("Run", ws, run);
    if (!previous) throw new Error("missing run");
    expect(() =>
      repository.finalize(a, {
        ...previous,
        phase: "completed",
        outcome: "passed",
        status: "passed",
        gate: "passed",
      }),
    ).toThrow(StaleFenceError);
    expect(
      repository.finalize(b, {
        ...previous,
        phase: "completed",
        outcome: "passed",
        status: "passed",
        gate: "passed",
      }),
    ).toBe(true);
    expect(db.get("SELECT outcome FROM runs WHERE id=?", run)?.outcome).toBe("passed");
  });
  it("allows exactly one of two OS processes to claim", async () => {
    const { db, ws } = await createSeeded();
    const script = `import {PersistenceDatabase,LeaseRepository} from './packages/persistence/dist/index.js'; const db=await PersistenceDatabase.open(process.argv[1]); const result=new LeaseRepository(db).claim({workspaceId:process.argv[2],owner:process.argv[3],queue:'http'}); console.log(result?'winner':'empty'); db.close();`;
    const results = await Promise.all([
      child(script, [db.path, ws, "A"]),
      child(script, [db.path, ws, "B"]),
    ]);
    expect(results.filter((text) => text.includes("winner"))).toHaveLength(1);
    expect(db.all("SELECT * FROM attempts")).toHaveLength(1);
  });
  it("bounds writer contention with a typed retryable error and succeeds once the writer commits", async () => {
    const db = await createDatabase();
    const other = await PersistenceDatabase.open(db.path);
    connections.push(other);
    expect(other.get("PRAGMA busy_timeout")?.timeout).toBe(5000);
    other.db.exec("PRAGMA busy_timeout=50");
    const holder = new DatabaseSync(db.path);
    try {
      holder.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      const started = Date.now();
      let ran = false;
      let error: unknown;
      try {
        other.withTx(() => {
          ran = true;
        });
      } catch (caught) {
        error = caught;
      }
      expect(Date.now() - started).toBeLessThan(2000);
      expect(error).toMatchObject({
        code: "UNAVAILABLE",
        details: { reasonCode: "writer_contention", retryable: true },
      });
      expect(ran).toBe(false);
      expect(other.db.isTransaction).toBe(false);
      holder.exec("COMMIT");
    } finally {
      holder.close();
    }
    other.withTx(() =>
      other.run("INSERT INTO operational_state(key,value) VALUES('contention-probe','ok')"),
    );
    expect(
      other.get("SELECT value FROM operational_state WHERE key='contention-probe'")?.value,
    ).toBe("ok");
  });
  it("enforces audit append-only even with direct SQL", async () => {
    const { db, ws, run } = await createSeeded();
    const id = new AuditRepository(db).append({
      workspaceId: ws,
      actor: "local",
      action: "run.created",
      resourceId: run,
      requestId: "request",
      beforeHash: null,
      afterHash: null,
      timestamp: new Date().toISOString(),
    });
    expect(() => db.run("UPDATE audit_events SET action='tampered' WHERE id=?", id)).toThrow(
      "immutable",
    );
    expect(() => db.run("DELETE FROM audit_events WHERE id=?", id)).toThrow("immutable");
  });
  it("never overspends under concurrent reserve and accounts settled usage", async () => {
    const { db, ws, project } = await createSeeded();
    const ledger = new SqliteBudgetLedger(db);
    ledger.setLimit(ws, project, { amount: "100", currency: "USD", scale: 2 });
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 10, maxLength: 40 }),
        async (amounts) => {
          db.withTx(() => {
            db.run("DELETE FROM usage_entries");
            db.run("DELETE FROM budget_reservations");
          });
          const requests = amounts.map((amount, index) => ({
            workspaceId: ws,
            projectId: project,
            purpose: "plan",
            provider: "local",
            model: "model",
            estimate: { amount: String(amount), currency: "USD", scale: 2 },
            idempotencyKey: `reserve-${index}`,
          }));
          const results = await Promise.all(requests.map((req) => ledger.reserve(req)));
          const total = results.reduce(
            (sum, result, index) => sum + (result.ok ? (amounts[index] ?? 0) : 0),
            0,
          );
          expect(total).toBeLessThanOrEqual(100);
        },
      ),
      { numRuns: 20 },
    );
    db.withTx(() => {
      db.run("DELETE FROM budget_reservations");
    });
    const reserve = await ledger.reserve({
      workspaceId: ws,
      projectId: project,
      purpose: "plan",
      provider: "p",
      model: "m",
      estimate: { amount: "100", currency: "USD", scale: 2 },
      idempotencyKey: "settled",
    });
    if (!reserve.ok) throw new Error("no budget");
    await ledger.settle(
      reserve.reservationId,
      { inputTokens: null, outputTokens: null, reasoningTokens: null },
      "unknown",
    );
    expect(
      (
        await ledger.reserve({
          workspaceId: ws,
          projectId: project,
          purpose: "plan",
          provider: "p",
          model: "m",
          estimate: { amount: "1", currency: "USD", scale: 2 },
          idempotencyKey: "next",
        })
      ).ok,
    ).toBe(false);
  });
  it("bounds concurrent model compute slots even without a price or monetary quota", async () => {
    const { db, ws, project } = await createSeeded();
    const ledger = new SqliteBudgetLedger(db);
    const request = {
      workspaceId: ws,
      projectId: project,
      purpose: "plan",
      provider: "local",
      model: "local",
      estimate: "unknown" as const,
      reservedTokens: 10,
    };
    const reservations = await Promise.all(
      ["A", "B", "C"].map((idempotencyKey) => ledger.reserve({ ...request, idempotencyKey })),
    );
    expect(reservations.filter((result) => result.ok)).toHaveLength(2);
    const first = reservations[0];
    if (!first?.ok) throw new Error("Missing compute slot");
    await ledger.settle(
      first.reservationId,
      { inputTokens: 1, outputTokens: 2, reasoningTokens: 0 },
      "unknown",
    );
    expect((await ledger.reserve({ ...request, idempotencyKey: "D" })).ok).toBe(true);
  });
  it("reserves independent cumulative tokens atomically and retains unknown-response charges", async () => {
    const { db, ws, project } = await createSeeded();
    const ledger = new SqliteBudgetLedger(db);
    ledger.setTokenLimit(ws, project, 100);
    const request = {
      workspaceId: ws,
      projectId: project,
      purpose: "plan",
      provider: "p",
      model: "m",
      estimate: "unknown" as const,
      reservedTokens: 60,
    };
    const results = await Promise.all([
      ledger.reserve({ ...request, idempotencyKey: "A" }),
      ledger.reserve({ ...request, idempotencyKey: "B" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const winner = results.find((result) => result.ok);
    if (!winner?.ok) throw new Error("No winning reservation");
    await ledger.settle(
      winner.reservationId,
      { inputTokens: 10, outputTokens: 20, reasoningTokens: 5 },
      "unknown",
    );
    expect(ledger.tokenBudget(ws, project)).toEqual({ limit: 100, used: 30, remaining: 70 });
    const lost = await ledger.reserve({ ...request, idempotencyKey: "C" });
    if (!lost.ok) throw new Error("Expected conservative reserve");
    await ledger.settle(
      lost.reservationId,
      { inputTokens: null, outputTokens: null, reasoningTokens: null },
      "unknown",
    );
    expect(ledger.tokenBudget(ws, project)).toEqual({ limit: 100, used: 90, remaining: 10 });
    expect((await ledger.reserve({ ...request, idempotencyKey: "D" })).ok).toBe(false);
  });
  it("applies no token quota until the operator sets one", async () => {
    const { db, ws, project } = await createSeeded();
    const ledger = new SqliteBudgetLedger(db);
    const request = {
      workspaceId: ws,
      projectId: project,
      purpose: "plan",
      provider: "p",
      model: "m",
      estimate: "unknown" as const,
      reservedTokens: 5_000_000,
    };
    const first = await ledger.reserve({ ...request, idempotencyKey: "A" });
    if (!first.ok) throw new Error("Expected an unlimited reservation");
    expect(ledger.tokenBudget(ws, project)).toEqual({
      limit: null,
      used: 5_000_000,
      remaining: null,
    });
    ledger.setTokenLimit(ws, project, 6_000_000);
    expect((await ledger.reserve({ ...request, idempotencyKey: "B" })).ok).toBe(false);
  });
  it("stores consent with audit and complete model usage without converting null to zero", async () => {
    const { db, ws, project } = await createSeeded();
    const store = new SqliteConsentStore(db);
    store.grant(
      { workspaceId: ws, projectId: project, providerId: "p" },
      ["requirements"],
      "local",
    );
    expect(
      (await store.find({ workspaceId: ws, projectId: project, providerId: "p" }))?.dataClasses,
    ).toEqual(["requirements"]);
    store.revoke({ workspaceId: ws, projectId: project, providerId: "p" }, "local");
    expect(
      (await store.find({ workspaceId: ws, projectId: project, providerId: "p" }))?.revokedAt,
    ).not.toBeNull();
    const recorder = new SqliteModelCallRecorder(db);
    await recorder.record({
      id: uuidV7IdGenerator.next("mdl"),
      workspaceId: ws,
      projectId: project,
      createdAt: new Date().toISOString(),
      purpose: "plan",
      provider: "p",
      model: "m",
      promptHash: "a".repeat(64),
      inputRefs: [],
      usage: { inputTokens: null, outputTokens: null, reasoningTokens: null },
      cost: "unknown",
      latency: 1,
      outcome: "failed",
      cacheHit: false,
      repairAttempt: 0,
      transportAttempt: 0,
      reservationId: null,
      responseHash: null,
      finishReason: null,
    });
    expect(String(db.get("SELECT data_json FROM model_calls")?.data_json)).toContain(
      '"inputTokens":null',
    );
  });
  it("backs up WAL consistently and restores in suspended isolation preserving IDs", async () => {
    const { db, ws, run } = await createSeeded();
    const root = directories[0] ?? "";
    const backupDir = join(root, "backup");
    const manifest = await db.backup(backupDir);
    expect(manifest.files).toHaveLength(2);
    expect(manifest.files[0]?.sha256).toBe(await fileSha256(join(backupDir, "testmaster.db")));
    const restored = await PersistenceDatabase.restore(backupDir, join(root, "restore"));
    connections.push(restored.database);
    expect(
      restored.database.get("SELECT id FROM runs WHERE workspace_id=? AND id=?", ws, run)?.id,
    ).toBe(run);
    expect(
      new LeaseRepository(restored.database).claim({
        workspaceId: ws,
        owner: "worker",
        queue: "http",
      }),
    ).toBeNull();
    expect(new OutboxRepository(restored.database).pending(ws)).toHaveLength(0);
    expect(restored.requiresOperatorReview).toBe(true);
    expect(
      restored.database.get("SELECT value FROM operational_state WHERE key='admission'")?.value,
    ).toBe("suspended_restore");
    const raw = await readFile(join(backupDir, "testmaster.db"));
    raw[0] = 0;
    await writeFile(join(backupDir, "testmaster.db"), raw);
    await expect(
      PersistenceDatabase.restore(backupDir, join(root, "tampered-restore")),
    ).rejects.toThrow("integrity");
  });
  it("OPS-025 replays post-backup consent and approval revocations and invalidates server tokens", async () => {
    const { db, ws, project, environmentRevision } = await createSeeded();
    const entities = new EntityRepository(db);
    const principal = uuidV7IdGenerator.next("usr");
    const kept = uuidV7IdGenerator.next("apr");
    const revoked = uuidV7IdGenerator.next("apr");
    const approval = (id: string) => ({
      id,
      workspaceId: ws,
      createdAt: new Date().toISOString(),
      version: 1,
      actorId: principal,
      reviewerId: principal,
      actionSet: ["run"],
      revisionHash: "b".repeat(64),
      environmentRevisionId: environmentRevision,
      originSet: ["http://127.0.0.1:3000"],
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      revokedAt: null,
      policyHash: "c".repeat(64),
    });
    db.withTx(() => {
      entities.insert("Principal", {
        id: principal,
        workspaceId: ws,
        kind: "human",
        displayName: "Owner",
        disabledAt: null,
      });
      entities.insert("Approval", approval(kept));
      entities.insert("Approval", approval(revoked));
      db.run(
        "INSERT INTO server_tokens(workspace_id,id,created_at,principal_id,token_hash) VALUES(?,?,?,?,?)",
        ws,
        "tok-1",
        new Date().toISOString(),
        principal,
        "d".repeat(64),
      );
    });
    new SqliteConsentStore(db).grant(
      { workspaceId: ws, projectId: project, providerId: "fake" },
      ["documents"],
      principal,
    );
    const consentId = String(db.get("SELECT id FROM consents WHERE project_id=?", project)?.id);
    const root = directories[0] ?? "";
    const backupDir = join(root, "backup-ledger");
    await db.backup(backupDir);
    const revokedAt = new Date().toISOString();
    db.run("UPDATE consents SET revoked_at=? WHERE id=?", revokedAt, consentId);
    db.withTx(() =>
      entities.update("Approval", ws, revoked, 1, { ...approval(revoked), revokedAt, version: 2 }),
    );
    const restored = await PersistenceDatabase.restore(backupDir, join(root, "restore-ledger"), {
      consentRevocations: db.all(
        "SELECT workspace_id,id,revoked_at FROM consents WHERE revoked_at IS NOT NULL",
      ),
      approvalRevocations: db.all(
        "SELECT workspace_id,id,revoked_at FROM approvals WHERE revoked_at IS NOT NULL",
      ),
    });
    connections.push(restored.database);
    const target = restored.database;
    expect(target.get("SELECT revoked_at FROM consents WHERE id=?", consentId)?.revoked_at).toBe(
      revokedAt,
    );
    expect(target.get("SELECT revoked_at FROM approvals WHERE id=?", revoked)?.revoked_at).toBe(
      revokedAt,
    );
    expect(
      JSON.parse(
        String(target.get("SELECT data_json FROM approvals WHERE id=?", revoked)?.data_json),
      ).revokedAt,
    ).toBe(revokedAt);
    expect(target.get("SELECT revoked_at FROM approvals WHERE id=?", kept)?.revoked_at).toBeNull();
    expect(target.get("SELECT COUNT(*) AS n FROM server_tokens")?.n).toBe(0);
    expect(db.get("SELECT COUNT(*) AS n FROM server_tokens")?.n).toBe(1);
    expect(restored).toMatchObject({ postBackupLedger: "replayed", exclusionsGuaranteed: true });
  });
  it("OPS-025 keeps a consent revoked in the backup even when the live ledger regranted it", async () => {
    const { db, ws, project } = await createSeeded();
    new SqliteConsentStore(db).grant(
      { workspaceId: ws, projectId: project, providerId: "fake" },
      ["documents"],
      "owner",
    );
    const consentId = String(db.get("SELECT id FROM consents WHERE project_id=?", project)?.id);
    const revokedAt = "2026-01-01T00:00:00.000Z";
    db.run("UPDATE consents SET revoked_at=? WHERE id=?", revokedAt, consentId);
    const root = directories[0] ?? "";
    await db.backup(join(root, "backup-prior"));
    db.run("UPDATE consents SET revoked_at=NULL WHERE id=?", consentId);
    const restored = await PersistenceDatabase.restore(
      join(root, "backup-prior"),
      join(root, "restore-prior"),
      {
        consentRevocations: db.all(
          "SELECT workspace_id,id,revoked_at FROM consents WHERE revoked_at IS NOT NULL",
        ),
      },
    );
    connections.push(restored.database);
    expect(
      restored.database.get("SELECT revoked_at FROM consents WHERE id=?", consentId)?.revoked_at,
    ).toBe(revokedAt);
  });
  it("OPS-025 declares an unreadable post-backup ledger and keeps the restore suspended", async () => {
    const { db } = await createSeeded();
    const root = directories[0] ?? "";
    await db.backup(join(root, "backup-noledger"));
    const restored = await PersistenceDatabase.restore(
      join(root, "backup-noledger"),
      join(root, "restore-noledger"),
      { ledgerAvailable: false },
    );
    connections.push(restored.database);
    expect(restored).toMatchObject({
      postBackupLedger: "unavailable",
      exclusionsGuaranteed: false,
    });
    expect(
      restored.database.get("SELECT value FROM operational_state WHERE key='restore_review'")
        ?.value,
    ).toBe("post_backup_ledger_unavailable");
    expect(
      restored.database.get("SELECT value FROM operational_state WHERE key='admission'")?.value,
    ).toBe("suspended_restore");
  });
  it.each(constraintFixtures)("constraint fixture: $name", async (fixture) => {
    const db = await createDatabase();
    db.withTx(() => {
      for (const sql of constraintSeed) db.db.exec(sql);
    });
    let actual: string = "accept";
    try {
      db.withTx(() => {
        for (const sql of fixture.statements) db.db.exec(sql);
      });
    } catch (error) {
      actual = constraintErrorClass(error);
    }
    expect(actual).toBe(fixture.expected);
  });
});
