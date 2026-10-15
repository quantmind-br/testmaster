import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadMigrations, PersistenceDatabase } from "./database.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const now = "2026-10-01T10:00:00.000Z";
const base = { projectIds: [], events: ["run.failed"], secretRefs: [], settings: {} };

interface LegacyIntegration {
  id: string;
  state: string;
  document: unknown;
  /** Actor of the creation audit event, when the row has one. */
  auditActor?: string;
}

/** A database one migration before 0020, holding integrations as the consent-era release stored them. */
async function legacyDatabase(integrations: LegacyIntegration[]) {
  const root = await mkdtemp(join(tmpdir(), "tm-integration-created-by-"));
  roots.push(root);
  const all = await loadMigrations();
  const target = all.find((migration) => migration.name === "integration_created_by");
  expect(target?.version).toBe(20);
  const legacyDir = join(root, "release-with-consent");
  await mkdir(legacyDir);
  for (const migration of all.filter((candidate) => candidate.version < 20))
    await writeFile(
      join(legacyDir, `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`),
      migration.sql,
    );
  const path = join(root, "testmaster.db");
  const old = await PersistenceDatabase.open(path, { migrationsDir: legacyDir });
  old.run(
    "INSERT INTO workspaces(workspace_id,id,created_at,name,mode) VALUES('ws','ws',?,'w','single-user')",
    now,
  );
  for (const [index, row] of integrations.entries()) {
    old.run(
      "INSERT INTO integrations(workspace_id,id,created_at,version,data_json,provider,name,state) VALUES('ws',?,?,3,?,'webhook',?,?)",
      row.id,
      now,
      JSON.stringify(row.document),
      `hook-${index}`,
      row.state,
    );
    if (row.auditActor !== undefined)
      old.run(
        "INSERT INTO audit_events(workspace_id,id,created_at,actor,action,resource_id,request_id,timestamp) VALUES('ws',?,?,?,'integrations.create',?,'req_1',?)",
        `aud_${index}`,
        now,
        row.auditActor,
        row.id,
        now,
      );
  }
  old.close();
  return { path, legacyDir, version: all.length };
}

const consent = (grantedBy: unknown) => ({ scopes: ["notify:webhook"], grantedBy, grantedAt: now });

