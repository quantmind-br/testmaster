import { randomUUID } from "node:crypto";
import {
  ContractError,
  type GithubCheck,
  type GithubRepositorySettings,
  githubDefaultRepositorySettings,
} from "@testmaster/contracts";
import type { PersistenceDatabase } from "@testmaster/persistence";

type Row = Record<string, unknown>;
const text = (value: unknown): string => String(value);
const nullable = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

export interface InstallationRecord {
  workspaceId: string;
  installationId: string;
  integrationId: string;
  accountLogin: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  state: "active" | "revoked";
  revokedReason: string | null;
  permissions: Record<string, string>;
  events: string[];
  createdAt: string;
  updatedAt: string;
  version: number;
}
export interface RepositoryRecord {
  workspaceId: string;
  installationId: string;
  repositoryId: string;
  fullName: string;
  private: boolean;
  granted: boolean;
  settings: GithubRepositorySettings;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export type PullState =
  | "awaiting_preview"
  | "running"
  | "completed"
  | "superseded"
  | "timed_out"
  | "denied"
  | "skipped"
  | "closed";
export const terminalPullStates: readonly PullState[] = [
  "completed",
  "superseded",
  "timed_out",
  "denied",
  "skipped",
  "closed",
];
export interface PullRecord {
  workspaceId: string;
  id: string;
  integrationId: string;
  installationId: string;
  repositoryId: string;
  fullName: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  mergeSha: string | null;
  fork: boolean;
  draft: boolean;
  state: PullState;
  reasonCode: string | null;
  projectId: string | null;
  environmentId: string | null;
  previewUrl: string | null;
  deploymentId: string | null;
  previewDeadlineAt: string | null;
  batchId: string | null;
  supersededBy: string | null;
  gate: "pending" | "passed" | "failed" | "not_applicable" | null;
  commentId: string | null;
  commentDirty: boolean;
  commentAttempts: number;
  commentNextAt: string | null;
  commentError: string | null;
  resultJson: string | null;
  reportHash: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export interface DeploymentRecord {
  workspaceId: string;
  installationId: string;
  repositoryId: string;
  fullName: string;
  deploymentId: string;
  sha: string;
  environment: string;
  state: string;
  targetUrl: string | null;
  deliveryId: string;
}
export type CheckState = GithubCheck["state"];
export interface CheckRecord {
  workspaceId: string;
  id: string;
  pullId: string;
  installationId: string;
  fullName: string;
  headSha: string;
  name: GithubCheck["name"];
  externalId: string;
  status: GithubCheck["status"];
  conclusion: GithubCheck["conclusion"];
  title: string;
  summary: string;
  detailsUrl: string | null;
  seq: number;
  deliveredSeq: number;
  remoteId: string | null;
  state: CheckState;
  attempts: number;
  firstFailedAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  history: { seq: number; status: string; conclusion: string | null; at: string }[];
  createdAt: string;
  updatedAt: string;
  version: number;
}

const installation = (row: Row): InstallationRecord => ({
  workspaceId: text(row.workspace_id),
  installationId: text(row.installation_id),
  integrationId: text(row.integration_id),
  accountLogin: text(row.account_login),
  accountType: text(row.account_type) as InstallationRecord["accountType"],
  repositorySelection: text(row.repository_selection) as InstallationRecord["repositorySelection"],
  state: text(row.state) as InstallationRecord["state"],
  revokedReason: nullable(row.revoked_reason),
  permissions: JSON.parse(text(row.permissions_json)) as Record<string, string>,
  events: JSON.parse(text(row.events_json)) as string[],
  createdAt: text(row.created_at),
  updatedAt: text(row.updated_at),
  version: Number(row.version),
});
const repository = (row: Row): RepositoryRecord => ({
  workspaceId: text(row.workspace_id),
  installationId: text(row.installation_id),
  repositoryId: text(row.repository_id),
  fullName: text(row.full_name),
  private: Number(row.private) === 1,
  granted: Number(row.granted) === 1,
  settings: JSON.parse(text(row.settings_json)) as GithubRepositorySettings,
  createdAt: text(row.created_at),
  updatedAt: text(row.updated_at),
  version: Number(row.version),
});
const pull = (row: Row): PullRecord => ({
  workspaceId: text(row.workspace_id),
  id: text(row.id),
  integrationId: text(row.integration_id),
  installationId: text(row.installation_id),
  repositoryId: text(row.repository_id),
  fullName: text(row.full_name),
  prNumber: Number(row.pr_number),
  headSha: text(row.head_sha),
  baseSha: text(row.base_sha),
  mergeSha: nullable(row.merge_sha),
  fork: Number(row.fork) === 1,
  draft: Number(row.draft) === 1,
  state: text(row.state) as PullState,
  reasonCode: nullable(row.reason_code),
  projectId: nullable(row.project_id),
  environmentId: nullable(row.environment_id),
  previewUrl: nullable(row.preview_url),
  deploymentId: nullable(row.deployment_id),
  previewDeadlineAt: nullable(row.preview_deadline_at),
  batchId: nullable(row.batch_id),
  supersededBy: nullable(row.superseded_by),
  gate: nullable(row.gate) as PullRecord["gate"],
  commentId: nullable(row.comment_id),
  commentDirty: Number(row.comment_dirty) === 1,
  commentAttempts: Number(row.comment_attempts),
  commentNextAt: nullable(row.comment_next_at),
  commentError: nullable(row.comment_error),
  resultJson: nullable(row.result_json),
  reportHash: nullable(row.report_hash),
  createdAt: text(row.created_at),
  updatedAt: text(row.updated_at),
  version: Number(row.version),
});
const deployment = (row: Row): DeploymentRecord => ({
  workspaceId: text(row.workspace_id),
  installationId: text(row.installation_id),
  repositoryId: text(row.repository_id),
  fullName: text(row.full_name),
  deploymentId: text(row.deployment_id),
  sha: text(row.sha),
  environment: text(row.environment),
  state: text(row.state),
  targetUrl: nullable(row.target_url),
  deliveryId: text(row.delivery_id),
});
const check = (row: Row): CheckRecord => ({
  workspaceId: text(row.workspace_id),
  id: text(row.id),
  pullId: text(row.pull_id),
  installationId: text(row.installation_id),
  fullName: text(row.full_name),
  headSha: text(row.head_sha),
  name: text(row.name) as CheckRecord["name"],
  externalId: text(row.external_id),
  status: text(row.status) as CheckRecord["status"],
  conclusion: nullable(row.conclusion) as CheckRecord["conclusion"],
  title: text(row.title),
  summary: text(row.summary),
  detailsUrl: nullable(row.details_url),
  seq: Number(row.seq),
  deliveredSeq: Number(row.delivered_seq),
  remoteId: nullable(row.remote_id),
  state: text(row.state) as CheckState,
  attempts: Number(row.attempts),
  firstFailedAt: nullable(row.first_failed_at),
  nextAttemptAt: nullable(row.next_attempt_at),
  lastError: nullable(row.last_error),
  history: JSON.parse(text(row.history_json)) as CheckRecord["history"],
  createdAt: text(row.created_at),
  updatedAt: text(row.updated_at),
  version: Number(row.version),
});

const historyLimit = 20;
/** Typed access to the GitHub App tables. Every statement names its workspace explicitly. */
export class GithubStore {
  constructor(readonly db: PersistenceDatabase) {}

