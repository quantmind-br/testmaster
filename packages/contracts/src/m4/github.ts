import { type Static, Type } from "@sinclair/typebox";
import * as P from "../primitives.js";

/**
 * GitHub App and preview contracts (ADR-020). The App installation, repository allowlist, pull request
 * state and check publications are server-owned records; settings are the only operator-writable part.
 */
export const githubForkPolicies = ["deny", "fixture-only"] as const;
export const githubPreviewProviders = ["github-deployments", "manual"] as const;
export const githubInstallationStates = ["active", "revoked"] as const;
export const githubPullStates = [
  "awaiting_preview",
  "running",
  "completed",
  "superseded",
  "timed_out",
  "denied",
  "skipped",
  "closed",
] as const;
export const githubCheckStates = [
  "pending",
  "delivered",
  "rate_limited",
  "permission_revoked",
  "host_unavailable",
  "dead_letter",
] as const;
export const githubCheckConclusions = [
  "success",
  "failure",
  "neutral",
  "cancelled",
  "action_required",
] as const;
export const githubCheckStatuses = ["queued", "in_progress", "completed"] as const;
/** Events the App subscribes to (ADR-020). */
export const githubEventTypes = [
  "installation",
  "installation_repositories",
  "push",
  "pull_request",
  "deployment_status",
  "check_run",
] as const;

const Selection = Type.Union([
  P.Obj({ kind: Type.Literal("all") }),
  P.Obj({ kind: Type.Literal("tests"), testIds: Type.Array(P.id("tst"), { minItems: 1, maxItems: 200 }) }),
]);
const Preview = P.Obj({
  provider: P.Enum(githubPreviewProviders),
  /** Glob over the deployment `environment` name; `*` matches every environment. */
  environmentPattern: Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9*?._/ -]+$" }),
  timeoutMs: Type.Integer({ minimum: 1000, maximum: 86_400_000 }),
});
const NullableId = (prefix: "env" | "prj") => Type.Union([P.id(prefix), Type.Null()]);

/** Per-repository bindings; a repository runs nothing until it is enabled and bound to a project. */
export const GithubRepositorySettings = P.Obj({
  enabled: Type.Boolean(),
  projectId: NullableId("prj"),
  includeDrafts: Type.Boolean(),
  forkPolicy: P.Enum(githubForkPolicies),
  selection: Selection,
  /** Environment whose locale, timezone and policy are copied into each ephemeral preview environment. */
  baseEnvironmentId: NullableId("env"),
  /** Environment used for `fixture-only` fork runs; it must have no auth profile and its plans no secret refs. */
  fixtureEnvironmentId: NullableId("env"),
  preview: Preview,
});
export const githubDefaultRepositorySettings = {
  enabled: false,
  projectId: null,
  includeDrafts: false,
  forkPolicy: "deny",
  selection: { kind: "all" },
  baseEnvironmentId: null,
  fixtureEnvironmentId: null,
  preview: { provider: "github-deployments", environmentPattern: "*", timeoutMs: 1_800_000 },
} as const satisfies Static<typeof GithubRepositorySettings>;

const AppId = Type.String({ pattern: "^[0-9]{1,20}$" });
const Credentials = P.Obj({
  privateKeyRef: P.id("sec"),
  webhookSecretRef: P.id("sec"),
  /** Previous webhook secret accepted until `previousWebhookSecretExpiresAt` (24 h rotation window). */
  previousWebhookSecretRef: Type.Union([P.id("sec"), Type.Null()]),
  previousWebhookSecretExpiresAt: Type.Union([P.Timestamp, Type.Null()]),
  clientSecretRef: Type.Union([P.id("sec"), Type.Null()]),
});
/** Integration `settings` for provider `github`. */
export const GithubIntegrationSettings = P.Obj({
  appId: AppId,
  appSlug: Type.Union([P.Name, Type.Null()]),
  /** Origin used in comment and check links; defaults to the server profile public origin. */
  publicOrigin: Type.Union([Type.String({ minLength: 8, maxLength: 200 }), Type.Null()]),
  /** `contents: write` is requested, and agent branches/PRs are possible, only when this is true. */
  allowAgentPullRequests: Type.Boolean(),
  credentials: Credentials,
});
export const githubDefaultScopes = [
  "github:metadata:read",
  "github:contents:read",
  "github:checks:write",
  "github:pull_requests:write",
  "github:deployments:read",
] as const;

