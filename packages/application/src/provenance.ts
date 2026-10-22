import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ExecutablePlan, RunRequest } from "@testmaster/contracts";
import { type ArtifactManifest, ContractError, validate } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import type { EntityDocument } from "@testmaster/persistence";
import {
  dataDirectoryPrefixes,
  insideDataDirectory,
  TESTMASTER_ARTIFACT_PATHSPECS,
  testmasterArtifact,
} from "@testmaster/planner";
import type { ImageLock } from "@testmaster/sandbox";
import type { ResolvedConfig } from "./config.js";
import { requireEntity, type ServiceContext } from "./context.js";
import { fixtureInputHashes } from "./input-fixtures.js";
import { runnerImageOf } from "./runner-kinds.js";

export interface RepositoryProvenance {
  repositoryId: string | null;
  commitSha: string | null;
  checkoutSha: string | null;
  baseSha: string | null;
  dirtyHash: string | null;
  deploymentId: string | null;
  binding: "verified" | "unbound";
  /** Present only when the commit was bound through a webhook-observed deployment instead of a local checkout. */
  bindingSource?: "github-deployment";
  limitations: string[];
}
export interface RuntimeIdentity {
  imageId: string;
  nodeVersion: string | null;
  playwrightVersion: string | null;
  browserName: string | null;
  browserVersion: string | null;
}
// Cache only unchanged inodes; ctime detects edits even when mtime is restored.
interface HashEntry {
  identity: string;
  hash: string;
}
const untrackedHashes = new Map<string, HashEntry>();
const hashBuffer = Buffer.allocUnsafe(192 * 1024);

/**
 * Cross-process copy of the identity -> hash cache, kept in the local project state directory so a
 * fresh CLI process does not re-read every untracked file. It is only a shortcut: an entry is used
 * under exactly the in-process rules (dev, ino, size, mtimeNs and ctimeNs all match, the file is
 * older than the timestamp tick) and an unreadable, corrupt, foreign or oversized file is ignored.
 * It holds repository-relative paths, identities and digests, never file content. It is a separate
 * file from the SQLite database and never touches it.
 */
const PERSISTENT_CACHE_DIRECTORY = "provenance-cache";
const PERSISTENT_CACHE_FILE = "untracked-hashes.json";
/** Bumped whenever the identity format or the digest construction changes. */
const PERSISTENT_CACHE_VERSION = 1;
/** Digest construction: sha256 of the JSON string of the base64 content (semanticHash of base64). */
const PERSISTENT_CACHE_ALGORITHM = "sha256-json-base64-v1";
const PERSISTENT_CACHE_MAX_ENTRIES = 100_000;
const PERSISTENT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const PERSISTENT_CACHE_MAX_FILE_BYTES = 64 * 1024 * 1024;
const IDENTITY_FORMAT = /^\d+:\d+:\d+:\d+:\d+$/u;
const DIGEST_FORMAT = /^[0-9a-f]{64}$/u;

