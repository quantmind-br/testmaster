import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
