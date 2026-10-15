import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadMigrations, PersistenceDatabase } from "./database.js";
import { postgresParity } from "./testing/postgres.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const at = "2026-10-01T10:00:00.000Z";
const target = { baseUrl: "http://127.0.0.1:4010", networkProfile: "local-loopback" };
const state = (choices: Record<string, unknown>) => ({
  projectId: "prj_a",
  principalId: "usr_a",
  version: 3,
  saved: true,
  currentStep: "target",
  completedSteps: ["mode", "project"],
  choices,
  history: [{ at, step: "mode", event: "completed", changed: ["mode", "consents"] }],
  updatedAt: at,
});
/** Wizard state rows as the consent-era release stored them (migration 0020 is the last one applied). */
const legacyOnboardingRows = {
  "onboarding:ws:prj_a:usr_a": state({
    mode: "local",
    target,
    consents: { scan: "granted", tunnel: "declined" },
  }),
  "onboarding:ws:prj_a:usr_b": state({ mode: "local", consents: {} }),
  "onboarding:ws:prj_a:usr_c": state({ mode: "local", target }),
  // Not wizard state: a key outside the onboarding namespace is never rewritten.
  "other:ws:prj_a:usr_a": state({ consents: { scan: "granted" } }),
} as const;

// Not run on PostgreSQL: Opens a legacy SQLite data directory by path; database.pg.test.ts runs the same
// real migration chain on PostgreSQL.
it.skipIf(postgresParity)(
  "migration 0021 strips only choices.consents from stored onboarding state across the real chain",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tm-onboarding-migration-"));
    roots.push(root);
    const all = await loadMigrations();
    expect(all.find((migration) => migration.version === 21)?.name).toBe(
      "onboarding_remove_consents",
    );
    const legacyDir = join(root, "release-with-consents");
    await mkdir(legacyDir);
    for (const migration of all.filter((candidate) => candidate.version < 21))
      await writeFile(
        join(legacyDir, `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`),
        migration.sql,
      );
    const path = join(root, "testmaster.db");
    const old = await PersistenceDatabase.open(path, { migrationsDir: legacyDir });
    expect(old.status().currentVersion).toBe(20);
    for (const [key, value] of Object.entries(legacyOnboardingRows))
      old.run("INSERT INTO operational_state(key,value) VALUES(?,?)", key, JSON.stringify(value));
    old.close();

    const migrated = await PersistenceDatabase.open(path);
    try {
      expect(migrated.status()).toMatchObject({ currentVersion: all.length, pending: [] });
      const read = (key: string) =>
        JSON.parse(
          String(migrated.get("SELECT value FROM operational_state WHERE key=?", key)?.value),
        );
      const a = legacyOnboardingRows["onboarding:ws:prj_a:usr_a"];
      expect(read("onboarding:ws:prj_a:usr_a")).toEqual({
        ...a,
        choices: { mode: "local", target },
      });
      expect(read("onboarding:ws:prj_a:usr_b").choices).toEqual({ mode: "local" });
      // Rows without consents and rows outside the namespace are byte-for-byte untouched.
      expect(read("onboarding:ws:prj_a:usr_c")).toEqual(
        legacyOnboardingRows["onboarding:ws:prj_a:usr_c"],
      );
      expect(read("other:ws:prj_a:usr_a")).toEqual(legacyOnboardingRows["other:ws:prj_a:usr_a"]);
    } finally {
      migrated.close();
    }
  },
);
