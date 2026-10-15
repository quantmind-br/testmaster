import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { semanticHash } from "@testmaster/domain";
import type { EntityDocument } from "@testmaster/persistence";
import { expect, it } from "vitest";
import {
  type AdmissionSnapshot,
  admissionInputHash,
  reproduction,
  resolveRepositoryProvenance,
  verifyAdmission,
} from "./provenance.js";

it("refuses mutated admitted inputs and capabilities without changing replay degree", () => {
  const environment = { id: "environment" } as EntityDocument;
  const revision = { contentHash: "a".repeat(64), runnerKind: "http" } as EntityDocument;
  const effectiveConfig = {
    config: { schemaVersion: "1.0.0" },
    origins: {},
    policyHash: "b".repeat(64),
  };
  const cell: Record<string, unknown> = {
    effectiveConfig,
    executor: "process",
    baseUrl: "http://localhost:8000",
    limits: {},
    seed: 12,
  };
  const snapshot = {
    revisionHash: revision.contentHash,
    environmentHash: semanticHash(environment),
    images: null,
    requiredCapabilities: ["http"],
    seed: 12,
    policyHash: effectiveConfig.policyHash,
    limitations: ["mutable-external-target", "remote-model-snapshot-unavailable"],
    repository: {
      repositoryId: null,
      commitSha: null,
      checkoutSha: null,
      baseSha: null,
      dirtyHash: null,
      deploymentId: null,
      binding: "unbound",
      limitations: ["repository-commit-unavailable"],
    },
    runtimeIdentity: null,
    inputHash: admissionInputHash(cell),
  } as AdmissionSnapshot;
  cell.admissionSnapshot = snapshot;
  cell.admissionSnapshotHash = semanticHash(snapshot);
  const run = { matrixCell: cell } as EntityDocument;
  expect(verifyAdmission(run, revision, environment, null).seed).toBe(12);
  cell.baseUrl = "http://localhost:9000";
  expect(() => verifyAdmission(run, revision, environment, null)).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ incompatibility: "execution_input_hash_mismatch" }),
    }),
  );
  cell.baseUrl = "http://localhost:8000";
  snapshot.requiredCapabilities = ["future-runner"];
  cell.admissionSnapshotHash = semanticHash(snapshot);
  expect(() => verifyAdmission(run, revision, environment, null)).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ incompatibility: "capability_incompatible" }),
    }),
  );
  expect(reproduction(snapshot).degree).toBe("strict-execution-replay");
  expect(reproduction(snapshot, undefined, true)).toMatchObject({
    degree: "fresh-llm-regeneration",
    limitations: expect.arrayContaining(["remote-model-snapshot-unavailable"]),
  });
});
it("keeps absent repositories unbound and verifies checkout, dirty and ancestor claims against actual Git state", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-provenance-"));
  try {
    expect(resolveRepositoryProvenance(root, { commitSha: "a".repeat(40) })).toMatchObject({
      binding: "unbound",
      commitSha: null,
      checkoutSha: null,
    });
    const git = (args: string[]) =>
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd: root,
        encoding: "utf8",
      });
    git(["init", "--quiet"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "Test"]);
    await writeFile(join(root, "fixture.txt"), "first\n");
    git(["add", "fixture.txt"]);
    git(["commit", "--quiet", "-m", "first"]);
    const first = git(["rev-parse", "HEAD"]).trim();
    const actual = resolveRepositoryProvenance(root);
    expect(
      resolveRepositoryProvenance(root, {
        commitSha: first,
        checkoutSha: first,
        repositoryId: actual.repositoryId,
        dirtyHash: actual.dirtyHash,
      }),
    ).toMatchObject({ binding: "verified", commitSha: first, checkoutSha: first });
    expect(() => resolveRepositoryProvenance(root, { checkoutSha: "a".repeat(40) })).toThrow(
      expect.objectContaining({ code: "PRECONDITION_FAILED" }),
    );
    await writeFile(join(root, "fixture.txt"), "second\n");
    expect(resolveRepositoryProvenance(root).dirtyHash).not.toBe(actual.dirtyHash);
    git(["add", "fixture.txt"]);
    git(["commit", "--quiet", "-m", "second"]);
    const second = git(["rev-parse", "HEAD"]).trim();
    expect(
      resolveRepositoryProvenance(root, { commitSha: first, checkoutSha: second }),
    ).toMatchObject({
      binding: "verified",
      commitSha: first,
      checkoutSha: second,
      limitations: ["synthetic-merge-checkout-differs-from-assessed-head"],
    });
    expect(() => resolveRepositoryProvenance(root, { commitSha: "a".repeat(40) })).toThrow(
      expect.objectContaining({ code: "PRECONDITION_FAILED" }),
    );
    // An untracked nested clone (for example a checked-out tool) is one `dir/` entry.
    execFileSync("git", ["init", "--quiet", join(root, "nested-tool")]);
    await writeFile(join(root, "nested-tool", "tool.js"), "tool\n");
    expect(resolveRepositoryProvenance(root)).toMatchObject({
      binding: "verified",
      dirtyHash: expect.any(String),
      limitations: ["working-tree-dirty", "untracked-nested-repository-unhashed"],
    });
    await writeFile(join(root, ".git", "info", "exclude"), "/nested-tool/\n");
    expect(resolveRepositoryProvenance(root)).toMatchObject({ dirtyHash: null, limitations: [] });
    await writeFile(join(root, ".gitattributes"), "fixture.txt filter=hostile\n");
    git(["config", "filter.hostile.clean", "touch provenance-filter-escaped"]);
    git(["config", "filter.hostile.process", "touch provenance-filter-escaped"]);
    git(["config", "filter.hostile.required", "true"]);
    await writeFile(join(root, "fixture.txt"), "dirty filter input\n");
    expect(resolveRepositoryProvenance(root).dirtyHash).not.toBeNull();
    expect(() => execFileSync("test", ["-e", join(root, "provenance-filter-escaped")])).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves dirty content hashes across chunk boundaries and invalidates cached same-size edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-provenance-stream-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  try {
    git(["init", "--quiet"]);
    git([
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "user.name=Test",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "initial",
    ]);
    const path = join(root, "payload.bin");
    for (const size of [0, 1, 2, 3, 192 * 1024 - 1, 192 * 1024, 192 * 1024 + 1]) {
      const content = Buffer.alloc(size, 0xff);
      await writeFile(path, content);
      const expected = semanticHash({
        diff: "",
        untracked: [{ path: "payload.bin", hash: semanticHash(content.toString("base64")) }],
      });
      expect(resolveRepositoryProvenance(root).dirtyHash).toBe(expected);
      expect(resolveRepositoryProvenance(root).dirtyHash).toBe(expected);
    }
    const original = resolveRepositoryProvenance(root).dirtyHash;
    const metadata = await stat(path);
    await writeFile(path, Buffer.alloc(metadata.size, 0x61));
    await utimes(path, metadata.atime, metadata.mtime);
    expect(resolveRepositoryProvenance(root).dirtyHash).not.toBe(original);
    expect(() => resolveRepositoryProvenance(root, { dirtyHash: original })).toThrow(
      expect.objectContaining({ code: "PRECONDITION_FAILED" }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("never lists or opens the project data directory, whose live database this process holds", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-provenance-datadir-"));
  const outside = await mkdtemp(join(tmpdir(), "tm-provenance-outside-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  try {
    git(["init", "--quiet"]);
    git([
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "user.name=Test",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "initial",
    ]);
    const dataDir = join(root, ".testmaster");
    await mkdir(join(dataDir, "runs"), { recursive: true });
    await writeFile(join(dataDir, "testmaster.db"), "database v1");
    await writeFile(join(dataDir, "testmaster.db-wal"), "wal v1");
    // Positive control 1: without the exclusion a change inside the data directory moves the hash.
    const listed = resolveRepositoryProvenance(root).dirtyHash;
    expect(listed).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(join(dataDir, "testmaster.db"), "database v1 plus more bytes");
    expect(resolveRepositoryProvenance(root).dirtyHash).not.toBe(listed);
    // Positive control 2: git lists an unreadable file and hashing it fails with EACCES, so any
    // open under the data directory would throw. Root ignores file modes, so skip it there.
    const unreadable = join(dataDir, "runs", "locked.bin");
    const enforced = process.getuid?.() !== 0;
    if (enforced) {
      await writeFile(unreadable, "locked");
      await chmod(unreadable, 0o000);
      expect(() => resolveRepositoryProvenance(root)).toThrow(/EACCES/);
    }
    const clean = resolveRepositoryProvenance(root, undefined, { dataDir });
    expect(clean).toMatchObject({ binding: "verified", dirtyHash: null, limitations: [] });
    // Run after run, the data directory churns without moving the dirty hash.
    await writeFile(join(dataDir, "testmaster.db"), "database v2, much longer");
    await writeFile(join(dataDir, "new-evidence.json"), "{}");
    expect(resolveRepositoryProvenance(root, undefined, { dataDir }).dirtyHash).toBeNull();
    // The same directory reached through a symlink is excluded too.
    await symlink(dataDir, join(root, "alias"));
    expect(
      resolveRepositoryProvenance(root, undefined, { dataDir: join(root, "alias") }).dirtyHash,
    ).toBeNull();
    // Control: any other untracked file still changes the hash.
    await writeFile(join(root, "app.js"), "one\n");
    const withApp = resolveRepositoryProvenance(root, undefined, { dataDir });
    expect(withApp.dirtyHash).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(join(dataDir, "testmaster.db"), "database v3");
    expect(resolveRepositoryProvenance(root, undefined, { dataDir }).dirtyHash).toBe(
      withApp.dirtyHash,
    );
    await writeFile(join(root, "app.js"), "two\n");
    expect(resolveRepositoryProvenance(root, undefined, { dataDir }).dirtyHash).not.toBe(
      withApp.dirtyHash,
    );
    // Remove the unreadable file: the checks below read the data directory without excluding it.
    if (enforced) await rm(unreadable);
    // A data directory outside the repository leaves the repository untouched and unaffected.
    await writeFile(join(outside, "testmaster.db"), "database");
    const external = resolveRepositoryProvenance(root, undefined, { dataDir: outside });
    expect(external.dirtyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(external.limitations).toContain("working-tree-dirty");
    // The repository root itself is never treated as a data directory.
    expect(resolveRepositoryProvenance(root, undefined, { dataDir: root }).dirtyHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
