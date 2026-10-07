import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
