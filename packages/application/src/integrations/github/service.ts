import { randomBytes, randomUUID } from "node:crypto";
import {
  ContractError,
  type GithubCheck,
  type GithubInstallation,
  type GithubIntegrationSettings,
  type GithubManifestConversionInput,
  type GithubManifestInput,
  type GithubManifestReceipt,
  type GithubPull,
  type GithubRepository,
  type GithubRepositoryPatch,
  type GithubRepositorySettings,
  githubEventTypes,
  type IntegrationMetadata,
  type PreviewDeploymentInput,
  validate,
} from "@testmaster/contracts";
import { OutboxRepository } from "@testmaster/persistence";
import { EgressPolicy, PolicyDenied } from "@testmaster/sandbox";
import type { Application } from "../../application.js";
import { auditAs, auditSecurity } from "../../audit.js";
import { allEntities, requireEntity } from "../../context.js";
import {
  type CheckPayload,
  ChecksClient,
  deliveryBackoffMs,
  deliveryRetryPolicy,
} from "../../delivery.js";
import {
  type InboundOutcome,
  type InboundRequest,
  type IntegrationContext,
  type StoredIntegration,
  verifyHmacSha256,
} from "../provider.js";
import { appJwt, classifyProblem, GithubApiError, retryAfterOf } from "./api.js";
import { buildManifest, manifestCreateUrl, manifestPermissions } from "./manifest.js";
import { type GithubEvent, type PullRequestEvent, parseGithubEvent } from "./payloads.js";
import {
  checkExternalId,
  commentMarker,
  renderChecks,
  renderComment,
  type StoredResult,
} from "./render.js";
import { storedResultForBatch } from "./results.js";
import type { GithubRuntime } from "./runtime.js";
import {
  type CheckRecord,
  GithubStore,
  type InstallationRecord,
  type PullRecord,
  type RepositoryRecord,
  terminalPullStates,
} from "./store.js";

const MANIFEST_TTL_MS = 600_000;
const WEBHOOK_ROTATION_MS = 86_400_000;
const REVOKED_KEY = "integration:revoked:github:";
const handledPullActions = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
  "closed",
  "converted_to_draft",
]);
const COMMENT_MAX_ATTEMPTS = 10;

/** Settings, consent and references of a stored `github` integration. */
export interface GithubIntegration {
  id: string;
  workspaceId: string;
  name: string;
  state: "active" | "paused" | "revoked";
  projectIds: string[];
  events: string[];
  secretRefs: string[];
  consent: { grantedBy: string; scopes: string[] };
  settings: GithubIntegrationSettings;
  version: number;
}
interface Credentials {
  appId: string;
  privateKeyPem: string;
}

