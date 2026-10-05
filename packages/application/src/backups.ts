import { copyFile, lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ContractError, validate } from "@testmaster/contracts";
import { type BackupManifest, fileSha256, PersistenceDatabase } from "@testmaster/persistence";
import type { ResolvedConfig } from "./config.js";
import type { ServiceContext } from "./context.js";
export class BackupsService {
  constructor(
    readonly ctx: ServiceContext,
    readonly config: ResolvedConfig,
  ) {}
  async create(out: string): Promise<BackupManifest> {
    this.ctx.authorize("A");
    const destination = resolve(this.config.cwd, out);
    const manifest = await this.ctx.database.backup(destination, {
      evidenceRoot: this.config.dataDir,
    });
    for (const snapshot of this.ctx.database.all(
      "SELECT run_id,attempt_id FROM snapshots WHERE workspace_id=?",
      this.ctx.workspaceId,
    )) {
      for (const name of ["manifest.json", "meta.json"]) {
        const relativePath = `evidence/runs/${this.ctx.workspaceId}/${String(snapshot.run_id)}/${String(snapshot.attempt_id)}/${name}`;
        const source = join(this.config.dataDir, relativePath.slice("evidence/".length));
        const info = await lstat(source);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
          throw new ContractError("POLICY_DENIED", "Unsafe backup metadata file");
        await mkdir(dirname(join(destination, relativePath)), { recursive: true, mode: 0o700 });
        await copyFile(source, join(destination, relativePath));
        manifest.files.push({
          relativePath,
          sizeBytes: info.size,
          sha256: await fileSha256(source),
        });
      }
    }
    validate("BackupManifest", manifest);
    await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    return manifest;
  }
  async restore(path: string, out: string) {
    this.ctx.authorize("A");
    const source = resolve(this.config.cwd, path);
    const destination = resolve(this.config.cwd, out);
    const result = await PersistenceDatabase.restore(source, destination);
    try {
      const evidence = join(destination, "evidence", "runs");
      try {
        await rename(evidence, join(destination, "runs"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return {
        out: destination,
        manifest: result.manifest,
        evidenceComplete: result.evidenceComplete,
        requiresOperatorReview: result.requiresOperatorReview,
      };
    } finally {
      result.database.close();
    }
  }
}