  installation(workspaceId: string, installationId: string): InstallationRecord | null {
    const row = this.db.get(
      "SELECT * FROM github_installations WHERE workspace_id=? AND installation_id=?",
      workspaceId,
      installationId,
    );
    return row ? installation(row) : null;
  }
  installations(workspaceId: string, integrationId: string): InstallationRecord[] {
    return this.db
      .all(
        "SELECT * FROM github_installations WHERE workspace_id=? AND integration_id=? ORDER BY created_at,installation_id",
        workspaceId,
        integrationId,
      )
      .map(installation);
  }
  /** Installation IDs are unique across workspaces, so a webhook can be attributed with no tenant scope. */
  installationAnywhere(installationId: string): InstallationRecord | null {
    const row = this.db.get(
      "SELECT * FROM github_installations WHERE installation_id=?",
      installationId,
    );
    return row ? installation(row) : null;
  }
  upsertInstallation(
    input: Omit<InstallationRecord, "createdAt" | "updatedAt" | "version" | "revokedReason" | "state">,
    now: string,
  ): void {
    this.db.run(
      "INSERT INTO github_installations(workspace_id,installation_id,integration_id,account_login,account_type,repository_selection,state,permissions_json,events_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'active',?,?,?,?) ON CONFLICT(workspace_id,installation_id) DO UPDATE SET account_login=excluded.account_login,account_type=excluded.account_type,repository_selection=excluded.repository_selection,permissions_json=excluded.permissions_json,events_json=excluded.events_json,updated_at=excluded.updated_at,version=github_installations.version+1",
      input.workspaceId,
      input.installationId,
      input.integrationId,
      input.accountLogin,
      input.accountType,
      input.repositorySelection,
      JSON.stringify(input.permissions),
      JSON.stringify(input.events),
      now,
      now,
    );
  }
  setSelection(workspaceId: string, installationId: string, selection: string, now: string): void {
    this.db.run(
      "UPDATE github_installations SET repository_selection=?,updated_at=?,version=version+1 WHERE workspace_id=? AND installation_id=?",
      selection,
      now,
      workspaceId,
      installationId,
    );
  }
  markRevoked(workspaceId: string, installationId: string, reason: string, now: string): boolean {
    return (
      Number(
        this.db.run(
          "UPDATE github_installations SET state='revoked',revoked_reason=?,updated_at=?,version=version+1 WHERE workspace_id=? AND installation_id=? AND state='active'",
          reason,
          now,
          workspaceId,
          installationId,
        ).changes,
      ) === 1
    );
  }

