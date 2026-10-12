import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Application } from "./application.js";

it("OPS-024 real backup destination failure emits a durable non-green alert", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-backup-alert-"));
  const app = await Application.open({ cwd, home: join(cwd, "home") });
  try {
    await app.init();
    const destination = join(cwd, "already-exists");
    await mkdir(destination);
    await expect(app.backups.create(destination)).rejects.toMatchObject({ code: "EEXIST" });
    expect(app.database.get("SELECT COUNT(*) AS n FROM outbox WHERE type='backup.failed'")?.n).toBe(
      1,
    );
    const warning = app.database.get(
      "SELECT value FROM operational_state WHERE key='backup:last-warning'",
    );
    expect(JSON.parse(String(warning?.value))).toMatchObject({ reasonCode: "storage_unavailable" });
  } finally {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

it("OPS-024 missing evidence object marks the backup incomplete and raises a durable artifact_unavailable alert", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-backup-missing-"));
  const app = await Application.open({ cwd, home: join(cwd, "home") });
  try {
    const init = await app.init();
    const imported = await app.artifacts.importFixtureInput({
      projectId: init.projectId,
      name: "profile",
      bytes: Buffer.from("payload"),
      mimeType: "text/plain",
    });
    const record = app.database.get(
      "SELECT storage_key FROM fixture_inputs WHERE id=?",
      imported.id,
    );
    await rm(join(app.config.dataDir, String(record?.storage_key)));
    const destination = join(cwd, "backup-missing");
    const manifest = await app.backups.create(destination);
    expect(manifest.missingObjects).toEqual([imported.id]);
    expect(manifest.files.map((file) => file.relativePath)).not.toContain(
      `evidence/${record?.storage_key}`,
    );
    expect(
      JSON.parse(await readFile(join(destination, "evidence-index.json"), "utf8")),
    ).toMatchObject({
      complete: false,
      missingObjects: [imported.id],
    });
    expect(app.database.get("SELECT COUNT(*) AS n FROM outbox WHERE type='backup.failed'")?.n).toBe(
      1,
    );
    const warning = app.database.get(
      "SELECT value FROM operational_state WHERE key='backup:last-warning'",
    );
    expect(JSON.parse(String(warning?.value))).toMatchObject({
      reasonCode: "artifact_unavailable",
    });
  } finally {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