export function globMatch(pattern: string, value: string): boolean {
  const source = [...pattern]
    .map((character) =>
      character === "*"
        ? ".*"
        : character === "?"
          ? "."
          : character.replace(/[.+^${}()|[\]\\/-]/gu, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`, "u").test(value);
}
const hasSecretRef = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.some(hasSecretRef)
    : value !== null && typeof value === "object"
      ? Object.entries(value).some(([key, child]) => key === "secretRef" || hasSecretRef(child))
      : false;

/**
 * The GitHub App integration (ADR-020). Methods without a workspace argument are the authorized,
 * request-scoped surface; webhook intake and the reconciler take explicit workspace IDs and run on the
 * controller scope. Nothing here ever checks out repository code: verdicts bind to the SHA that a
 * webhook-observed deployment named.
 */
export class GithubService {
  constructor(
    private readonly app: Application,
    private readonly runtime: GithubRuntime,
  ) {}
  private get ctx() {
    return this.app.context;
  }
  private get scope(): Application {
    return this.app.controllerScope();
  }
  private get store(): GithubStore {
    return new GithubStore(this.app.database);
  }
  private get globalStore(): GithubStore {
    return new GithubStore(this.scope.database);
  }
  private now(): string {
    return this.runtime.now().toISOString();
  }

  // ---------------------------------------------------------------- integration access
  private loadIntegration(
    workspaceId: string,
    id: string,
    database = this.scope.database,
  ): GithubIntegration | null {
    const row = database.get(
      "SELECT * FROM integrations WHERE workspace_id=? AND id=? AND provider='github'",
      workspaceId,
      id,
    );
    return row ? this.decodeIntegration(row) : null;
  }
  private decodeIntegration(row: Record<string, unknown>): GithubIntegration {
    const document = JSON.parse(String(row.data_json)) as Omit<
      GithubIntegration,
      "id" | "workspaceId" | "name" | "state" | "version"
    >;
    return {
      ...document,
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      state: String(row.state) as GithubIntegration["state"],
      version: Number(row.version),
    };
  }
  fromStored(stored: StoredIntegration): GithubIntegration {
    return {
      id: stored.id,
      workspaceId: stored.workspaceId,
      name: stored.name,
      state: stored.state,
      projectIds: [...stored.projectIds],
      events: [...stored.events],
      secretRefs: [...stored.secretRefs],
      consent: { grantedBy: stored.consent.grantedBy, scopes: [...stored.consent.scopes] },
      settings: stored.settings as GithubIntegrationSettings,
      version: stored.version,
    };
  }
  /** Runs as the principal who granted consent: accountable, and re-authorized at every claim. */
  actingApp(integration: GithubIntegration, correlation?: string): Application {
    return this.scope.forIdentity(
      {
        principalId: integration.consent.grantedBy,
        scopes: ["R", "W", "X"],
        workspaceId: integration.workspaceId,
        credential: { kind: "system", id: `integration:${integration.id}` },
      },
      correlation,
    );
  }
  private async secret(integration: GithubIntegration, ref: string): Promise<string> {
    if (!integration.secretRefs.includes(ref))
      throw new ContractError("PRECONDITION_FAILED", "Integration does not bind this secret", {
        reasonCode: "secret_not_bound",
      });
    const release = await this.actingApp(integration).secrets.release(ref);
    return release.resolve();
  }
  private async credentials(integration: GithubIntegration): Promise<Credentials> {
    return {
      appId: integration.settings.appId,
      privateKeyPem: await this.secret(integration, integration.settings.credentials.privateKeyRef),
    };
  }
  /** Current secret plus the previous one while its 24 h rotation window is open. */
  private async webhookSecrets(integration: GithubIntegration): Promise<string[]> {
    const { credentials } = integration.settings;
    const secrets = [await this.secret(integration, credentials.webhookSecretRef)];
    if (
      credentials.previousWebhookSecretRef &&
      credentials.previousWebhookSecretExpiresAt &&
      Date.parse(credentials.previousWebhookSecretExpiresAt) > this.runtime.now().getTime()
    )
      secrets.push(await this.secret(integration, credentials.previousWebhookSecretRef));
    return secrets;
  }
  publicOrigin(integration: GithubIntegration): string | null {
    const origin = integration.settings.publicOrigin ?? this.app.serverConfig?.server.publicOrigin;
    return origin ? new URL(origin).origin : null;
  }
  /** `restore:isolated` pauses every integration side effect until an administrator releases it. */
  private isolated(): boolean {
    return (
      this.scope.database.get("SELECT value FROM operational_state WHERE key='restore:isolated'")
        ?.value === "true"
    );
  }
  private revokedTombstone(installationId: string): boolean {
    return Boolean(
      this.scope.database.get(
        "SELECT 1 AS present FROM operational_state WHERE key=?",
        `${REVOKED_KEY}${installationId}`,
      ),
    );
  }
  /** The tombstone is authoritative: a restored active row is revoked again the moment it is used. */
  private usableInstallation(
    workspaceId: string,
    installationId: string,
  ): InstallationRecord | null {
    const installation = this.globalStore.installation(workspaceId, installationId);
    if (!installation) return null;
    if (installation.state === "active" && this.revokedTombstone(installationId))
      this.revokeInstallation(workspaceId, installationId, "revoked_before_restore");
    const fresh = this.globalStore.installation(workspaceId, installationId);
    return fresh?.state === "active" ? fresh : null;
  }
  private async token(
    integration: GithubIntegration,
    installationId: string,
    repositoryId: string,
    permissions: Record<string, "read" | "write">,
  ): Promise<string> {
    if (!this.usableInstallation(integration.workspaceId, installationId))
      throw new ContractError("PRECONDITION_FAILED", "GitHub installation is revoked", {
        reasonCode: "installation_revoked",
      });
    return this.runtime.api.installationToken(
      await this.credentials(integration),
      installationId,
      [repositoryId],
      permissions,
    );
  }
  private audit(workspaceId: string, action: string, resourceId: string): void {
    auditAs(
      { database: this.scope.database, workspaceId, actor: "integration:github" },
      `integrations.github.${action}`,
      resourceId,
      "allowed",
    );
  }

  // ---------------------------------------------------------------- inbound webhooks
  /**
   * Verifies the signature, parses and classifies one delivery without side effects. A valid
   * signature is the only way to learn anything: bad or unattributable signatures are `UNAUTHENTICATED`.
   */
  async receive(context: IntegrationContext, request: InboundRequest): Promise<InboundOutcome> {
    const appId = request.headers["x-github-hook-installation-target-id"];
    let integration: GithubIntegration | null = null;
    for (const candidate of context
      .findIntegrations("github")
      .map((stored) => this.fromStored(stored))) {
      if (candidate.settings.appId !== appId) continue;
      let secrets: string[] = [];
      try {
        secrets = await this.webhookSecrets(candidate);
      } catch {
        continue;
      }
      if (verifyHmacSha256(request.headers["x-hub-signature-256"], request.rawBody, secrets)) {
        integration = candidate;
        break;
      }
    }
    if (!integration) throw new ContractError("UNAUTHENTICATED", "Webhook signature is invalid");
    const eventType = request.headers["x-github-event"];
    const deliveryId = request.headers["x-github-delivery"];
    if (!eventType || !deliveryId)
      throw new ContractError("INVALID_ARGUMENT", "Webhook delivery headers are missing", {
        reason: "missing_headers",
      });
    let body: unknown;
    try {
      body = JSON.parse(request.rawBody.toString("utf8"));
    } catch {
      throw new ContractError("INVALID_ARGUMENT", "Webhook body is not JSON", {
        reason: "invalid_json",
      });
    }
    const base = {
      workspaceId: integration.workspaceId,
      integrationId: integration.id,
      deliveryId,
      eventType,
    };
    const ignore = (
      reason: string,
      event: GithubEvent | null,
      projectId: string | null = null,
    ): InboundOutcome => ({
      ...base,
      installationKey: event?.installationId ?? null,
      projectId,
      action: event?.action ?? null,
      disposition: "ignored",
      ignoredReason: reason,
    });
    if (!(githubEventTypes as readonly string[]).includes(eventType))
      return ignore(eventType === "ping" ? "ping" : "unsupported_event", null);
    if (!integration.events.includes(eventType)) return ignore("event_not_subscribed", null);
    const event = parseGithubEvent(eventType, body);
    if (!event) return ignore("unsupported_event", null);
    const known = this.globalStore.installationAnywhere(event.installationId);
    const creating = event.kind === "installation" && event.action === "created";
    if (creating) {
      if (this.revokedTombstone(event.installationId)) return ignore("revoked_installation", event);
      if (
        known &&
        (known.workspaceId !== integration.workspaceId || known.integrationId !== integration.id)
      )
        return ignore("installation_owned_elsewhere", event);
      return this.accept(base, event, null, () => this.apply(integration, event));
    }
    if (
      !known ||
      known.workspaceId !== integration.workspaceId ||
      known.integrationId !== integration.id
    )
      return ignore("unknown_installation", event);
    if (known.state === "revoked" || this.revokedTombstone(known.installationId)) {
      if (known.state === "active")
        this.revokeInstallation(known.workspaceId, known.installationId, "revoked_before_restore");
      return ignore("revoked_installation", event);
    }
    if (event.kind === "installation")
      return this.accept(base, event, null, () => this.apply(integration, event));
    if (event.kind === "installation_repositories")
      return this.accept(base, event, null, () => this.apply(integration, event));
    const repository = this.globalStore.repository(
      known.workspaceId,
      known.installationId,
      event.repository.id,
    );
    if (!repository?.granted) return ignore("repository_not_allowed", event);
    const projectId = repository.settings.projectId;
    if (!repository.settings.enabled || !projectId) return ignore("repository_disabled", event);
    if (integration.projectIds.length && !integration.projectIds.includes(projectId))
      return ignore("project_not_in_integration", event, projectId);
    if (event.kind === "pull_request") {
      if (!handledPullActions.has(event.action))
        return ignore("action_not_handled", event, projectId);
      if (event.draft && !repository.settings.includeDrafts && event.action !== "closed")
        return ignore("draft_pull_request", event, projectId);
    }
    if (event.kind === "push" || event.kind === "check_run")
      return ignore("event_not_handled", event, projectId);
    return this.accept(base, event, projectId, () => this.apply(integration, event, repository));
  }
  private accept(
    base: { workspaceId: string; integrationId: string; deliveryId: string; eventType: string },
    event: GithubEvent,
    projectId: string | null,
    process: () => Promise<{ reference: string | null }>,
  ): InboundOutcome {
    return {
      ...base,
      installationKey: event.installationId,
      projectId,
      action: event.action,
      disposition: "accepted",
      process,
    };
  }

  /** Handler of an accepted delivery; every branch is idempotent so a failed delivery can be redelivered. */
  private async apply(
    integration: GithubIntegration,
    event: GithubEvent,
    repository?: RepositoryRecord,
  ): Promise<{ reference: string | null }> {
    const workspaceId = integration.workspaceId;
    const store = this.globalStore;
    const now = this.now();
    switch (event.kind) {
      case "installation": {
        if (event.action === "deleted" || event.action === "suspend") {
          this.revokeInstallation(
            workspaceId,
            event.installationId,
            event.action === "deleted" ? "deleted" : "suspended",
          );
          return { reference: event.installationId };
        }
        this.scope.database.withTx(() => {
          store.upsertInstallation(
            {
              workspaceId,
              installationId: event.installationId,
              integrationId: integration.id,
              accountLogin: event.accountLogin,
              accountType: event.accountType,
              repositorySelection: event.repositorySelection,
              permissions: event.permissions,
              events: event.events,
            },
            now,
          );
          for (const entry of event.repositories)
            store.upsertRepository(
              {
                workspaceId,
                installationId: event.installationId,
                repositoryId: entry.id,
                fullName: entry.fullName,
                private: entry.private,
              },
              true,
              now,
            );
          this.audit(workspaceId, "installation", event.installationId);
        });
        return { reference: event.installationId };
      }
      case "installation_repositories": {
        this.scope.database.withTx(() => {
          store.setSelection(workspaceId, event.installationId, event.repositorySelection, now);
          for (const entry of event.added)
            store.upsertRepository(
              {
                workspaceId,
                installationId: event.installationId,
                repositoryId: entry.id,
                fullName: entry.fullName,
                private: entry.private,
              },
              true,
              now,
            );
          for (const entry of event.removed)
            store.setRepositoryGranted(workspaceId, event.installationId, entry.id, false, now);
        });
        for (const entry of event.removed)
          await this.closePrWork(
            workspaceId,
            event.installationId,
            entry.id,
            undefined,
            "repository_removed",
          );
        return { reference: event.installationId };
      }
      case "deployment_status": {
        store.upsertDeployment(
          {
            workspaceId,
            installationId: event.installationId,
            repositoryId: event.repository.id,
            fullName: event.repository.fullName,
            deploymentId: event.deploymentId,
            sha: event.sha,
            environment: event.environment,
            state: event.state,
            targetUrl: event.url,
            deliveryId: `webhook`,
          },
          now,
        );
        if (event.state === "success")
          for (const pull of store.pullsAwaitingDeployment(
            workspaceId,
            event.installationId,
            event.repository.id,
            event.sha,
          ))
            await this.advance(pull);
        return { reference: event.deploymentId };
      }
      case "pull_request": {
        if (!repository) return { reference: null };
        const pull = await this.onPullRequest(integration, repository, event);
        return { reference: pull?.id ?? null };
      }
      case "push":
      case "check_run":
        return { reference: null };
    }
  }

  // ---------------------------------------------------------------- pull request state machine
  private async onPullRequest(
    integration: GithubIntegration,
    repository: RepositoryRecord,
    event: PullRequestEvent,
  ): Promise<PullRecord | null> {
    const workspaceId = integration.workspaceId;
    const store = this.globalStore;
    if (event.action === "closed" || event.action === "converted_to_draft") {
      await this.closePrWork(
        workspaceId,
        event.installationId,
        repository.repositoryId,
        event.number,
        event.action === "closed" ? "pull_request_closed" : "converted_to_draft",
      );
      return null;
    }
    const existing = store.pullByHead(
      workspaceId,
      event.installationId,
      repository.repositoryId,
      event.number,
      event.headSha,
    );
    if (existing) {
      await this.advance(existing);
      return existing;
    }
    const settings = repository.settings;
    const deny = event.fork && settings.forkPolicy === "deny";
    const older: PullRecord[] = [];
    const created = this.scope.database.withTx(() => {
      const now = this.now();
      for (const pull of store.pullsOfPr(
        workspaceId,
        event.installationId,
        repository.repositoryId,
        event.number,
      ))
        if (
          pull.headSha !== event.headSha &&
          (pull.state === "awaiting_preview" || pull.state === "running")
        ) {
          this.setPull(integration, pull, { state: "superseded", supersededBy: event.headSha });
          older.push(pull);
        }
      const inserted = store.insertPull(
        {
          workspaceId,
          integrationId: integration.id,
          installationId: event.installationId,
          repositoryId: repository.repositoryId,
          fullName: repository.fullName,
          prNumber: event.number,
          headSha: event.headSha,
          baseSha: event.baseSha,
          mergeSha: event.mergeSha,
          fork: event.fork,
          draft: event.draft,
          state: deny ? "denied" : "awaiting_preview",
          reasonCode: deny ? "fork_policy_denied" : event.fork ? "fork_fixture_only" : null,
          projectId: settings.projectId,
          environmentId: null,
          previewDeadlineAt:
            deny || (event.fork && settings.forkPolicy === "fixture-only")
              ? null
              : new Date(this.runtime.now().getTime() + settings.preview.timeoutMs).toISOString(),
        },
        now,
      );
      this.syncChecks(integration, inserted);
      this.audit(workspaceId, deny ? "pull.denied" : "pull.opened", inserted.id);
      return inserted;
    });
    for (const pull of older) await this.cancelWork(integration, pull);
    if (!deny) await this.advance(created);
    return created;
  }

  /** Applies a state change and brings both checks to the state it implies, in one transaction. */
  private setPull(
    integration: GithubIntegration,
    pull: PullRecord,
    patch: Parameters<GithubStore["updatePull"]>[1],
  ): PullRecord {
    const change = () => {
      const fresh = this.globalStore.updatePull(pull, patch, this.now());
      this.syncChecks(integration, fresh);
      return fresh;
    };
    return this.scope.database.inTransaction ? change() : this.scope.database.withTx(change);
  }
  private syncChecks(integration: GithubIntegration, pull: PullRecord): void {
    const store = this.globalStore;
    const origin = this.publicOrigin(integration);
    for (const desired of renderChecks(pull, origin))
      store.desireCheck(
        {
          workspaceId: pull.workspaceId,
          pullId: pull.id,
          installationId: pull.installationId,
          fullName: pull.fullName,
          headSha: pull.headSha,
          name: desired.name,
          externalId: checkExternalId(
            pull.installationId,
            pull.repositoryId,
            pull.prNumber,
            pull.headSha,
            desired.name,
          ),
          status: desired.status,
          conclusion: desired.conclusion,
          title: desired.title,
          summary: desired.summary,
          detailsUrl: desired.detailsUrl,
        },
        this.now(),
      );
  }
  /** Cancels the Runs of a pull's batch; terminal Runs ignore the request. */
  private async cancelWork(integration: GithubIntegration, pull: PullRecord): Promise<void> {
    if (!pull.batchId) return;
    const acting = this.actingApp(integration);
    try {
      for (const id of acting.batches.get(pull.batchId).memberRuns as string[])
        acting.runs.cancel(id);
    } catch {
      // A batch that cannot be read has no live Run to cancel; the pull is already terminal.
    }
  }
  private async closePrWork(
    workspaceId: string,
    installationId: string,
    repositoryId: string,
    prNumber: number | undefined,
    reason: string,
  ): Promise<void> {
    const store = this.globalStore;
    const pulls = this.scope.database
      .all(
        "SELECT id FROM github_pulls WHERE workspace_id=? AND installation_id=? AND repository_id=? AND state IN ('awaiting_preview','running')",
        workspaceId,
        installationId,
        repositoryId,
      )
      .map((row) => store.pull(workspaceId, String(row.id)))
      .filter(
        (pull): pull is PullRecord =>
          pull !== null && (prNumber === undefined || pull.prNumber === prNumber),
      );
    for (const pull of pulls) {
      const integration = this.loadIntegration(workspaceId, pull.integrationId);
      if (!integration) continue;
      this.setPull(integration, pull, { state: "closed", reasonCode: reason });
      await this.cancelWork(integration, pull);
    }
  }

  /** Revocation ends all use: state, tombstone, tokens and unsent checks (OPS-037). */
  revokeInstallation(workspaceId: string, installationId: string, reason: string): void {
    const now = this.now();
    this.scope.database.withTx(() => {
      this.globalStore.markRevoked(workspaceId, installationId, reason, now);
      this.scope.database.run(
        "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING",
        `${REVOKED_KEY}${installationId}`,
        now,
      );
      this.scope.database.run(
        "UPDATE github_checks SET state='dead_letter',last_error='installation_revoked',updated_at=?,version=version+1 WHERE workspace_id=? AND installation_id=? AND delivered_seq<seq AND state<>'dead_letter'",
        now,
        workspaceId,
        installationId,
      );
      this.audit(workspaceId, "installation.revoke", installationId);
    });
    this.runtime.api.dropInstallation(installationId);
    const pending = this.scope.database
      .all(
        "SELECT id,integration_id FROM github_pulls WHERE workspace_id=? AND installation_id=? AND state IN ('awaiting_preview','running')",
        workspaceId,
        installationId,
      )
      .map((row) => ({ id: String(row.id), integrationId: String(row.integration_id) }));
    for (const entry of pending) {
      const pull = this.globalStore.pull(workspaceId, entry.id);
      const integration = this.loadIntegration(workspaceId, entry.integrationId);
      if (pull && integration) {
        this.globalStore.updatePull(
          pull,
          { state: "closed", reasonCode: "installation_revoked" },
          now,
        );
        void this.cancelWork(integration, pull);
      }
    }
  }

  // ---------------------------------------------------------------- previews and run admission
  private async authorizePreview(url: string, profile: string): Promise<void> {
    const target = new URL(url);
    const loopback = ["127.0.0.1", "[::1]"].includes(target.hostname);
    const policy = new EgressPolicy(
      {
        defaultAction: "deny",
        allowedOrigins: [target.origin],
        privateTargets: [],
        allowedProtocols: ["http", "https"],
        allowRedirects: false,
        maxRedirects: 0,
        allowInsecureTls: false,
      },
      profile === "local-loopback" && loopback
        ? {
            networkProfile: "local-loopback",
            baseUrl: target.origin,
            host: target.hostname === "[::1]" ? "::1" : "127.0.0.1",
            port: Number(target.port || (target.protocol === "http:" ? 80 : 443)),
          }
        : undefined,
    );
    await policy.authorize(target.href, this.runtime.resolveHost);
  }
  private deny(integration: GithubIntegration, pull: PullRecord, reason: string): PullRecord {
    return this.setPull(integration, pull, { state: "denied", reasonCode: reason });
  }
  private baseRevision(acting: Application, repository: RepositoryRecord) {
    const id = repository.settings.baseEnvironmentId;
    if (!id) return null;
    const environment = requireEntity(acting.context, "Environment", id);
    return requireEntity(
      acting.context,
      "EnvironmentRevision",
      String(environment.activeRevisionId),
    );
  }

  /** Moves one pull forward: time out a preview, admit once a matching deployment exists, finish a batch. */
  async advance(pull: PullRecord): Promise<PullRecord> {
    if (this.isolated() || terminalPullStates.includes(pull.state)) return pull;
    const integration = this.loadIntegration(pull.workspaceId, pull.integrationId);
    if (!integration || integration.state === "paused") return pull;
    const installation = this.usableInstallation(pull.workspaceId, pull.installationId);
    if (integration.state === "revoked" || !installation) {
      const closed = this.setPull(integration ?? this.fallback(pull), pull, {
        state: "closed",
        reasonCode: "installation_revoked",
      });
      if (integration) await this.cancelWork(integration, pull);
      return closed;
    }
    const repository = this.globalStore.repository(
      pull.workspaceId,
      pull.installationId,
      pull.repositoryId,
    );
    if (!repository?.granted || !repository.settings.enabled) {
      await this.cancelWork(integration, pull);
      return this.setPull(integration, pull, { state: "closed", reasonCode: "repository_removed" });
    }
    if (pull.state === "awaiting_preview")
      return this.advanceAwaiting(integration, repository, pull);
    return this.advanceRunning(integration, repository, pull);
  }
  /** A pull whose integration row vanished cannot render links; the checks still close. */
  private fallback(pull: PullRecord): GithubIntegration {
    return {
      id: pull.integrationId,
      workspaceId: pull.workspaceId,
      name: "",
      state: "revoked",
      projectIds: [],
      events: [],
      secretRefs: [],
      consent: { grantedBy: "", scopes: [] },
      settings: undefined as never,
      version: 0,
    };
  }

  private async advanceAwaiting(
    integration: GithubIntegration,
    repository: RepositoryRecord,
    pull: PullRecord,
  ): Promise<PullRecord> {
    const settings = repository.settings;
    if (pull.fork && settings.forkPolicy === "fixture-only")
      return this.admitFixture(integration, repository, pull);
    const deployment = this.globalStore
      .deploymentsForSha(pull.workspaceId, pull.repositoryId, pull.headSha)
      .find((entry) => {
        if (entry.state !== "success" || !entry.targetUrl) return false;
        const manual = entry.deliveryId.startsWith("manual:");
        return settings.preview.provider === "manual"
          ? manual
          : !manual && globMatch(settings.preview.environmentPattern, entry.environment);
      });
    if (deployment?.targetUrl)
      return this.admit(integration, repository, pull, {
        url: deployment.targetUrl,
        deploymentId: deployment.deploymentId,
        fixture: false,
      });
    if (
      pull.previewDeadlineAt &&
      Date.parse(pull.previewDeadlineAt) <= this.runtime.now().getTime()
    )
      return this.setPull(integration, pull, { state: "timed_out", reasonCode: "preview_timeout" });
    return pull;
  }
  private async admitFixture(
    integration: GithubIntegration,
    repository: RepositoryRecord,
    pull: PullRecord,
  ): Promise<PullRecord> {
    const id = repository.settings.fixtureEnvironmentId;
    if (!id) return this.deny(integration, pull, "fixture_environment_missing");
    const acting = this.actingApp(integration);
    const environment = requireEntity(acting.context, "Environment", id);
    const revision = requireEntity(
      acting.context,
      "EnvironmentRevision",
      String(environment.activeRevisionId),
    );
    const targets = revision.targetOrigins as string[];
    if (
      (revision.authProfileRefs as string[]).length ||
      revision.production === true ||
      !targets[0]
    )
      return this.deny(integration, pull, "fixture_environment_unsafe");
    if (this.planUsesSecrets(acting, repository))
      return this.deny(integration, pull, "fixture_secret_refs");
    return this.admit(integration, repository, pull, {
      url: targets[0],
      deploymentId: null,
      fixture: true,
      environmentId: id,
    });
  }
  private planUsesSecrets(acting: Application, repository: RepositoryRecord): boolean {
    const { projectId, selection } = repository.settings;
    for (const test of allEntities(acting.context, "TestCase")) {
      if (test.projectId !== projectId || test.archivedAt || !test.activeRevisionId) continue;
      if (selection.kind === "tests" && !selection.testIds.includes(String(test.id))) continue;
      const revision = requireEntity(acting.context, "TestRevision", String(test.activeRevisionId));
      if (hasSecretRef(revision.plan)) return true;
    }
    return false;
  }

  private async ensureEnvironment(
    acting: Application,
    repository: RepositoryRecord,
    pull: PullRecord,
    origin: string,
    profile: string,
  ): Promise<string> {
    const projectId = String(repository.settings.projectId);
    const base = this.baseRevision(acting, repository);
    const name = `github-pr-${pull.repositoryId}-${pull.prNumber}`;
    const existing = acting.environments.list(projectId).find((entry) => entry.name === name);
    if (!existing) {
      return acting.environments.create({
        projectId,
        name,
        baseUrl: origin,
        networkProfile: profile as "public" | "local-loopback",
        locale: String(base?.locale ?? "en-US"),
        timezone: String(base?.timezone ?? "UTC"),
        production: false,
      }).id;
    }
    const revision = requireEntity(
      acting.context,
      "EnvironmentRevision",
      String(existing.activeRevisionId),
    );
    if ((revision.targetOrigins as string[])[0] !== origin || revision.networkProfile !== profile)
      acting.environments.update(
        existing.id,
        { baseUrl: origin, networkProfile: profile as "public" | "local-loopback" },
        Number(existing.version),
      );
    return existing.id;
  }

  private async admit(
    integration: GithubIntegration,
    repository: RepositoryRecord,
    pull: PullRecord,
    target: { url: string; deploymentId: string | null; fixture: boolean; environmentId?: string },
  ): Promise<PullRecord> {
    const settings = repository.settings;
    const acting = this.actingApp(integration);
    let profile = "public";
    try {
      // Only a loopback preview in a loopback-profile project keeps that profile; a preview on any
      // other host is a public target and must pass the public egress rules.
      const loopbackHost = ["127.0.0.1", "[::1]"].includes(new URL(target.url).hostname);
      profile =
        loopbackHost && this.baseRevision(acting, repository)?.networkProfile === "local-loopback"
          ? "local-loopback"
          : "public";
      await this.authorizePreview(target.url, profile);
    } catch (error) {
      if (error instanceof PolicyDenied || error instanceof TypeError)
        return this.deny(integration, pull, "preview_url_denied");
      return this.deny(integration, pull, "admission_failed:preview");
    }
    try {
      const origin = new URL(target.url).origin;
      const environmentId =
        target.environmentId ??
        (await this.ensureEnvironment(acting, repository, pull, origin, profile));
      const environment = requireEntity(acting.context, "Environment", environmentId);
      const wait = !acting.worker.live();
      const receipt = await acting.selection.run(
        {
          projectId: String(settings.projectId),
          environmentId,
          ...(settings.selection.kind === "tests"
            ? { testIds: [...settings.selection.testIds] }
            : { all: true }),
          provenance: {
            repositoryId: `github.com/${pull.fullName}`,
            commitSha: pull.headSha,
            checkoutSha: pull.headSha,
            baseSha: pull.baseSha,
            deploymentId: target.deploymentId ?? `fixture-only:${pull.id}`,
          },
          targetUrl: origin,
          origin: "github",
          quarantinePolicy: "exclude",
        },
        { strict: true, wait, idempotencyKey: `github-${pull.id}` },
      );
      return this.setPull(integration, pull, {
        state: "running",
        reasonCode: target.fixture ? "fork_fixture_only" : null,
        environmentId: environment.id,
        previewUrl: origin,
        deploymentId: target.deploymentId,
        batchId: receipt.batchId,
      });
    } catch (error) {
      if (error instanceof ContractError) {
        const reason =
          error.code === "FORBIDDEN" || error.code === "UNAUTHENTICATED"
            ? "actor_revoked"
            : `admission_failed:${error.code}`;
        if (reason === "actor_revoked")
          this.raiseAlert(pull.workspaceId, pull.projectId, pull.id, "actor_revoked", "high");
        return this.deny(integration, pull, reason);
      }
      throw error;
    }
  }

  private async advanceRunning(
    integration: GithubIntegration,
    repository: RepositoryRecord,
    pull: PullRecord,
  ): Promise<PullRecord> {
    if (!pull.batchId) return pull;
    const acting = this.actingApp(integration);
    const members = acting.batches.get(pull.batchId).memberRuns as string[];
    const runs = members.map((id) => acting.runs.get(id));
    if (runs.some((run) => run.phase !== "completed")) {
      const ephemeral = runs.some(
        (run) => (run.matrixCell as Record<string, unknown>).ownership === "ephemeral",
      );
      if (ephemeral && !this.runtime.driving.has(pull.id)) {
        this.runtime.driving.add(pull.id);
        const work = acting.worker
          .run({ ephemeral: true, runIds: members })
          .catch(() => undefined)
          .finally(() => this.runtime.driving.delete(pull.id));
        this.runtime.pendingWork.add(work);
        void work.finally(() => this.runtime.pendingWork.delete(work));
      }
      return pull;
    }
    const environment = pull.environmentId
      ? requireEntity(acting.context, "Environment", pull.environmentId)
      : null;
    const stored = await storedResultForBatch(acting, {
      batchId: pull.batchId,
      previewUrl: pull.previewUrl,
      environmentName: String(environment?.name ?? "unknown"),
      selection:
        repository.settings.selection.kind === "all"
          ? "all tests"
          : `${repository.settings.selection.testIds.length} selected tests`,
    });
    return this.setPull(integration, pull, {
      state: "completed",
      gate: stored.ci.gate,
      resultJson: JSON.stringify(stored),
      reportHash: stored.ci.reportHash,
    });
  }
  /** Resolves when every ephemeral worker started by this process has finished (tests and shutdown). */
  async settle(): Promise<void> {
    while (this.runtime.pendingWork.size) await Promise.allSettled([...this.runtime.pendingWork]);
  }
  /** Installation tokens held in memory right now; they are never persisted. */
  activeTokens(): number {
    return this.runtime.api.cachedTokenCount();
  }

  // ---------------------------------------------------------------- check and comment publication
  private async publishCheck(record: CheckRecord): Promise<void> {
    const store = this.globalStore;
    const pull = store.pull(record.workspaceId, record.pullId);
    const integration = pull ? this.loadIntegration(pull.workspaceId, pull.integrationId) : null;
    if (!pull || !integration) return;
    if (integration.state !== "active") return;
    const now = this.runtime.now();
    try {
      const token = await this.token(integration, record.installationId, pull.repositoryId, {
        checks: "write",
      });
      const client = new ChecksClient(token, {
        apiUrl: this.runtime.api.apiBaseUrl,
        sleep: this.runtime.sleep,
        random: this.runtime.random,
      });
      const payload: CheckPayload = {
        name: record.name as CheckPayload["name"],
        head_sha: record.headSha,
        external_id: record.externalId,
        status: record.status,
        ...(record.conclusion ? { conclusion: record.conclusion } : {}),
        output: { title: record.title, summary: record.summary },
        ...(record.detailsUrl ? { details_url: record.detailsUrl } : {}),
      };
      const remoteId = await client.publish(record.fullName, payload);
      store.markDelivered(record, record.seq, remoteId, now.toISOString());
    } catch (error) {
      this.recordProblem(record, pull, error);
    }
  }
  /** INT-023: each failure class is its own state with its own retry rule, and raises an alert once. */
  private recordProblem(record: CheckRecord, pull: PullRecord, error: unknown): void {
    if (error instanceof ContractError && error.details.reasonCode === "installation_revoked") {
      this.globalStore.markFailed(
        record,
        {
          state: "dead_letter",
          lastError: "installation_revoked",
          nextAttemptAt: null,
          firstFailedAt: record.firstFailedAt ?? this.now(),
        },
        this.now(),
      );
      return;
    }
    const kind = classifyProblem(error);
    const attempts = record.attempts + 1;
    const nowMs = this.runtime.now().getTime();
    const firstFailedAt = record.firstFailedAt ?? new Date(nowMs).toISOString();
    const exhausted =
      attempts >= deliveryRetryPolicy.maxAttempts ||
      nowMs - Date.parse(firstFailedAt) > deliveryRetryPolicy.windowMs;
    const state = exhausted || kind === "rejected" ? "dead_letter" : kind;
    const wait = Math.max(
      deliveryBackoffMs(attempts, this.runtime.random),
      retryAfterOf(error) ?? 0,
    );
    const detail =
      error instanceof GithubApiError || (error instanceof Error && "status" in error)
        ? `${kind}:${String((error as { status: unknown }).status)}`
        : error instanceof ContractError
          ? `${kind}:${error.code}`
          : kind;
    this.scope.database.withTx(() => {
      this.globalStore.markFailed(
        record,
        {
          state,
          lastError: detail,
          nextAttemptAt: state === "dead_letter" ? null : new Date(nowMs + wait).toISOString(),
          firstFailedAt,
        },
        new Date(nowMs).toISOString(),
      );
      if (record.state !== state)
        this.raiseAlert(
          record.workspaceId,
          pull.projectId,
          record.id,
          `github_check_${state}`,
          state === "rate_limited" || state === "host_unavailable" ? "medium" : "high",
          { repository: record.fullName, sha: record.headSha, check: record.name },
        );
    });
  }
  private raiseAlert(
    workspaceId: string,
    projectId: string | null,
    aggregateId: string,
    problem: string,
    severity: "medium" | "high",
    extra: Record<string, unknown> = {},
  ): void {
    const emit = () =>
      new OutboxRepository(this.scope.database).append(workspaceId, aggregateId, "alert.fired", {
        alertId: `github:${aggregateId}:${problem}`,
        rule: "github.delivery_problem",
        severity,
        projectId,
        problem,
        ...extra,
      });
    if (this.scope.database.inTransaction) emit();
    else this.scope.database.withTx(emit);
    this.audit(workspaceId, `problem.${problem}`, aggregateId);
  }
  /** Operator action on a dead-lettered publication: the same payload is sent again. */
  async drainChecks(): Promise<number> {
    const due = this.globalStore.dueChecks(this.now());
    for (const record of due) await this.publishCheck(record);
    return due.length;
  }

  private async upsertComment(
    integration: GithubIntegration,
    pull: PullRecord,
    body: string,
  ): Promise<string> {
    const api = this.runtime.api;
    const token = await this.token(integration, pull.installationId, pull.repositoryId, {
      pull_requests: "write",
    });
    const issue = `/repos/${pull.fullName}/issues`;
    const known = this.scope.database.get(
      "SELECT comment_id FROM github_pulls WHERE workspace_id=? AND installation_id=? AND repository_id=? AND pr_number=? AND comment_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      pull.workspaceId,
      pull.installationId,
      pull.repositoryId,
      pull.prNumber,
    )?.comment_id;
    if (known) {
      try {
        const { data } = await api.request(token, "PATCH", `${issue}/comments/${String(known)}`, {
          body,
        });
        return String((data as { id: number | string }).id);
      } catch (error) {
        if (!(error instanceof GithubApiError) || error.status !== 404) throw error;
      }
    }
    const marker = commentMarker(pull.installationId, pull.repositoryId, pull.prNumber);
    for (let page = 1; page <= 10; page++) {
      const { data } = await api.request(
        token,
        "GET",
        `${issue}/${pull.prNumber}/comments?per_page=100&page=${page}`,
      );
      const comments = data as {
        id: number | string;
        body?: string;
        performed_via_github_app?: { id?: number } | null;
      }[];
      const own = comments.find(
        (comment) =>
          comment.body?.startsWith(marker) &&
          comment.performed_via_github_app?.id === Number(integration.settings.appId),
      );
      if (own) {
        await api.request(token, "PATCH", `${issue}/comments/${own.id}`, { body });
        return String(own.id);
      }
      if (comments.length < 100) break;
    }
    const { data } = await api.request(token, "POST", `${issue}/${pull.prNumber}/comments`, {
      body,
    });
    return String((data as { id: number | string }).id);
  }
  /** Comment failures never touch checks or verdicts; they retry a bounded number of times. */
  async drainComments(): Promise<number> {
    const store = this.globalStore;
    const seen = new Set<string>();
    let handled = 0;
    for (const dirty of store.dirtyCommentPulls(this.now())) {
      const key = `${dirty.workspaceId}:${dirty.installationId}:${dirty.repositoryId}:${dirty.prNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const integration = this.loadIntegration(dirty.workspaceId, dirty.integrationId);
      if (!integration || integration.state !== "active") continue;
      const pulls = store.pullsOfPr(
        dirty.workspaceId,
        dirty.installationId,
        dirty.repositoryId,
        dirty.prNumber,
      );
      const at = this.now();
      const update = (fields: Record<string, string | number | null>) =>
        this.scope.database.run(
          `UPDATE github_pulls SET ${Object.keys(fields)
            .map((column) => `${column}=?`)
            .join(
              ",",
            )},version=version+1 WHERE workspace_id=? AND installation_id=? AND repository_id=? AND pr_number=?`,
          ...Object.values(fields),
          dirty.workspaceId,
          dirty.installationId,
          dirty.repositoryId,
          dirty.prNumber,
        );
      try {
        const commentId = await this.upsertComment(
          integration,
          dirty,
          renderComment(pulls, this.publicOrigin(integration)),
        );
        update({
          comment_id: commentId,
          comment_dirty: 0,
          comment_attempts: 0,
          comment_next_at: null,
          comment_error: null,
        });
      } catch (error) {
        const attempts = dirty.commentAttempts + 1;
        const kind = classifyProblem(error);
        update({
          comment_dirty: attempts >= COMMENT_MAX_ATTEMPTS || kind === "rejected" ? 0 : 1,
          comment_attempts: attempts,
          comment_next_at: new Date(
            this.runtime.now().getTime() + deliveryBackoffMs(attempts, this.runtime.random),
          ).toISOString(),
          comment_error: kind,
        });
        if (dirty.commentError !== kind)
          this.raiseAlert(
            dirty.workspaceId,
            dirty.projectId,
            dirty.id,
            `github_comment_${kind}`,
            "medium",
          );
      }
      handled++;
    }
    return handled;
  }

  /** One controller tick: advance pulls, send due checks, refresh comments. */
  async reconcile(): Promise<{ pulls: number; checks: number; comments: number }> {
    if (this.isolated()) return { pulls: 0, checks: 0, comments: 0 };
    const active = this.globalStore.activePulls();
    for (const pull of active) {
      try {
        await this.advance(pull);
      } catch (error) {
        auditAs(
          {
            database: this.scope.database,
            workspaceId: pull.workspaceId,
            actor: "integration:github",
          },
          "integrations.github.reconcile",
          pull.id,
          "denied",
        );
        if (!(error instanceof ContractError)) throw error;
      }
    }
    return {
      pulls: active.length,
      checks: await this.drainChecks(),
      comments: await this.drainComments(),
    };
  }

  // ---------------------------------------------------------------- authorized surface (HTTP routes)
  private requireIntegration(id: string): GithubIntegration {
    const integration = this.loadIntegration(this.ctx.workspaceId, id, this.ctx.database);
    if (!integration) throw new ContractError("NOT_FOUND", "Integration does not exist", { id });
    return integration;
  }
  installations(integrationId: string): GithubInstallation[] {
    this.ctx.authorize("A");
    this.requireIntegration(integrationId);
    return this.store.installations(this.ctx.workspaceId, integrationId).map((installation) => ({
      id: installation.installationId,
      createdAt: installation.createdAt,
      installationId: installation.installationId,
      integrationId: installation.integrationId,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      repositorySelection: installation.repositorySelection,
      state: installation.state,
      revokedReason: installation.revokedReason,
      permissions: installation.permissions,
      repositories: this.store
        .repositories(installation.workspaceId, installation.installationId)
        .map((repository) => ({
          repositoryId: repository.repositoryId,
          fullName: repository.fullName,
          private: repository.private,
          granted: repository.granted,
          enabled: repository.settings.enabled,
          projectId: repository.settings.projectId,
          includeDrafts: repository.settings.includeDrafts,
          forkPolicy: repository.settings.forkPolicy,
          baseEnvironmentId: repository.settings.baseEnvironmentId,
          fixtureEnvironmentId: repository.settings.fixtureEnvironmentId,
          previewEnvironmentPattern: repository.settings.preview.environmentPattern,
          previewProvider: repository.settings.preview.provider,
        })),
      updatedAt: installation.updatedAt,
    }));
  }
  private repositoryView(repository: RepositoryRecord): GithubRepository {
    return {
      repositoryId: repository.repositoryId,
      installationId: repository.installationId,
      fullName: repository.fullName,
      private: repository.private,
      granted: repository.granted,
      settings: repository.settings,
      version: repository.version,
    };
  }
  /** Synchronous HTTP routes already run inside the idempotency transaction; other callers open their own. */
  private inTx<T>(change: () => T): T {
    const { database } = this.ctx;
    return database.inTransaction ? change() : database.withTx(change);
  }
  /** Per-repository toggles and bindings (INT-018/019/021): nothing runs until enabled and bound. */
  updateRepository(
    integrationId: string,
    repositoryId: string,
    patch: GithubRepositoryPatch,
  ): GithubRepository {
    this.ctx.authorize("A");
    validate("GithubRepositoryPatch", patch);
    this.requireIntegration(integrationId);
    return this.inTx(() => {
      const record = this.store
        .installations(this.ctx.workspaceId, integrationId)
        .map((installation) =>
          this.store.repository(this.ctx.workspaceId, installation.installationId, repositoryId),
        )
        .find((entry): entry is RepositoryRecord => Boolean(entry));
      if (!record)
        throw new ContractError("NOT_FOUND", "Repository is not part of this integration", {
          repositoryId,
        });
      const settings: GithubRepositorySettings = {
        ...record.settings,
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.projectId === undefined ? {} : { projectId: patch.projectId }),
        ...(patch.includeDrafts === undefined ? {} : { includeDrafts: patch.includeDrafts }),
        ...(patch.forkPolicy === undefined ? {} : { forkPolicy: patch.forkPolicy }),
        ...(patch.selection === undefined ? {} : { selection: patch.selection }),
        ...(patch.baseEnvironmentId === undefined
          ? {}
          : { baseEnvironmentId: patch.baseEnvironmentId }),
        ...(patch.fixtureEnvironmentId === undefined
          ? {}
          : { fixtureEnvironmentId: patch.fixtureEnvironmentId }),
        preview: { ...record.settings.preview, ...(patch.preview ?? {}) },
      };
      if (settings.enabled && !settings.projectId)
        throw new ContractError("INVALID_ARGUMENT", "An enabled repository needs a project", {
          field: "projectId",
        });
      if (settings.projectId) {
        this.ctx.authorize("A", settings.projectId);
        const project = this.ctx.entities.get("Project", this.ctx.workspaceId, settings.projectId);
        if (!project || project.archivedAt)
          throw new ContractError("NOT_FOUND", "Project does not exist", {
            id: settings.projectId,
          });
      }
      for (const id of [settings.baseEnvironmentId, settings.fixtureEnvironmentId]) {
        if (!id) continue;
        const environment = this.ctx.entities.get("Environment", this.ctx.workspaceId, id);
        if (!environment || environment.projectId !== settings.projectId)
          throw new ContractError(
            "INVALID_ARGUMENT",
            "Environment does not belong to the bound project",
            { id },
          );
      }
      if (settings.forkPolicy === "fixture-only" && !settings.fixtureEnvironmentId)
        throw new ContractError(
          "INVALID_ARGUMENT",
          "fixture-only forks need a fixture environment",
          { field: "fixtureEnvironmentId" },
        );
      this.store.setRepositorySettings(record, settings, this.now());
      auditSecurity(
        this.ctx,
        "integrations.github.repository",
        `${record.installationId}:${repositoryId}`,
        "allowed",
      );
      const fresh = this.store.repository(
        this.ctx.workspaceId,
        record.installationId,
        repositoryId,
      );
      if (!fresh) throw new ContractError("INTERNAL", "Repository vanished");
      return this.repositoryView(fresh);
    });
  }
  pulls(integrationId: string, limit = 50): GithubPull[] {
    this.ctx.authorize("R");
    this.requireIntegration(integrationId);
    return this.store
      .pullsForIntegration(this.ctx.workspaceId, integrationId, limit)
      .map((pull) => this.pullView(pull));
  }
  private pullView(pull: PullRecord): GithubPull {
    return {
      id: pull.id,
      integrationId: pull.integrationId,
      installationId: pull.installationId,
      repositoryId: pull.repositoryId,
      repositoryFullName: pull.fullName,
      prNumber: pull.prNumber,
      headSha: pull.headSha,
      baseSha: pull.baseSha,
      mergeSha: pull.mergeSha,
      fork: pull.fork,
      draft: pull.draft,
      state: pull.state,
      reasonCode: pull.reasonCode,
      projectId: pull.projectId,
      previewUrl: pull.previewUrl,
      deploymentId: pull.deploymentId,
      previewDeadlineAt: pull.previewDeadlineAt,
      batchId: pull.batchId,
      supersededBy: pull.supersededBy,
      gate: pull.gate,
      createdAt: pull.createdAt,
      updatedAt: pull.updatedAt,
    } as GithubPull;
  }
  checks(integrationId: string, limit = 100): GithubCheck[] {
    this.ctx.authorize("R");
    this.requireIntegration(integrationId);
    return this.store
      .checksForIntegration(this.ctx.workspaceId, integrationId, limit)
      .map((check) => this.checkView(check));
  }
  private checkView(check: CheckRecord): GithubCheck {
    return {
      id: check.id,
      pullId: check.pullId,
      repositoryFullName: check.fullName,
      headSha: check.headSha,
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      state: check.state,
      sequence: check.seq,
      deliveredSequence: check.deliveredSeq,
      attempts: check.attempts,
      nextAttemptAt: check.nextAttemptAt,
      lastError: check.lastError,
      remoteId: check.remoteId,
      createdAt: check.createdAt,
      updatedAt: check.updatedAt,
    };
  }
  retryCheck(integrationId: string, checkId: string): GithubCheck {
    this.ctx.authorize("W");
    this.requireIntegration(integrationId);
    const check = this.store.check(this.ctx.workspaceId, checkId);
    const pull = check ? this.store.pull(this.ctx.workspaceId, check.pullId) : null;
    if (!check || pull?.integrationId !== integrationId)
      throw new ContractError("NOT_FOUND", "Check publication does not exist", { id: checkId });
    if (check.state !== "dead_letter")
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Only a dead-lettered publication can be retried",
        { reasonCode: "not_dead_lettered" },
      );
    this.store.requeueCheck(check, this.now());
    auditSecurity(this.ctx, "integrations.github.retry", checkId, "allowed");
    return this.checkView(this.store.check(this.ctx.workspaceId, checkId) ?? check);
  }

  /** `manual` provider: a human attests that this URL serves exactly this commit (INT-015). */
  async previewDeployment(input: PreviewDeploymentInput): Promise<GithubPull> {
    this.ctx.authorize("W");
    validate("PreviewDeploymentInput", input);
    const integration = this.requireIntegration(input.integrationId);
    const installation = this.store
      .installations(this.ctx.workspaceId, integration.id)
      .find((entry) =>
        this.store.repository(entry.workspaceId, entry.installationId, input.repositoryId),
      );
    const repository = installation
      ? this.store.repository(this.ctx.workspaceId, installation.installationId, input.repositoryId)
      : null;
    if (!installation || !repository)
      throw new ContractError("NOT_FOUND", "Repository is not part of this integration", {
        repositoryId: input.repositoryId,
      });
    if (repository.settings.preview.provider !== "manual")
      throw new ContractError("PRECONDITION_FAILED", "Repository uses webhook-reported previews", {
        reasonCode: "preview_provider_mismatch",
      });
    const pull = this.store.pullByHead(
      this.ctx.workspaceId,
      installation.installationId,
      input.repositoryId,
      input.prNumber,
      input.headSha,
    );
    if (!pull || pull.state !== "awaiting_preview")
      throw new ContractError(
        "PRECONDITION_FAILED",
        "No pull request commit is waiting for a preview",
        { reasonCode: "no_pull_awaiting_preview" },
      );
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new ContractError("INVALID_ARGUMENT", "Preview URL is invalid", { field: "url" });
    }
    this.globalStore.upsertDeployment(
      {
        workspaceId: this.ctx.workspaceId,
        installationId: installation.installationId,
        repositoryId: input.repositoryId,
        fullName: repository.fullName,
        deploymentId: `manual-${randomUUID().replaceAll("-", "")}`,
        sha: input.headSha,
        environment: "manual",
        state: "success",
        targetUrl: url.origin,
        deliveryId: `manual:${this.ctx.principalId}`,
      },
      this.now(),
    );
    auditSecurity(this.ctx, "integrations.github.preview", pull.id, "allowed");
    return this.pullView(await this.advance(pull));
  }

  /** Starts the 24 h overlap during which the previous webhook secret is still accepted. */
  rotateWebhookSecret(integrationId: string, secretRef: string): IntegrationMetadata {
    this.ctx.authorize("A");
    const integration = this.requireIntegration(integrationId);
    if (integration.state === "revoked")
      throw new ContractError("PRECONDITION_FAILED", "Integration is revoked", {
        reasonCode: "integration_revoked",
      });
    const { credentials } = integration.settings;
    if (secretRef === credentials.webhookSecretRef)
      throw new ContractError(
        "INVALID_ARGUMENT",
        "New webhook secret must differ from the current one",
        { field: "secretRef" },
      );
    const settings: GithubIntegrationSettings = {
      ...integration.settings,
      credentials: {
        ...credentials,
        webhookSecretRef: secretRef,
        previousWebhookSecretRef: credentials.webhookSecretRef,
        previousWebhookSecretExpiresAt: new Date(
          this.runtime.now().getTime() + WEBHOOK_ROTATION_MS,
        ).toISOString(),
      },
    };
    const refs = [...new Set([...integration.secretRefs, secretRef])];
    return this.app.integrations.update(
      integrationId,
      { settings, secretRefs: refs },
      integration.version,
    );
  }

  // ---------------------------------------------------------------- setup (manifest flow)
  manifest(input: GithubManifestInput): GithubManifestReceipt {
    this.ctx.authorize("A");
    validate("GithubManifestInput", input);
    const manifest = buildManifest(input);
    const state = randomBytes(24).toString("base64url");
    const expiresAt = new Date(this.runtime.now().getTime() + MANIFEST_TTL_MS).toISOString();
    this.ctx.database.run(
      "INSERT INTO operational_state(key,value) VALUES(?,?)",
      `github:manifest:${state}`,
      JSON.stringify({
        workspaceId: this.ctx.workspaceId,
        principalId: this.ctx.principalId,
        name: input.name,
        publicOrigin: new URL(input.publicOrigin).origin,
        allowAgentPullRequests: input.allowAgentPullRequests === true,
        expiresAt,
      }),
    );
    auditSecurity(this.ctx, "integrations.github.manifest", state.slice(0, 8), "allowed");
    return {
      state,
      expiresAt,
      createUrl: manifestCreateUrl(state, input.organization),
      manifest: manifest as never,
      scopes: [...requiredScopesFor(input.allowAgentPullRequests === true)],
    };
  }
  /** Exchanges the one-time code GitHub sent to the redirect URL and stores the App credentials as secrets. */
  async convertManifest(
    state: string,
    input: GithubManifestConversionInput,
  ): Promise<IntegrationMetadata> {
    this.ctx.authorize("A");
    validate("GithubManifestConversionInput", input);
    const key = `github:manifest:${state}`;
    const row = this.ctx.database.get("SELECT value FROM operational_state WHERE key=?", key);
    const pending = row
      ? (JSON.parse(String(row.value)) as {
          workspaceId: string;
          principalId: string;
          name: string;
          publicOrigin: string;
          allowAgentPullRequests: boolean;
          expiresAt: string;
        })
      : null;
    if (
      !pending ||
      pending.workspaceId !== this.ctx.workspaceId ||
      pending.principalId !== this.ctx.principalId
    )
      throw new ContractError(
        "NOT_FOUND",
        "Manifest state is unknown or belongs to another principal",
      );
    // One use: the state is consumed before the code is exchanged, so a replay never reaches GitHub.
    this.ctx.database.run("DELETE FROM operational_state WHERE key=?", key);
    if (Date.parse(pending.expiresAt) < this.runtime.now().getTime())
      throw new ContractError("PRECONDITION_FAILED", "Manifest state expired", {
        reasonCode: "manifest_expired",
      });
    const { data } = await this.runtime.api.request(
      null,
      "POST",
      `/app-manifests/${encodeURIComponent(input.code)}/conversions`,
      {},
    );
    const app = data as {
      id?: number;
      slug?: string;
      pem?: string;
      webhook_secret?: string;
      client_secret?: string;
    };
    if (!app.id || !app.slug || !app.pem || !app.webhook_secret)
      throw new ContractError("UNAVAILABLE", "GitHub manifest conversion response is invalid");
    const origin = this.runtime.api.apiBaseUrl;
    const store = async (suffix: string, value: string) =>
      (
        await this.app.secrets.set(`github-${app.slug}-${suffix}`, value, {
          allowedOrigins: [new URL(origin).origin],
        })
      ).id;
    const privateKeyRef = await store("private-key", app.pem);
    const webhookSecretRef = await store("webhook-secret", app.webhook_secret);
    const clientSecretRef = app.client_secret
      ? await store("client-secret", app.client_secret)
      : null;
    const settings: GithubIntegrationSettings = {
      appId: String(app.id),
      appSlug: app.slug,
      publicOrigin: pending.publicOrigin,
      allowAgentPullRequests: pending.allowAgentPullRequests,
      credentials: {
        privateKeyRef,
        webhookSecretRef,
        previousWebhookSecretRef: null,
        previousWebhookSecretExpiresAt: null,
        clientSecretRef,
      },
    };
    return this.app.integrations.create({
      provider: "github",
      name: app.slug,
      projectIds: input.projectIds,
      events: [...githubEventTypes],
      consent: { scopes: [...requiredScopesFor(pending.allowAgentPullRequests)] },
      secretRefs: [privateKeyRef, webhookSecretRef, ...(clientSecretRef ? [clientSecretRef] : [])],
      settings,
    } as never);
  }

  // ---------------------------------------------------------------- agent pull requests (SEC-047)
  /**
   * Agent branch and PR creation: opt-in per integration, installation must hold `contents: write`,
   * and the caller needs the human-only `approve` authority with an explicit grant. Only new
   * `testmaster/` branches are created; nothing here force-pushes, edits a ref or touches protections.
   */
  async createAgentPullRequest(
    integrationId: string,
    input: {
      repositoryId: string;
      baseBranch: string;
      headBranch: string;
      title: string;
      body: string;
      files: { path: string; content: string }[];
    },
  ): Promise<{ number: number; url: string }> {
    const integration = this.requireIntegration(integrationId);
    const installation = this.store
      .installations(this.ctx.workspaceId, integrationId)
      .find((entry) =>
        this.store.repository(entry.workspaceId, entry.installationId, input.repositoryId),
      );
    const repository = installation
      ? this.store.repository(this.ctx.workspaceId, installation.installationId, input.repositoryId)
      : null;
    if (!installation || !repository?.granted || !repository.settings.projectId)
      throw new ContractError("NOT_FOUND", "Repository is not part of this integration", {
        repositoryId: input.repositoryId,
      });
    this.ctx.authorizeNamed("approve", "AgentPullRequest", repository.settings.projectId, null);
    if (!integration.settings.allowAgentPullRequests)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Agent pull requests are not enabled for this integration",
        { reasonCode: "agent_pull_requests_disabled" },
      );
    if (installation.permissions.contents !== "write")
      throw new ContractError(
        "PRECONDITION_FAILED",
        "The installation does not grant contents: write",
        { reasonCode: "installation_permission_missing" },
      );
    if (
      !/^testmaster\/[A-Za-z0-9._/-]{1,100}$/u.test(input.headBranch) ||
      input.headBranch === input.baseBranch ||
      input.headBranch.includes("..")
    )
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Agent branches must be new testmaster/ branches",
        { field: "headBranch" },
      );
    if (
      !input.files.length ||
      input.files.length > 50 ||
      input.files.some(
        (file) =>
          file.path.startsWith("/") ||
          file.path.split("/").includes("..") ||
          file.path.startsWith(".github/"),
      )
    )
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Agent changes may not touch workflows or leave the repository",
        { field: "files" },
      );
    const token = await this.token(
      integration,
      installation.installationId,
      repository.repositoryId,
      {
        contents: "write",
        pull_requests: "write",
      },
    );
    const api = this.runtime.api;
    const repo = `/repos/${repository.fullName}`;
    const base = (await api.request(token, "GET", `${repo}/git/ref/heads/${input.baseBranch}`))
      .data as { object: { sha: string } };
    await api.request(token, "POST", `${repo}/git/refs`, {
      ref: `refs/heads/${input.headBranch}`,
      sha: base.object.sha,
    });
    for (const file of input.files)
      await api.request(
        token,
        "PUT",
        `${repo}/contents/${file.path.split("/").map(encodeURIComponent).join("/")}`,
        {
          message: input.title,
          content: Buffer.from(file.content).toString("base64"),
          branch: input.headBranch,
        },
      );
    const pr = (
      await api.request(token, "POST", `${repo}/pulls`, {
        title: input.title,
        body: input.body,
        head: input.headBranch,
        base: input.baseBranch,
        draft: true,
      })
    ).data as { number: number; html_url: string };
    auditSecurity(
      this.ctx,
      "integrations.github.agent_pr",
      `${repository.fullName}#${pr.number}`,
      "allowed",
    );
    return { number: pr.number, url: pr.html_url };
  }

  /** Test delivery (INT-004): proves the App credentials, creates no check, comment or Run. */
  async verifyApp(integration: GithubIntegration): Promise<{ ok: boolean; detail: string }> {
    try {
      const credentials = await this.credentials(integration);
      const jwt = appJwt(
        credentials.appId,
        credentials.privateKeyPem,
        this.runtime.now().getTime(),
      );
      const { data } = await this.runtime.api.request(jwt, "GET", "/app");
      const app = data as { id?: number } | null;
      return app?.id === Number(credentials.appId)
        ? { ok: true, detail: "GitHub App credentials verified (test notification)" }
        : { ok: false, detail: "GitHub reports a different App ID" };
    } catch (error) {
      return { ok: false, detail: `app_check_failed:${classifyProblem(error)}` };
    }
  }
}

function requiredScopesFor(allowAgent: boolean): string[] {
  return [
    "github:metadata:read",
    "github:contents:read",
    "github:checks:write",
    "github:pull_requests:write",
    "github:deployments:read",
    ...(allowAgent ? ["github:contents:write"] : []),
  ];
}

export { manifestPermissions, requiredScopesFor };