  repository(
    workspaceId: string,
    installationId: string,
    repositoryId: string,
  ): RepositoryRecord | null {
    const row = this.db.get(
      "SELECT * FROM github_repositories WHERE workspace_id=? AND installation_id=? AND repository_id=?",
      workspaceId,
      installationId,
      repositoryId,
    );
    return row ? repository(row) : null;
  }
  repositories(workspaceId: string, installationId: string): RepositoryRecord[] {
    return this.db
      .all(
        "SELECT * FROM github_repositories WHERE workspace_id=? AND installation_id=? ORDER BY full_name",
        workspaceId,
        installationId,
      )
      .map(repository);
  }
  /** New repositories are granted but disabled and unbound until an administrator configures them. */
  upsertRepository(
    input: { workspaceId: string; installationId: string; repositoryId: string; fullName: string; private: boolean },
    granted: boolean,
    now: string,
  ): void {
    this.db.run(
      "INSERT INTO github_repositories(workspace_id,installation_id,repository_id,full_name,private,granted,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,installation_id,repository_id) DO UPDATE SET full_name=excluded.full_name,private=excluded.private,granted=excluded.granted,updated_at=excluded.updated_at,version=github_repositories.version+1",
      input.workspaceId,
      input.installationId,
      input.repositoryId,
      input.fullName,
      input.private ? 1 : 0,
      granted ? 1 : 0,
      JSON.stringify(githubDefaultRepositorySettings),
      now,
      now,
    );
  }
  setRepositorySettings(
    record: RepositoryRecord,
    settings: GithubRepositorySettings,
    now: string,
  ): void {
    const changed = this.db.run(
      "UPDATE github_repositories SET settings_json=?,updated_at=?,version=version+1 WHERE workspace_id=? AND installation_id=? AND repository_id=? AND version=?",
      JSON.stringify(settings),
      now,
      record.workspaceId,
      record.installationId,
      record.repositoryId,
      record.version,
    );
    if (Number(changed.changes) !== 1)
      throw new ContractError("REVISION_CONFLICT", "Repository settings changed concurrently");
  }
  setRepositoryGranted(
    workspaceId: string,
    installationId: string,
    repositoryId: string,
    granted: boolean,
    now: string,
  ): void {
    this.db.run(
      "UPDATE github_repositories SET granted=?,updated_at=?,version=version+1 WHERE workspace_id=? AND installation_id=? AND repository_id=?",
      granted ? 1 : 0,
      now,
      workspaceId,
      installationId,
      repositoryId,
    );
  }
  repositoryByName(workspaceId: string, installationId: string, fullName: string): RepositoryRecord | null {
    const row = this.db.get(
      "SELECT * FROM github_repositories WHERE workspace_id=? AND installation_id=? AND full_name=?",
      workspaceId,
      installationId,
      fullName,
    );
    return row ? repository(row) : null;
  }