it("migration 0020 turns the integration consent grantor into createdBy, drops the consent document and keeps lifecycle state", async () => {
  const legacy = await legacyDatabase([
    { id: "int_active", state: "active", document: { ...base, consent: consent("usr_granter") } },
    {
      id: "int_revoked",
      state: "revoked",
      document: { ...base, consent: { ...consent("usr_revoker"), scopes: [] } },
    },
    { id: "int_audit", state: "paused", document: { ...base }, auditActor: "usr_creator" },
  ]);

  const migrated = await PersistenceDatabase.open(legacy.path);
  try {
    expect(migrated.status()).toMatchObject({ currentVersion: legacy.version, pending: [] });
    const rows = migrated.all<{ id: string; state: string; version: number; data_json: string }>(
      "SELECT id,state,version,data_json FROM integrations ORDER BY id",
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const document = (id: string) => JSON.parse(String(byId.get(id)?.data_json));
    expect(document("int_active")).toMatchObject({
      createdBy: "usr_granter",
      events: ["run.failed"],
    });
    expect(document("int_revoked")).toMatchObject({ createdBy: "usr_revoker" });
    expect(document("int_audit")).toMatchObject({ createdBy: "usr_creator" });
    for (const row of rows) expect(row.data_json).not.toContain("consent");
    expect(byId.get("int_revoked")?.state).toBe("revoked");
    expect(byId.get("int_audit")?.state).toBe("paused");
    expect(byId.get("int_active")?.state).toBe("active");
    expect(rows.map((row) => row.version)).toEqual([3, 3, 3]);
  } finally {
    migrated.close();
  }
});

it("migration 0020 skips blank or non-text attributions and never replaces a usable createdBy", async () => {
  const legacy = await legacyDatabase([
    // Blank createdBy and consent grantor fall through to the creation audit actor.
    {
      id: "int_blank",
      state: "active",
      document: { ...base, createdBy: "  ", consent: consent("") },
      auditActor: "usr_audit",
    },
    // Null and non-string grantors fall through as well.
    {
      id: "int_null",
      state: "active",
      document: { ...base, consent: consent(null) },
      auditActor: "usr_audit_null",
    },
    {
      id: "int_number",
      state: "paused",
      document: { ...base, consent: consent(7) },
      auditActor: "usr_audit_number",
    },
    // An empty createdBy still resolves from the grantor, and a usable createdBy is kept as is.
    {
      id: "int_grantor",
      state: "active",
      document: { ...base, createdBy: "", consent: consent("usr_grantor") },
    },
    {
      id: "int_kept",
      state: "revoked",
      document: { ...base, createdBy: "usr_kept", consent: consent("usr_other") },
      auditActor: "usr_unused",
    },
    // A whitespace-only audit actor (the schema requires length >= 1) is not an owner but must not hide a later usable one.
    {
      id: "int_second_audit",
      state: "active",
      document: { ...base, consent: consent(" ") },
      auditActor: "  ",
    },
  ]);
  const database = await PersistenceDatabase.open(legacy.path, {
    migrationsDir: legacy.legacyDir,
  });
  database.run(
    "INSERT INTO audit_events(workspace_id,id,created_at,actor,action,resource_id,request_id,timestamp) VALUES('ws','aud_late','2026-10-01T11:00:00.000Z','usr_later','integrations.create','int_second_audit','req_2','2026-10-01T11:00:00.000Z')",
  );
  database.close();

  const migrated = await PersistenceDatabase.open(legacy.path);
  try {
    const owners = Object.fromEntries(
      migrated
        .all<{ id: string; data_json: string }>("SELECT id,data_json FROM integrations")
        .map((row) => [row.id, JSON.parse(row.data_json).createdBy]),
    );
    expect(owners).toEqual({
      int_blank: "usr_audit",
      int_null: "usr_audit_null",
      int_number: "usr_audit_number",
      int_grantor: "usr_grantor",
      int_kept: "usr_kept",
      int_second_audit: "usr_later",
    });
  } finally {
    migrated.close();
  }
});

for (const [title, document, auditActor] of [
  ["no grantor and no creation audit event", base, undefined],
  ["a null grantor and no audit event", { ...base, consent: consent(null) }, undefined],
  ["an empty grantor and a blank audit actor", { ...base, consent: consent("") }, "  "],
  ["a non-text grantor and no audit event", { ...base, consent: consent(42) }, undefined],
  ["a document that is not a JSON object", [1, 2], "usr_audit"],
] as const)
  it(`migration 0020 aborts and rolls everything back when an integration has ${title}`, async () => {
    const legacy = await legacyDatabase([
      { id: "int_fine", state: "active", document: { ...base, consent: consent("usr_granter") } },
      { id: "int_orphan", state: "revoked", document, auditActor },
    ]);
    const before = await PersistenceDatabase.open(legacy.path, { migrationsDir: legacy.legacyDir });
    const snapshot = before.all("SELECT id,state,version,data_json FROM integrations ORDER BY id");
    const priorVersion = before.status().currentVersion;
    before.close();

    await expect(PersistenceDatabase.open(legacy.path)).rejects.toThrow(
      /integration_created_by_unresolvable/,
    );

    const after = await PersistenceDatabase.open(legacy.path, { migrationsDir: legacy.legacyDir });
    try {
      // Neither the resolvable row nor any migration bookkeeping was applied.
      expect(after.status().currentVersion).toBe(priorVersion);
      expect(after.all("SELECT id,state,version,data_json FROM integrations ORDER BY id")).toEqual(
        snapshot,
      );
    } finally {
      after.close();
    }
  });