class PersistentHashCache {
  readonly loaded: Map<string, HashEntry>;
  private readonly seen = new Map<string, HashEntry>();
  private bytes = 0;
  private readonly rootId: string;
  private readonly file: string;
  constructor(dataDir: string, root: string) {
    // Only a digest of the checkout path is persisted, so no absolute path reaches the file.
    this.rootId = createHash("sha256").update(root).digest("hex");
    this.file = join(dataDir, PERSISTENT_CACHE_DIRECTORY, PERSISTENT_CACHE_FILE);
    this.loaded = this.load();
  }
  private load(): Map<string, HashEntry> {
    let fd: number | undefined;
    try {
      fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > PERSISTENT_CACHE_MAX_FILE_BYTES) return new Map();
      // JSON.parse yields any; every field is validated before use.
      const parsed = JSON.parse(readFileSync(fd, "utf8")) as Record<string, unknown> | null;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        parsed.version !== PERSISTENT_CACHE_VERSION ||
        parsed.algorithm !== PERSISTENT_CACHE_ALGORITHM ||
        parsed.root !== this.rootId ||
        !Array.isArray(parsed.entries)
      )
        return new Map();
      const entries = new Map<string, HashEntry>();
      for (const row of parsed.entries as unknown[]) {
        if (
          !Array.isArray(row) ||
          row.length !== 3 ||
          typeof row[0] !== "string" ||
          typeof row[1] !== "string" ||
          typeof row[2] !== "string" ||
          !IDENTITY_FORMAT.test(row[1]) ||
          !DIGEST_FORMAT.test(row[2])
        )
          return new Map();
        entries.set(row[0], { identity: row[1], hash: row[2] });
      }
      return entries;
    } catch {
      return new Map();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  /** Records an entry trusted in this scan; entries not recorded are dropped when the file is saved. */
  remember(key: string, entry: HashEntry): void {
    if (this.seen.has(key)) return;
    const size = key.length + entry.identity.length + entry.hash.length + 16;
    if (
      this.seen.size >= PERSISTENT_CACHE_MAX_ENTRIES ||
      this.bytes + size > PERSISTENT_CACHE_MAX_BYTES
    )
      return;
    this.bytes += size;
    this.seen.set(key, entry);
  }
  /** Rewrites the file atomically when this scan changed it. Failures never affect admission. */
  save(): void {
    if (
      this.seen.size === this.loaded.size &&
      [...this.seen].every(([key, entry]) => {
        const previous = this.loaded.get(key);
        return previous?.identity === entry.identity && previous.hash === entry.hash;
      })
    )
      return;
    const directory = dirname(this.file);
    const temp = join(
      directory,
      `.${PERSISTENT_CACHE_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const body = JSON.stringify({
        version: PERSISTENT_CACHE_VERSION,
        algorithm: PERSISTENT_CACHE_ALGORITHM,
        root: this.rootId,
        entries: [...this.seen].map(([key, entry]) => [key, entry.identity, entry.hash]),
      });
      writeFileSync(temp, body, { flag: "wx", mode: 0o600 });
      renameSync(temp, this.file);
    } catch {
      try {
        unlinkSync(temp);
      } catch {}
    }
  }
}
function untrackedFileHash(
  path: string,
  persisted: { cache: PersistentHashCache; key: string } | null,
): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile())
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Repository contains a non-regular untracked file",
      );
    const identity = [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(
      ":",
    );
    // Files changed in the current filesystem timestamp tick must not be trusted from cache.
    const stable = before.ctimeNs < BigInt(Date.now() - 2000) * 1_000_000n;
    if (stable) {
      const hit = [untrackedHashes.get(path), persisted?.cache.loaded.get(persisted.key)].find(
        (entry) => entry?.identity === identity,
      );
      if (hit) {
        persisted?.cache.remember(persisted.key, hit);
        return hit.hash;
      }
    }
    // Preserve semanticHash(base64(bytes)) without allocating the entire file or JSON string.
    const hash = createHash("sha256").update('"');
    let offset = 0;
    let pending = 0;
    while (true) {
      const count = readSync(fd, hashBuffer, pending, hashBuffer.length - pending, offset);
      offset += count;
      const available = pending + count;
      const encoded = count === 0 ? available : available - (available % 3);
      hash.update(hashBuffer.subarray(0, encoded).toString("base64"));
      pending = available - encoded;
      if (!count) break;
      if (pending) hashBuffer.copy(hashBuffer, 0, encoded, available);
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Repository changed while collecting provenance",
      );
    const value = hash.update('"').digest("hex");
    const entry = { identity, hash: value };
    if (stable && (untrackedHashes.size < 100_000 || untrackedHashes.has(path)))
      untrackedHashes.set(path, entry);
    else untrackedHashes.delete(path);
    if (stable) persisted?.cache.remember(persisted.key, entry);
    return value;
  } finally {
    closeSync(fd);
  }
}

/**
 * `dataDir` is the project data directory (SQLite database, evidence). It is never listed or read:
 * this process holds the database open, and closing any other descriptor of a database file drops
 * the process's POSIX locks on it, which lets a concurrent writer delete the live WAL and SHM.
 * Its churn would also change `dirtyHash` on every run.
 * `persistCache` (with `dataDir`) also keeps the untracked-file digest cache in
 * `<dataDir>/provenance-cache/` so a fresh process reuses it; local project state only.
 */
export function resolveRepositoryProvenance(
  cwd: string,
  claims?: RunRequest["provenance"],
  options: { dataDir?: string; persistCache?: boolean } = {},
): RepositoryProvenance {
  const git = (args: string[], filterOverrides: string[] = []) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "protocol.allow=never",
        "-c",
        "core.sshCommand=/usr/bin/false",
        "-c",
        "credential.helper=",
        "-c",
        "submodule.recurse=false",
        "-c",
        "diff.ignoreSubmodules=all",
        "-c",
        "diff.external=",
        ...filterOverrides,
        ...args,
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          LANG: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_PAGER: "cat",
        },
      },
    );
  const unbound: RepositoryProvenance = {
    repositoryId: null,
    commitSha: null,
    checkoutSha: null,
    baseSha: null,
    dirtyHash: null,
    deploymentId: claims?.deploymentId ?? null,
    binding: "unbound",
    limitations: ["repository-commit-unavailable"],
  };
  let checkout: string;
  let root: string;
  try {
    checkout = String(git(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    root = String(git(["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return unbound;
  }
  let filterKeys: string[] = [];
  try {
    filterKeys = git([
      "config",
      "--includes",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ])
      .split("\0")
      .filter(Boolean);
  } catch (error) {
    if (!error || typeof error !== "object" || !("status" in error) || error.status !== 1)
      throw error;
  }
  const filterOverrides = filterKeys.flatMap((key) => [
    "-c",
    `${key}=${key.endsWith(".required") ? "false" : ""}`,
  ]);
  const refuse = (field: string): never => {
    throw new ContractError(
      "PRECONDITION_FAILED",
      "Repository provenance claim does not match checkout",
      { field },
    );
  };
  const assessed = claims?.commitSha ?? checkout;
  if (!/^[0-9a-f]{40}$/u.test(assessed)) refuse("commitSha");
  if (claims?.checkoutSha && claims.checkoutSha !== checkout) refuse("checkoutSha");
  try {
    git(["merge-base", "--is-ancestor", assessed, checkout]);
  } catch {
    refuse("commitSha");
  }
  if (claims?.baseSha) {
    if (!/^[0-9a-f]{40}$/u.test(claims.baseSha)) refuse("baseSha");
    try {
      git(["merge-base", "--is-ancestor", claims.baseSha, assessed]);
    } catch {
      refuse("baseSha");
    }
  }
  let repositoryId = `local:${semanticHash(root)}`;
  try {
    const remote = String(git(["config", "--get", "remote.origin.url"])).trim();
    const match = /^(?:https?:\/\/|ssh:\/\/)?(?:[^/@]+@)?([^/:]+)[:/](.+?)(?:\.git)?$/u.exec(
      remote,
    );
    if (match)
      repositoryId = `${match[1]!.toLowerCase()}/${match[2]!.replace(/\.git$/u, "").replace(/\/$/u, "")}`;
  } catch {}
  if (
    claims?.repositoryId &&
    claims.repositoryId !== repositoryId &&
    `github.com/${claims.repositoryId}` !== repositoryId
  )
    refuse("repositoryId");
  if (claims?.repositoryId) repositoryId = claims.repositoryId;
  const dataPrefixes = dataDirectoryPrefixes(root, options.dataDir);
  const paths = String(git(["-C", root, "ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter((path) => path && !insideDataDirectory(path, dataPrefixes) && !testmasterArtifact(path))
    .sort();
  const diff = String(
    git(
      [
        "-C",
        root,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "HEAD",
        "--",
        ".",
        ...TESTMASTER_ARTIFACT_PATHSPECS,
      ],
      filterOverrides,
    ),
  );
  const persisted =
    options.persistCache && options.dataDir && paths.length
      ? new PersistentHashCache(options.dataDir, root)
      : null;
  let dirtyHash: string | null = null;
  if (diff || paths.length) {
    const untracked = paths.map((path) => {
      const absolute = join(root, path);
      const info = lstatSync(absolute);
      // Git lists an untracked nested repository as one `dir/` entry; its content is not
      // hashed, but the entry still marks the tree dirty.
      if (info.isDirectory()) return { path, hash: null };
      return {
        path,
        hash: info.isSymbolicLink()
          ? semanticHash(readlinkSync(absolute))
          : untrackedFileHash(absolute, persisted && { cache: persisted, key: path }),
      };
    });
    persisted?.save();
    dirtyHash = semanticHash({ diff, untracked });
  }
  if (claims?.dirtyHash !== undefined && claims.dirtyHash !== dirtyHash) refuse("dirtyHash");
  return {
    repositoryId,
    commitSha: assessed,
    checkoutSha: checkout,
    baseSha: claims?.baseSha ?? null,
    dirtyHash,
    deploymentId: claims?.deploymentId ?? null,
    binding: "verified",
    limitations: [
      ...(assessed !== checkout ? ["synthetic-merge-checkout-differs-from-assessed-head"] : []),
      ...(dirtyHash ? ["working-tree-dirty"] : []),
      ...(paths.some((path) => path.endsWith("/")) ? ["untracked-nested-repository-unhashed"] : []),
    ],
  };
}
/**
 * Provenance for a Run admission. A `deploymentId` claim is never taken at face value: it binds only when
 * this workspace recorded a successful GitHub deployment status for that deployment and exactly that SHA in
 * that repository (INV-014). Any other claim is `unbound`; a local checkout cannot vouch for a deployment.
 */
export function resolveRunProvenance(
  ctx: ServiceContext,
  cwd: string,
  claims?: RunRequest["provenance"],
  options: { dataDir?: string } = {},
): RepositoryProvenance {
  // The server profile (PostgreSQL) keeps only the in-process cache; its storage root is not a
  // per-checkout state directory.
  if (!claims?.deploymentId)
    return resolveRepositoryProvenance(cwd, claims, {
      ...options,
      persistCache: ctx.database.engine === "sqlite",
    });
  const unbound: RepositoryProvenance = {
    repositoryId: claims.repositoryId ?? null,
    commitSha: null,
    checkoutSha: null,
    baseSha: claims.baseSha ?? null,
    dirtyHash: null,
    deploymentId: claims.deploymentId,
    binding: "unbound",
    limitations: ["deployment-unverified"],
  };
  if (!claims.commitSha || !claims.repositoryId) return unbound;
  const rows = ctx.database.all(
    "SELECT full_name, sha, state, delivery_id FROM github_deployments WHERE workspace_id=? AND deployment_id=?",
    ctx.workspaceId,
    claims.deploymentId,
  );
  const match = rows.find(
    (row) =>
      row.sha === claims.commitSha &&
      row.state === "success" &&
      `github.com/${String(row.full_name)}` === claims.repositoryId,
  );
  const manual = String(match?.delivery_id ?? "").startsWith("manual:");
  const bound = Boolean(match);
  if (!bound) return unbound;
  return {
    repositoryId: claims.repositoryId,
    commitSha: claims.commitSha,
    checkoutSha: claims.checkoutSha ?? claims.commitSha,
    baseSha: claims.baseSha ?? null,
    dirtyHash: null,
    deploymentId: claims.deploymentId,
    binding: "verified",
    bindingSource: "github-deployment",
    limitations: [
      "deployment-bound-without-local-checkout",
      ...(manual ? ["deployment-attested-manually"] : []),
      ...(claims.checkoutSha && claims.checkoutSha !== claims.commitSha
        ? ["synthetic-merge-checkout-differs-from-assessed-head"]
        : []),
    ],
  };
}
export interface AdmissionSnapshot {
  revisionHash: string;
  environmentHash: string;
  sourceRevisions: { id: string; contentHash: string }[];
  modelConfigHash: string | null;
  generationModelCallId: string | null;
  configuredModelHash: string | null;
  modelProviders: ResolvedConfig["modelProviders"];
  profilePolicy: ResolvedConfig["profilePolicy"];
  images: ImageLock | null;
  inputHash?: string;
  inputFixtureHashes?: Record<string, string>;
  runnerImageDigest: string | null;
  browserImageDigest: string | null;
  buildInputsHash: string | null;
  seccompHash: string | null;
  dependenciesLockHash: string | null;
  capabilityManifestHash: string;
  generationModel: Record<string, unknown> | null;
  requiredCapabilities: string[];
  policyHash: string;
  seed: number;
  repository: RepositoryProvenance;
  runtimeIdentity: RuntimeIdentity | null;
  limitations: string[];
}
export function admissionSnapshot(
  ctx: ServiceContext,
  revision: EntityDocument,
  environment: EntityDocument,
  config: ResolvedConfig,
  images: ImageLock | null,
  seed: number,
  claims?: RunRequest["provenance"],
  runtimeIdentity: RuntimeIdentity | null = null,
): AdmissionSnapshot {
  const sourceIds = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string" && /^svr_[0-9a-f-]+$/u.test(value)) sourceIds.add(value);
    else if (value && typeof value === "object")
      for (const child of Object.values(value)) visit(child);
  };
  visit(revision.plan);
  // A probe binds the API description it generates examples from (ADR-033).
  visit(revision.probe);
  const requirementIds = (
    revision.plan && typeof revision.plan === "object" && "requirementRefs" in revision.plan
      ? revision.plan.requirementRefs
      : []
  ) as string[];
  for (const id of requirementIds) visit(requireEntity(ctx, "Requirement", id));
  const extensions = revision.extensions as Record<string, unknown> | undefined;
  const proposalId = extensions?.["testmaster:proposalId"];
  if (typeof proposalId === "string") visit(requireEntity(ctx, "Proposal", proposalId));
  const batchId = extensions?.["testmaster:batchId"];
  const batch = typeof batchId === "string" ? requireEntity(ctx, "ProposalBatch", batchId) : null;
  const batchExtensions = batch?.extensions as Record<string, unknown> | undefined;
  // Generated code records the call that wrote it; a generated plan's call is on its batch.
  const callId =
    extensions?.["testmaster:generationModelCallId"] ?? batchExtensions?.["testmaster:modelCallId"];
  const callRow =
    typeof callId === "string"
      ? ctx.database.get(
          "SELECT data_json FROM model_calls WHERE workspace_id=? AND id=?",
          ctx.workspaceId,
          callId,
        )
      : null;
  const call = callRow ? (JSON.parse(String(callRow.data_json)) as EntityDocument) : null;
  visit(call);
  const sources = [...sourceIds].sort().map((id) => {
    const source = requireEntity(ctx, "SourceRevision", id);
    return { id, contentHash: String(source.contentHash) };
  });
  const repository = resolveRunProvenance(ctx, config.cwd, claims, { dataDir: config.dataDir });
  const limitations = [
    "mutable-external-target",
    "mutable-external-payload",
    "browser-platform-rendering",
  ];
  limitations.push(...repository.limitations);
  if (!runtimeIdentity?.browserVersion) limitations.push("browser-version-unavailable");
  if (!sources.length) limitations.push("source-binding-unavailable");
  if (!images)
    limitations.push(
      "runner-image-digest-unavailable",
      "browser-image-digest-unavailable",
      "build-input-hash-unavailable",
      "seccomp-hash-unavailable",
    );
  if (
    call ||
    revision.origin === "generated" ||
    config.effectiveConfig.config.execution?.mode === "agent"
  )
    limitations.push("remote-model-snapshot-unavailable");
  if (revision.origin === "generated" && !call?.modelConfigHash)
    limitations.push("generation-model-config-hash-unavailable");
  const image = images?.[runnerImageOf(revision.runnerKind)];
  const codeRef =
    revision.codeRef && typeof revision.codeRef === "object"
      ? (revision.codeRef as Record<string, unknown>)
      : null;
  const dependency =
    typeof codeRef?.dependencyLockRef === "string"
      ? requireEntity(ctx, "Artifact", codeRef.dependencyLockRef)
      : null;
  if (!dependency) limitations.push("source-dependency-lock-unavailable");
  const generationModel = call
    ? Object.fromEntries(
        [
          "id",
          "provider",
          "model",
          "modelConfigHash",
          "promptHash",
          "responseHash",
          "promptVersion",
          "schemaVersion",
          "sourceRevisionIds",
          "usage",
          "cost",
        ]
          .filter((key) => call[key] !== undefined)
          .map((key) => [key, call[key]]),
      )
    : null;
  return {
    revisionHash: String(revision.contentHash),
    environmentHash: semanticHash(environment),
    sourceRevisions: sources,
    inputFixtureHashes: fixtureInputHashes(
      ctx,
      String(requireEntity(ctx, "TestCase", String(revision.testId)).projectId),
      revision.plan as ExecutablePlan | null,
    ),
    modelConfigHash: typeof call?.modelConfigHash === "string" ? call.modelConfigHash : null,
    generationModelCallId: typeof callId === "string" ? callId : null,
    configuredModelHash: config.modelProviders.length ? semanticHash(config.modelProviders) : null,
    modelProviders: structuredClone(config.modelProviders),
    profilePolicy: structuredClone(config.profilePolicy),
    runnerImageDigest: image?.imageId ?? null,
    browserImageDigest: image?.baseDigest ?? null,
    buildInputsHash: image?.buildInputsHash ?? null,
    seccompHash: image?.seccomp.profileSha256 ?? null,
    dependenciesLockHash: dependency ? String(dependency.hash) : null,
    capabilityManifestHash: semanticHash({
      schemaVersion: "1.0.0",
      runnerKind: revision.runnerKind,
    }),
    generationModel,
    images: images ? structuredClone(images) : null,
    requiredCapabilities: [String(revision.runnerKind)],
    policyHash: config.effectiveConfig.policyHash,
    seed,
    repository,
    runtimeIdentity: runtimeIdentity ? structuredClone(runtimeIdentity) : null,
    limitations,
  };
}
export function provenanceError(incompatibility: string): ContractError {
  return new ContractError(
    "PRECONDITION_FAILED",
    "Strict execution snapshot cannot be reproduced",
    { reasonCode: "security_precondition_failed", incompatibility },
  );
}
export function verifyAdmission(
  run: EntityDocument,
  revision: EntityDocument,
  environment: EntityDocument,
  images: ImageLock | null,
  ctx?: ServiceContext,
): AdmissionSnapshot {
  const cell = run.matrixCell as Record<string, unknown>;
  const snapshot = cell.admissionSnapshot as AdmissionSnapshot | undefined;
  if (!snapshot || semanticHash(snapshot) !== cell.admissionSnapshotHash)
    throw provenanceError("snapshot_hash_mismatch");
  if (
    snapshot.revisionHash !== revision.contentHash ||
    (revision.plan && semanticHash(revision.plan, "plan") !== snapshot.revisionHash)
  )
    throw provenanceError("revision_hash_mismatch");
  if (snapshot.environmentHash !== semanticHash(environment))
    throw provenanceError("environment_hash_mismatch");
  if (ctx)
    for (const binding of snapshot.sourceRevisions) {
      const source = requireEntity(ctx, "SourceRevision", binding.id);
      if (source.contentHash !== binding.contentHash) throw provenanceError("source_hash_mismatch");
    }
  const effective = validate<{ policyHash: string }>("EffectiveConfig", cell.effectiveConfig);
  if (snapshot.policyHash !== effective.policyHash || snapshot.seed !== cell.seed)
    throw provenanceError("policy_or_seed_hash_mismatch");
  if (snapshot.inputHash !== admissionInputHash(cell))
    throw provenanceError("execution_input_hash_mismatch");
  if (
    cell.executor !== "process" &&
    (!snapshot.images || !images || semanticHash(snapshot.images) !== semanticHash(images))
  )
    throw provenanceError("image_digest_changed");
  if (snapshot.runtimeIdentity && snapshot.runtimeIdentity.imageId !== snapshot.runnerImageDigest)
    throw provenanceError("runtime_identity_image_mismatch");
  if (!snapshot.requiredCapabilities.includes(String(revision.runnerKind)))
    throw provenanceError("capability_incompatible");
  return snapshot;
}
export function admissionInputHash(cell: Record<string, unknown>): string {
  return semanticHash({
    effectiveConfig: cell.effectiveConfig,
    baseUrl: cell.baseUrl,
    limits: cell.limits,
    // Present only when the request capped steps, so the hash of a run without a cap is unchanged.
    ...(cell.stepTimeoutCapMs === undefined ? {} : { stepTimeoutCapMs: cell.stepTimeoutCapMs }),
    // Present only for a tunnelled Run, so the hash of every other run is unchanged (ADR-031).
    ...(cell.tunnelId === undefined ? {} : { tunnelId: cell.tunnelId }),
    // Present only for a Run with visual assertions: the baselines it compares against (ADR-032).
    ...(cell.visualBaselines === undefined ? {} : { visualBaselines: cell.visualBaselines }),
    seed: cell.seed,
    executor: cell.executor,
    repetitionIndex: cell.repetitionIndex ?? null,
    flakePredecessorRunId: cell.flakePredecessorRunId ?? null,
    fixtureHash: cell.fixtureHash ?? null,
    dependencyBindings: cell.dependencyBindings ?? [],
  });
}
export function reproduction(
  snapshot: AdmissionSnapshot,
  originalRunId?: string,
  fresh = false,
): NonNullable<ArtifactManifest["reproduction"]> {
  return {
    degree: fresh ? "fresh-llm-regeneration" : "strict-execution-replay",
    limitations: snapshot.limitations,
    ...(originalRunId ? { originalRunId } : {}),
  };
}