  pull(workspaceId: string, id: string): PullRecord | null {
    const row = this.db.get("SELECT * FROM github_pulls WHERE workspace_id=? AND id=?", workspaceId, id);
    return row ? pull(row) : null;
  }
  pullByHead(
    workspaceId: string,
    installationId: string,
    repositoryId: string,
    prNumber: number,
    headSha: string,
  ): PullRecord | null {
    const row = this.db.get(
      "SELECT * FROM github_pulls WHERE workspace_id=? AND installation_id=? AND repository_id=? AND pr_number=? AND head_sha=?",
      workspaceId,
      installationId,
      repositoryId,
      prNumber,
      headSha,
    );
    return row ? pull(row) : null;
  }
  pullsOfPr(
    workspaceId: string,
    installationId: string,
    repositoryId: string,
    prNumber: number,
  ): PullRecord[] {
    return this.db
      .all(
        "SELECT * FROM github_pulls WHERE workspace_id=? AND installation_id=? AND repository_id=? AND pr_number=? ORDER BY created_at DESC,id DESC",
        workspaceId,
        installationId,
        repositoryId,
        prNumber,
      )
      .map(pull);
  }
  pullsForIntegration(workspaceId: string, integrationId: string, limit: number): PullRecord[] {
    return this.db
      .all(
        "SELECT * FROM github_pulls WHERE workspace_id=? AND integration_id=? ORDER BY created_at DESC,id DESC LIMIT ?",
        workspaceId,
        integrationId,
        limit,
      )
      .map(pull);
  }
  /** Pull states the reconciler must advance, across workspaces (controller scope). */
  activePulls(): PullRecord[] {
    return this.db
      .all(
        "SELECT * FROM github_pulls WHERE state IN ('awaiting_preview','running') ORDER BY created_at,id",
      )
      .map(pull);
  }
  pullsAwaitingDeployment(
    workspaceId: string,
    installationId: string,
    repositoryId: string,
    sha: string,
  ): PullRecord[] {
    return this.db
      .all(
        "SELECT * FROM github_pulls WHERE workspace_id=? AND installation_id=? AND repository_id=? AND head_sha=? AND state='awaiting_preview'",
        workspaceId,
        installationId,
        repositoryId,
        sha,
      )
      .map(pull);
  }
  dirtyCommentPulls(now: string): PullRecord[] {
    return this.db
      .all(
        "SELECT * FROM github_pulls WHERE comment_dirty=1 AND (comment_next_at IS NULL OR comment_next_at<=?) ORDER BY updated_at,id",
        now,
      )
      .map(pull);
  }
  insertPull(
    input: Pick<
      PullRecord,
      | "workspaceId"
      | "integrationId"
      | "installationId"
      | "repositoryId"
      | "fullName"
      | "prNumber"
      | "headSha"
      | "baseSha"
      | "mergeSha"
      | "fork"
      | "draft"
      | "state"
      | "reasonCode"
      | "projectId"
      | "environmentId"
      | "previewDeadlineAt"
    >,
    now: string,
  ): PullRecord {
    const id = `ghp_${randomUUID()}`;
    this.db.run(
      "INSERT INTO github_pulls(workspace_id,id,integration_id,installation_id,repository_id,full_name,pr_number,head_sha,base_sha,merge_sha,fork,draft,state,reason_code,project_id,environment_id,preview_deadline_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      input.workspaceId,
      id,
      input.integrationId,
      input.installationId,
      input.repositoryId,
      input.fullName,
      input.prNumber,
      input.headSha,
      input.baseSha,
      input.mergeSha,
      input.fork ? 1 : 0,
      input.draft ? 1 : 0,
      input.state,
      input.reasonCode,
      input.projectId,
      input.environmentId,
      input.previewDeadlineAt,
      now,
      now,
    );
    const inserted = this.pull(input.workspaceId, id);
    if (!inserted) throw new ContractError("INTERNAL", "Pull record vanished");
    return inserted;
  }
  /** Column updates for one pull; the state-machine freeze is enforced by a trigger. */
  updatePull(
    record: PullRecord,
    patch: Partial<{
      state: PullState;
      reasonCode: string | null;
      environmentId: string | null;
      previewUrl: string | null;
      deploymentId: string | null;
      previewDeadlineAt: string | null;
      batchId: string | null;
      supersededBy: string | null;
      gate: PullRecord["gate"];
      commentId: string | null;
      commentDirty: boolean;
      commentAttempts: number;
      commentNextAt: string | null;
      commentError: string | null;
      resultJson: string | null;
      reportHash: string | null;
    }>,
    now: string,
  ): PullRecord {
    const columns: Record<string, unknown> = {
      state: patch.state,
      reason_code: patch.reasonCode,
      environment_id: patch.environmentId,
      preview_url: patch.previewUrl,
      deployment_id: patch.deploymentId,
      preview_deadline_at: patch.previewDeadlineAt,
      batch_id: patch.batchId,
      superseded_by: patch.supersededBy,
      gate: patch.gate,
      comment_id: patch.commentId,
      comment_dirty: patch.commentDirty === undefined ? undefined : patch.commentDirty ? 1 : 0,
      comment_attempts: patch.commentAttempts,
      comment_next_at: patch.commentNextAt,
      comment_error: patch.commentError,
      result_json: patch.resultJson,
      report_hash: patch.reportHash,
    };
    const entries = Object.entries(columns).filter(([, value]) => value !== undefined);
    // A state or result change always schedules a comment refresh unless the caller says otherwise.
    const dirty = patch.commentDirty === undefined ? [["comment_dirty", 1]] : [];
    const set = [...entries, ...dirty];
    if (!set.length) return record;
    const changed = this.db.run(
      `UPDATE github_pulls SET ${set.map(([column]) => `${column}=?`).join(",")},updated_at=?,version=version+1 WHERE workspace_id=? AND id=? AND version=?`,
      ...set.map(([, value]) => value),
      now,
      record.workspaceId,
      record.id,
      record.version,
    );
    if (Number(changed.changes) !== 1)
      throw new ContractError("REVISION_CONFLICT", "Pull state changed concurrently");
    const fresh = this.pull(record.workspaceId, record.id);
    if (!fresh) throw new ContractError("INTERNAL", "Pull record vanished");
    return fresh;
  }

