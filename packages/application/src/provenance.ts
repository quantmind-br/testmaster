import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExecutablePlan, RunRequest } from "@testmaster/contracts";
import { type ArtifactManifest, ContractError, validate } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import type { EntityDocument } from "@testmaster/persistence";
import type { ImageLock } from "@testmaster/sandbox";
import type { ResolvedConfig } from "./config.js";
import { requireEntity, type ServiceContext } from "./context.js";
import { fixtureInputHashes } from "./input-fixtures.js";

export interface RepositoryProvenance {
  repositoryId: string | null;
  commitSha: string | null;
  checkoutSha: string | null;
  baseSha: string | null;
  dirtyHash: string | null;
  deploymentId: string | null;
  binding: "verified" | "unbound";
  limitations: string[];
}
export interface RuntimeIdentity {
  imageId: string;
  nodeVersion: string | null;
  playwrightVersion: string | null;
  browserName: string | null;
  browserVersion: string | null;
}
export function resolveRepositoryProvenance(
  cwd: string,
  claims?: RunRequest["provenance"],
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
  const paths = String(git(["-C", root, "ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean)
    .sort();
  const diff = String(
    git(
      ["-C", root, "diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"],
      filterOverrides,
    ),
  );
  const dirtyHash =
    diff || paths.length
      ? semanticHash({
          diff,
          untracked: paths.map((path) => {
            const absolute = join(root, path);
            const info = lstatSync(absolute);
            return {
              path,
              hash: semanticHash(
                info.isSymbolicLink()
                  ? readlinkSync(absolute)
                  : readFileSync(absolute).toString("base64"),
              ),
            };
          }),
        })
      : null;
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
  const callId = batchExtensions?.["testmaster:modelCallId"];
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
  const repository = resolveRepositoryProvenance(config.cwd, claims);
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
  const imageName =
    revision.runnerKind === "python" ? "testmaster-runner-python" : "testmaster-runner";
  const image = images?.[imageName];
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
