import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadMigrations, PersistenceDatabase } from "./database.js";
import { createTestDatabase, type TestDatabase } from "./testing/postgres.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const at = "2026-10-01T10:00:00.000Z";
const base = { projectIds: [], events: ["run.failed"], secretRefs: [], settings: {} };
const consent = (grantedBy: unknown) => ({ scopes: ["notify:webhook"], grantedBy, grantedAt: at });

interface LegacyIntegration {
  id: string;
  state: string;
  document: unknown;
  /** Actor of the creation audit event, when the row has one. */
  auditActor?: string;
}

/** A PostgreSQL database stopped at version 19, holding integrations as the consent-era release stored them. */
async function legacyDatabase(integrations: LegacyIntegration[]) {
  const created: TestDatabase = await createTestDatabase({ migrate: false });
  cleanups.push(() => created.drop());
  const db = PersistenceDatabase.openPostgres(created.config);
  cleanups.push(() => {
    if (db.isOpen) db.close();
  });
  const available = await loadMigrations("postgres");
  const target = available.find((migration) => migration.name === "integration_created_by");
  expect(target?.version).toBe(20);
  const directory = await mkdtemp(join(tmpdir(), "tm-pg-created-by-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  for (const migration of available.filter((candidate) => candidate.version < 20))
    await writeFile(
      join(directory, `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`),
      migration.sql,
    );
  await db.migrate(directory);
  expect(db.status().currentVersion).toBe(19);
  db.run(
    "INSERT INTO workspaces(workspace_id,id,created_at,name,mode) VALUES('ws','ws',?,'w','single-user')",
    at,
  );
  for (const [index, row] of integrations.entries()) {
    db.run(
      "INSERT INTO integrations(workspace_id,id,created_at,version,data_json,provider,name,state) VALUES('ws',?,?,3,?,'webhook',?,?)",
      row.id,
      at,
      JSON.stringify(row.document),
      `hook-${index}`,
      row.state,
    );
    if (row.auditActor !== undefined)
      db.run(
        "INSERT INTO audit_events(workspace_id,id,created_at,actor,action,resource_id,request_id,timestamp) VALUES('ws',?,?,?,'integrations.create',?,'req_1',?)",
        `aud_${index}`,
        at,
        row.auditActor,
        row.id,
        at,
      );
  }
  return { db, available };
}

const snapshot = (db: PersistenceDatabase) =>
  db.all("SELECT id,state,version,data_json FROM integrations ORDER BY id");

it("PostgreSQL migration 0020 upgrades legacy integrations to createdBy, drops consent and keeps lifecycle state", async () => {
  const { db, available } = await legacyDatabase([
    { id: "int_active", state: "active", document: { ...base, consent: consent("usr_granter") } },
    {
      id: "int_revoked",
      state: "revoked",
      document: { ...base, consent: { ...consent("usr_revoker"), scopes: [] } },
    },
    { id: "int_audit", state: "paused", document: { ...base }, auditActor: "usr_creator" },
    {
      id: "int_kept",
      state: "active",
      document: { ...base, createdBy: "usr_kept", consent: consent("usr_other") },
    },
    {
      id: "int_blank",
      state: "active",
      document: { ...base, createdBy: "  ", consent: consent("") },
      auditActor: "usr_audit",
    },
  ]);

  await db.migrate();

  expect(db.status()).toMatchObject({ currentVersion: available.length, pending: [] });
  const rows = db.all<{ id: string; state: string; version: number; data_json: string }>(
    "SELECT id,state,version,data_json FROM integrations ORDER BY id",
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const document = (id: string) => JSON.parse(String(byId.get(id)?.data_json));
  expect(document("int_active")).toMatchObject({
    createdBy: "usr_granter",
    events: ["run.failed"],
  });
  expect(document("int_revoked").createdBy).toBe("usr_revoker");
  expect(document("int_audit").createdBy).toBe("usr_creator");
  expect(document("int_kept").createdBy).toBe("usr_kept");
  expect(document("int_blank").createdBy).toBe("usr_audit");
  for (const row of rows) expect(row.data_json).not.toContain("consent");
  expect(byId.get("int_revoked")?.state).toBe("revoked");
  expect(byId.get("int_audit")?.state).toBe("paused");
  expect(byId.get("int_active")?.state).toBe("active");
  expect(rows.map((row) => Number(row.version))).toEqual([3, 3, 3, 3, 3]);
});

for (const [title, document, auditActor] of [
  ["no grantor and no creation audit event", base, undefined],
  ["a null grantor and no audit event", { ...base, consent: consent(null) }, undefined],
  ["an empty grantor and a whitespace-only audit actor", { ...base, consent: consent("") }, "  "],
  ["a non-text grantor and no audit event", { ...base, consent: consent(42) }, undefined],
  ["a document that is not a JSON object", [1, 2], "usr_audit"],
] as const)
  it(`PostgreSQL migration 0020 aborts and keeps every legacy row when an integration has ${title}`, async () => {
    const { db } = await legacyDatabase([
      { id: "int_fine", state: "active", document: { ...base, consent: consent("usr_granter") } },
      { id: "int_orphan", state: "revoked", document, auditActor },
    ]);
    const before = snapshot(db);

    await expect(db.migrate()).rejects.toThrow(/integration_created_by_unresolvable/);

    // The failed migration left no trace: version, the resolvable row and the orphan are all as they were.
    expect(db.inTransaction).toBe(false);
    expect(db.status().currentVersion).toBe(19);
    expect(snapshot(db)).toEqual(before);
    for (const row of before) expect(String(row.data_json)).not.toContain("createdBy");
  });