  deployment(workspaceId: string, repositoryId: string, deploymentId: string): DeploymentRecord | null {
    const row = this.db.get(
      "SELECT * FROM github_deployments WHERE workspace_id=? AND repository_id=? AND deployment_id=?",
      workspaceId,
      repositoryId,
      deploymentId,
    );
    return row ? deployment(row) : null;
  }
  deploymentsForSha(workspaceId: string, repositoryId: string, sha: string): DeploymentRecord[] {
    return this.db
      .all(
        "SELECT * FROM github_deployments WHERE workspace_id=? AND repository_id=? AND sha=? ORDER BY updated_at DESC,deployment_id DESC",
        workspaceId,
        repositoryId,
        sha,
      )
      .map(deployment);
  }
  upsertDeployment(input: DeploymentRecord, now: string): void {
    this.db.run(
      "INSERT INTO github_deployments(workspace_id,installation_id,repository_id,full_name,deployment_id,sha,environment,state,target_url,delivery_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,installation_id,repository_id,deployment_id) DO UPDATE SET state=excluded.state,environment=excluded.environment,target_url=excluded.target_url,delivery_id=excluded.delivery_id,updated_at=excluded.updated_at",
      input.workspaceId,
      input.installationId,
      input.repositoryId,
      input.fullName,
      input.deploymentId,
      input.sha,
      input.environment,
      input.state,
      input.targetUrl,
      input.deliveryId,
      now,
      now,
    );
  }