export const githubContracts = {
  GithubRepositorySettings,
  GithubIntegrationSettings,
  GithubManifestInput: P.Obj({
    name: Type.String({ minLength: 3, maxLength: 34, pattern: "^[A-Za-z0-9][A-Za-z0-9 _-]*$" }),
    publicOrigin: Type.String({ minLength: 8, maxLength: 200 }),
    redirectUrl: Type.String({ minLength: 8, maxLength: 300 }),
    allowAgentPullRequests: Type.Optional(Type.Boolean()),
    /** GitHub organization that owns the App; omitted for a personal account. */
    organization: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9-]{0,38}$" })),
  }),
  GithubManifestReceipt: P.Obj({
    state: P.Name,
    expiresAt: P.Timestamp,
    /** URL that receives the manifest as a form post from the operator's browser. */
    createUrl: P.Name,
    manifest: P.Json,
    scopes: Type.Array(P.Name),
  }),
  GithubManifestConversionInput: P.Obj({
    code: Type.String({ minLength: 4, maxLength: 200, pattern: "^[A-Za-z0-9_-]+$" }),
    projectIds: Type.Array(P.id("prj"), { maxItems: 100 }),
  }),
  GithubRepositoryPatch: Type.Partial(
    P.Obj({
      enabled: Type.Boolean(),
      projectId: NullableId("prj"),
      includeDrafts: Type.Boolean(),
      forkPolicy: P.Enum(githubForkPolicies),
      selection: Selection,
      baseEnvironmentId: NullableId("env"),
      fixtureEnvironmentId: NullableId("env"),
      preview: Type.Partial(Preview),
    }),
  ),
  GithubRotateWebhookSecretInput: P.Obj({ secretRef: P.id("sec") }),
  GithubRepository: P.Obj({
    repositoryId: P.Name,
    installationId: P.Name,
    fullName: P.Name,
    private: Type.Boolean(),
    /** False when the installation no longer grants the repository (removed or revoked). */
    granted: Type.Boolean(),
    settings: GithubRepositorySettings,
    version: P.Version,
  }),
  GithubInstallation: P.Obj({
    /** Same as `installationId`; present so lists page like every other collection. */
    id: P.Name,
    createdAt: P.Timestamp,
    installationId: P.Name,
    integrationId: P.Name,
    accountLogin: P.Name,
    accountType: P.Enum(["User", "Organization"]),
    repositorySelection: P.Enum(["all", "selected"]),
    state: P.Enum(githubInstallationStates),
    revokedReason: Type.Union([P.Name, Type.Null()]),
    permissions: Type.Record(Type.String(), Type.String()),
    repositories: Type.Array(
      P.Obj({
        repositoryId: P.Name,
        fullName: P.Name,
        private: Type.Boolean(),
        granted: Type.Boolean(),
        enabled: Type.Boolean(),
        projectId: NullableId("prj"),
      }),
    ),
    updatedAt: P.Timestamp,
  }),
  GithubPull: P.Obj({
    id: P.Name,
    integrationId: P.Name,
    installationId: P.Name,
    repositoryId: P.Name,
    repositoryFullName: P.Name,
    prNumber: P.Positive,
    headSha: Type.String({ pattern: "^[0-9a-f]{40}$" }),
    baseSha: Type.String({ pattern: "^[0-9a-f]{40}$" }),
    /** Synthetic merge checkout, when GitHub reports one; the assessed commit stays `headSha`. */
    mergeSha: Type.Union([Type.String({ pattern: "^[0-9a-f]{40}$" }), Type.Null()]),
    fork: Type.Boolean(),
    draft: Type.Boolean(),
    state: P.Enum(githubPullStates),
    reasonCode: Type.Union([P.Name, Type.Null()]),
    projectId: NullableId("prj"),
    previewUrl: Type.Union([Type.String(), Type.Null()]),
    deploymentId: Type.Union([P.Name, Type.Null()]),
    previewDeadlineAt: Type.Union([P.Timestamp, Type.Null()]),
    batchId: Type.Union([P.id("bat"), Type.Null()]),
    supersededBy: Type.Union([Type.String({ pattern: "^[0-9a-f]{40}$" }), Type.Null()]),
    gate: Type.Union([P.Gate, Type.Null()]),
    createdAt: P.Timestamp,
    updatedAt: P.Timestamp,
  }),
  GithubCheck: P.Obj({
    id: P.Name,
    pullId: P.Name,
    repositoryFullName: P.Name,
    headSha: Type.String({ pattern: "^[0-9a-f]{40}$" }),
    name: P.Enum(["TestMaster / result", "TestMaster / required-gate"]),
    status: P.Enum(githubCheckStatuses),
    conclusion: Type.Union([P.Enum(githubCheckConclusions), Type.Null()]),
    state: P.Enum(githubCheckStates),
    sequence: P.Nonnegative,
    deliveredSequence: Type.Integer({ minimum: -1 }),
    attempts: P.Nonnegative,
    nextAttemptAt: Type.Union([P.Timestamp, Type.Null()]),
    lastError: Type.Union([P.Name, Type.Null()]),
    remoteId: Type.Union([P.Name, Type.Null()]),
    createdAt: P.Timestamp,
    updatedAt: P.Timestamp,
  }),
  /** A human-supplied preview URL for a PR head (`manual` provider). */
  PreviewDeploymentInput: P.Obj({
    integrationId: P.Name,
    repositoryId: P.Name,
    prNumber: P.Positive,
    headSha: Type.String({ pattern: "^[0-9a-f]{40}$" }),
    url: Type.String({ minLength: 8, maxLength: 2000 }),
  }),
};
export type GithubRepositorySettings = Static<typeof GithubRepositorySettings>;
export type GithubIntegrationSettings = Static<typeof GithubIntegrationSettings>;
export type GithubManifestInput = Static<typeof githubContracts.GithubManifestInput>;
export type GithubManifestReceipt = Static<typeof githubContracts.GithubManifestReceipt>;
export type GithubManifestConversionInput = Static<
  typeof githubContracts.GithubManifestConversionInput
>;
export type GithubRepositoryPatch = Static<typeof githubContracts.GithubRepositoryPatch>;
export type GithubRotateWebhookSecretInput = Static<
  typeof githubContracts.GithubRotateWebhookSecretInput
>;
export type GithubRepository = Static<typeof githubContracts.GithubRepository>;
export type GithubInstallation = Static<typeof githubContracts.GithubInstallation>;
export type GithubPull = Static<typeof githubContracts.GithubPull>;
export type GithubCheck = Static<typeof githubContracts.GithubCheck>;
export type PreviewDeploymentInput = Static<typeof githubContracts.PreviewDeploymentInput>;
