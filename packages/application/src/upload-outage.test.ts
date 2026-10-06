import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { UploadsService } from "./ai/sources.js";
import { Application } from "./application.js";

it("OPS-023 storage outage keeps eight leased uploads bounded, emits alert and refuses further backlog", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-upload-outage-"));
  const app = await Application.open({ cwd, home: join(cwd, "home") });
  try {
    await app.init();
    const config = {
      ...app.config,
      profilePolicy: { ...app.config.profilePolicy, allowUpload: true },
    };
    const uploads = new UploadsService(app.context, config);
    // Real read-only kernel filesystem: no mocked open/write errors.
    await symlink("/sys", join(app.config.dataDir, "uploads"));
    const receipts = Array.from({ length: 8 }, () =>
      uploads.create({ mediaType: "application/json", sizeBytes: 10, contentHash: "0".repeat(64) }),
    );
    for (const receipt of receipts)
      await expect(uploads.write(receipt.uploadId, Buffer.alloc(10))).rejects.toBeDefined();
    expect(() =>
      uploads.create({ mediaType: "application/json", sizeBytes: 10, contentHash: "0".repeat(64) }),
    ).toThrow(expect.objectContaining({ code: "QUOTA_EXCEEDED" }));
    expect(
      app.database.get("SELECT COUNT(*) AS n,SUM(reserved_bytes) AS bytes FROM upload_leases"),
    ).toMatchObject({ n: 8, bytes: 80 });
    expect(
      app.database.get("SELECT COUNT(*) AS n FROM outbox WHERE type='storage.upload.failed'")?.n,
    ).toBe(8);
    expect(
      app.database.get("SELECT value FROM operational_state WHERE key='storage:upload-outage'"),
    ).toBeDefined();
    app.database.run("UPDATE upload_leases SET expires_at=?", new Date(0).toISOString());
    await rm(join(app.config.dataDir, "uploads"));
    await app.retention.maintenance();
    expect(() =>
      uploads.create({ mediaType: "application/json", sizeBytes: 10, contentHash: "0".repeat(64) }),
    ).not.toThrow();
  } finally {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