  check(workspaceId: string, id: string): CheckRecord | null {
    const row = this.db.get("SELECT * FROM github_checks WHERE workspace_id=? AND id=?", workspaceId, id);
    return row ? check(row) : null;
  }
  checksOfPull(workspaceId: string, pullId: string): CheckRecord[] {
    return this.db
      .all(
        "SELECT * FROM github_checks WHERE workspace_id=? AND pull_id=? ORDER BY name",
        workspaceId,
        pullId,
      )
      .map(check);
  }
  checksForIntegration(workspaceId: string, integrationId: string, limit: number): CheckRecord[] {
    return this.db
      .all(
        "SELECT c.* FROM github_checks c JOIN github_pulls p ON p.workspace_id=c.workspace_id AND p.id=c.pull_id WHERE c.workspace_id=? AND p.integration_id=? ORDER BY c.updated_at DESC,c.id DESC LIMIT ?",
        workspaceId,
        integrationId,
        limit,
      )
      .map(check);
  }
  dueChecks(now: string): CheckRecord[] {
    return this.db
      .all(
        "SELECT * FROM github_checks WHERE state<>'dead_letter' AND delivered_seq<seq AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY updated_at,id",
        now,
      )
      .map(check);
  }
  /**
   * Records the desired state of one check. Sequence numbers only grow and a completed check never
   * returns to queued or in-progress; the trigger enforces the same rules for any other writer.
   */
  desireCheck(
    input: {
      workspaceId: string;
      pullId: string;
      installationId: string;
      fullName: string;
      headSha: string;
      name: GithubCheck["name"];
      externalId: string;
      status: GithubCheck["status"];
      conclusion: GithubCheck["conclusion"];
      title: string;
      summary: string;
      detailsUrl: string | null;
    },
    now: string,
  ): CheckRecord {
    const existing = this.db.get(
      "SELECT * FROM github_checks WHERE workspace_id=? AND pull_id=? AND name=?",
      input.workspaceId,
      input.pullId,
      input.name,
    );
    if (!existing) {
      const id = `ghc_${randomUUID()}`;
      this.db.run(
        "INSERT INTO github_checks(workspace_id,id,pull_id,installation_id,full_name,head_sha,name,external_id,status,conclusion,title,summary,details_url,seq,delivered_seq,state,history_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,-1,'pending',?,?,?)",
        input.workspaceId,
        id,
        input.pullId,
        input.installationId,
        input.fullName,
        input.headSha,
        input.name,
        input.externalId,
        input.status,
        input.conclusion,
        input.title,
        input.summary,
        input.detailsUrl,
        JSON.stringify([{ seq: 0, status: input.status, conclusion: input.conclusion, at: now }]),
        now,
        now,
      );
      const created = this.check(input.workspaceId, id);
      if (!created) throw new ContractError("INTERNAL", "Check record vanished");
      return created;
    }
    const current = check(existing);
    if (current.status === "completed") return current;
    if (
      current.status === input.status &&
      current.conclusion === input.conclusion &&
      current.summary === input.summary &&
      current.title === input.title &&
      current.detailsUrl === input.detailsUrl
    )
      return current;
    const seq = current.seq + 1;
    const history = [
      ...current.history,
      { seq, status: input.status, conclusion: input.conclusion, at: now },
    ].slice(-historyLimit);
    const changed = this.db.run(
      "UPDATE github_checks SET status=?,conclusion=?,title=?,summary=?,details_url=?,seq=?,state='pending',attempts=0,first_failed_at=NULL,next_attempt_at=NULL,last_error=NULL,history_json=?,updated_at=?,version=version+1 WHERE workspace_id=? AND id=? AND version=?",
      input.status,
      input.conclusion,
      input.title,
      input.summary,
      input.detailsUrl,
      seq,
      JSON.stringify(history),
      now,
      current.workspaceId,
      current.id,
      current.version,
    );
    if (Number(changed.changes) !== 1)
      throw new ContractError("REVISION_CONFLICT", "Check changed concurrently");
    const fresh = this.check(current.workspaceId, current.id);
    if (!fresh) throw new ContractError("INTERNAL", "Check record vanished");
    return fresh;
  }
  /** `seq` is the sequence that was sent: a newer desired state stays due. */
  markDelivered(record: CheckRecord, seq: number, remoteId: string, now: string): void {
    this.db.run(
      "UPDATE github_checks SET delivered_seq=?,remote_id=?,state=?,attempts=0,first_failed_at=NULL,next_attempt_at=NULL,last_error=NULL,updated_at=?,version=version+1 WHERE workspace_id=? AND id=? AND delivered_seq<?",
      seq,
      remoteId,
      record.seq > seq ? "pending" : "delivered",
      now,
      record.workspaceId,
      record.id,
      seq,
    );
  }
  markFailed(
    record: CheckRecord,
    patch: { state: CheckState; lastError: string; nextAttemptAt: string | null; firstFailedAt: string },
    now: string,
  ): void {
    this.db.run(
      "UPDATE github_checks SET state=?,attempts=attempts+1,first_failed_at=?,next_attempt_at=?,last_error=?,updated_at=?,version=version+1 WHERE workspace_id=? AND id=?",
      patch.state,
      patch.firstFailedAt,
      patch.nextAttemptAt,
      patch.lastError,
      now,
      record.workspaceId,
      record.id,
    );
  }
  requeueCheck(record: CheckRecord, now: string): void {
    this.db.run(
      "UPDATE github_checks SET state='pending',attempts=0,first_failed_at=NULL,next_attempt_at=NULL,last_error=NULL,updated_at=?,version=version+1 WHERE workspace_id=? AND id=? AND state='dead_letter'",
      now,
      record.workspaceId,
      record.id,
    );
  }
}
