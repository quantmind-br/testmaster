import {
  type Analysis,
  ContractError,
  DESCRIPTION_MAX_LENGTH,
  type IssueImportInput,
  type IssueImportReceipt,
  type IssueLink,
  type IssueLinkDraftInput,
  type IssueLinkExecuteInput,
  type IssueLinkPreview,
  type IssueLinkSyncReceipt,
  type IssuePayloadValue,
  NAME_MAX_LENGTH,
  validate,
} from "@testmaster/contracts";
import { canonicalJson, scrubEvidenceText, sha256 } from "@testmaster/domain";
import type { EntityDocument, PageCursor } from "@testmaster/persistence";
import type { AnalysisService } from "../../ai/analysis.js";
import type { SourcesService } from "../../ai/sources.js";
import { auditSecurity } from "../../audit.js";
import { entity, requireEntity, type ServiceContext } from "../../context.js";
import type { StoredIntegration } from "../provider.js";
import type { IntegrationsService } from "../service.js";
import {
  isCredentialReason,
  isDeleted,
  type TrackerAdapter,
  type TrackerIssue,
} from "./adapter.js";
import { buildTrackerAdapter, isTrackerProvider } from "./providers.js";

/** A stored IssueLink as the entity repository returns it. */
type IssueLinkDoc = EntityDocument & IssueLink;

export interface TrackersServiceDeps {
  integrations: IntegrationsService;
  sources: SourcesService;
  analysis: Pick<AnalysisService, "get">;
  /** Origin the portal is served from; the Run link of a payload is built on it. */
  publicOrigin: string;
}
export interface IssueLinkListFilter {
  runId?: string;
  projectId?: string;
}

const UNCONFIRMED_TITLE_PREFIX = "Unconfirmed failure: ";
const UNCONFIRMED_LABEL = "testmaster-unconfirmed";
const FAILED_CONCLUSIONS: readonly string[] = ["cause_unknown", "cause_partially_supported"];
const FAILURE_DETAIL_LIMIT = 500;

/** Shortens text to a schema bound; the cut never splits what the bound counts. */
function fit(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
/** Text that leaves the platform: credentials and personal data are scrubbed, then bounded. */
function outbound(text: string, max: number): string {
  return fit(scrubEvidenceText(text).text, max);
}
/** The Jira project key or Linear team key an issue key belongs to. */
function containerOfKey(issueKey: string): string {
  return issueKey.slice(0, issueKey.lastIndexOf("-"));
}
const payloadHashOf = (payload: IssuePayloadValue): string => sha256(canonicalJson(payload));

/** The Jira project or Linear team a `create` files into. */
function containerOf(integration: StoredIntegration): string {
  const settings = integration.settings as { projectKey?: string; teamKey?: string };
  return String(settings.projectKey ?? settings.teamKey);
}

/** One outcome of looking at an executed link's issue; `null` fields stay as they were. */
interface Observation {
  syncState: IssueLink["syncState"];
  externalStatus?: string | null;
  externalStatusCategory?: IssueLink["externalStatusCategory"];
}

/**
 * Trackers (REQ-043, INT-030..033, ADR-034): tickets enter as untrusted sources, failed Runs
 * become drafts, and nothing reaches a tracker without a preview, the previewed hash and an
 * explicit acknowledgement. Sync only records what the tracker says about an issue.
 */
export class TrackersService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly deps: TrackersServiceDeps,
  ) {}

  /** An active tracker integration of this workspace that serves `projectId`. */
  private integration(id: string, projectId: string): StoredIntegration {
    const integration = this.deps.integrations.stored(id);
    if (!isTrackerProvider(integration.provider))
      throw new ContractError("INVALID_ARGUMENT", "Integration is not an issue tracker", {
        provider: integration.provider,
      });
    if (integration.state !== "active")
      throw new ContractError("PRECONDITION_FAILED", "Integration is not active", {
        reasonCode: `integration_${integration.state}`,
      });
    if (!integration.projectIds.includes(projectId))
      throw new ContractError("FORBIDDEN", "Integration does not serve this project", {
        reasonCode: "project_not_permitted",
      });
    return integration;
  }

  private adapter(integration: StoredIntegration): Promise<TrackerAdapter> {
    const { secrets } = this.deps.integrations.deliveryContext(
      this.ctx.correlationId ?? integration.id,
    );
    return buildTrackerAdapter(integration, secrets);
  }

  private linkOf(id: string): IssueLinkDoc {
    return requireEntity(this.ctx, "IssueLink", id) as IssueLinkDoc;
  }

  // ------------------------------------------------------------------------- import (INT-030)

  /**
   * Imports a ticket as a source revision: a new source for a new issue, a new revision when its
   * rendered text changed, nothing when it did not. The text stays untrusted data everywhere.
   */
  async import(integrationId: string, input: IssueImportInput): Promise<IssueImportReceipt> {
    validate("IssueImportInput", input);
    this.ctx.authorize("W", input.projectId);
    const integration = this.integration(integrationId, input.projectId);
    const adapter = await this.adapter(integration);
    if (!input.issueKey.startsWith(`${adapter.container}-`))
      throw new ContractError("INVALID_ARGUMENT", "Issue is outside the integration's project", {
        reasonCode: "issue_outside_container",
        container: adapter.container,
      });
    const fetched = await adapter.fetchIssue(input.issueKey);
    if (isDeleted(fetched))
      throw new ContractError("NOT_FOUND", "Issue does not exist in the tracker", {
        issueKey: input.issueKey,
      });
    if (fetched.issueKey !== input.issueKey)
      throw new ContractError("PRECONDITION_FAILED", "Issue moved to another key", {
        reasonCode: "issue_moved",
        issueKey: fetched.issueKey,
      });
    const text = this.renderTicket(fetched);
    const checksum = sha256(Buffer.from(text, "utf8"));
    const provider = integration.provider;
    const existing = this.deps.sources.trackerSource(
      input.projectId,
      integration.id,
      input.issueKey,
    );
    const receipt = (
      detail: { source: { id: string }; revision: { id: string } },
      revision: string,
      unchanged: boolean,
    ): IssueImportReceipt => ({
      integrationId: integration.id as IssueImportReceipt["integrationId"],
      provider: provider as IssueImportReceipt["provider"],
      issueKey: input.issueKey,
      sourceId: detail.source.id as IssueImportReceipt["sourceId"],
      revisionId: detail.revision.id as IssueImportReceipt["revisionId"],
      unchanged,
      revision,
      checksum,
    });
    if (existing && existing.origin.checksum === checksum)
      return receipt(existing.detail, existing.origin.revision, true);
    const detail = await this.deps.sources.addText({
      projectId: input.projectId,
      role: "ticket",
      name: outbound(`${fetched.issueKey}: ${fetched.title}`, NAME_MAX_LENGTH),
      text,
      format: "markdown",
      origin: {
        kind: "tracker",
        provider,
        integrationId: integration.id,
        issueKey: input.issueKey,
        revision: fit(fetched.updatedAt, NAME_MAX_LENGTH),
        checksum,
      },
      ...(existing
        ? {
            sourceId: existing.detail.source.id,
            expectedVersion: existing.detail.source.version as number,
          }
        : {}),
    });
    auditSecurity(this.ctx, "issues.import", detail.source.id, "allowed");
    return receipt(detail, fit(fetched.updatedAt, NAME_MAX_LENGTH), false);
  }

  /** The markdown a ticket is stored as: the issue's own words under a header the reader can trust to be the tracker's. */
  private renderTicket(issue: TrackerIssue): string {
    const lines = [`# ${issue.issueKey}: ${issue.title}`, "", `Status: ${issue.status}`];
    if (issue.labels.length) lines.push(`Labels: ${issue.labels.join(", ")}`);
    return `${lines.join("\n")}\n\n${issue.text}\n`;
  }

  // ----------------------------------------------------------------------- drafting (INT-031/033)

  /**
   * Drafts the issue a failed Run would file. Nothing contacts the tracker: the draft joins an open
   * issue of the same defect signature (INT-033) or stands for a new one, and a Run whose cause is
   * not established yields an unconfirmed payload that never claims a defect.
   */
  draft(input: IssueLinkDraftInput): IssueLinkDoc {
    validate("IssueLinkDraftInput", input);
    const run = requireEntity(this.ctx, "Run", input.runId);
    const test = requireEntity(this.ctx, "TestCase", String(run.testId));
    const projectId = String(test.projectId);
    this.ctx.authorize("W", projectId);
    if (run.phase !== "completed" || run.outcome !== "failed")
      throw new ContractError("PRECONDITION_FAILED", "Only a failed Run can be filed as an issue", {
        reasonCode: "run_not_failed",
        phase: run.phase,
        outcome: run.outcome,
      });
    const integration = this.integration(input.integrationId, projectId);
    const analysis = this.analysisFor(run, input.analysisId);
    const cell = run.matrixCell as Record<string, unknown>;
    const environmentId = String(cell.environmentId);
    const uncertain = this.isUncertain(analysis);
    const signature = this.signature(projectId, run, environmentId, analysis);
    const open = this.openLink(projectId, integration.id, signature);
    const link = entity(this.ctx, "isl", {
      projectId,
      integrationId: integration.id,
      runId: run.id,
      analysisId: analysis?.id ?? null,
      kind: open ? "link" : "create",
      status: "draft",
      issueKey: open ? open.issueKey : null,
      signature,
      scope: {
        testId: run.testId,
        revisionId: run.revisionId,
        environmentId,
        environmentRevisionId: run.environmentRevisionId,
      },
      uncertain,
      payload: this.renderPayload(run, test, environmentId, analysis, uncertain),
      payloadHash: null,
      externalStatus: null,
      externalStatusCategory: null,
      syncState: "ok",
      createdBy: this.ctx.principalId || "unauthenticated:local",
      executedBy: null,
      executedAt: null,
      syncedAt: null,
      failure: null,
    });
    this.ctx.entities.insert("IssueLink", link);
    auditSecurity(this.ctx, "issue_links.draft", link.id, "allowed");
    return link as IssueLinkDoc;
  }

  private analysisFor(run: EntityDocument, analysisId: string | undefined): Analysis | null {
    if (!analysisId) return this.deps.analysis.get(run.id);
    const analysis = requireEntity(this.ctx, "Analysis", analysisId) as unknown as Analysis;
    if (analysis.runId !== run.id)
      throw new ContractError("INVALID_ARGUMENT", "Analysis belongs to another Run", {
        analysisId,
      });
    return analysis;
  }

  /** True unless an analysis established the cause: no analysis, an unknown kind, no confidence or an open conclusion. */
  private isUncertain(analysis: Analysis | null): boolean {
    if (!analysis || analysis.failureKind === "unknown" || analysis.confidence === null)
      return true;
    const status = analysis.diagnosis?.conclusion.status;
    return status === undefined || FAILED_CONCLUSIONS.includes(status);
  }

  /** INT-033: project, test revision, environment and the shape of the diagnosis; never its prose. */
  private signature(
    projectId: string,
    run: EntityDocument,
    environmentId: string,
    analysis: Analysis | null,
  ): string {
    const observation = analysis?.diagnosis?.observation;
    return sha256(
      canonicalJson({
        projectId,
        testRevisionId: run.revisionId,
        environmentId,
        failureKind: analysis?.failureKind ?? null,
        observation: observation
          ? {
              stepId: observation.stepId,
              operation: observation.operation,
              absence: observation.absence,
            }
          : null,
        chain: (analysis?.diagnosis?.chain ?? []).map(({ stepId, status }) => ({ stepId, status })),
      }),
    );
  }

  /** The newest executed link of the same signature whose issue is still open and in sync. */
  private openLink(
    projectId: string,
    integrationId: string,
    signature: string,
    exceptId?: string,
  ): (IssueLinkDoc & { issueKey: string }) | null {
    const candidates = this.page({ projectId, integrationId, signature, status: "executed" });
    return (
      candidates.find(
        (candidate): candidate is IssueLinkDoc & { issueKey: string } =>
          candidate.id !== exceptId &&
          candidate.issueKey !== null &&
          candidate.syncState === "ok" &&
          candidate.externalStatusCategory === "open",
      ) ?? null
    );
  }

  private renderPayload(
    run: EntityDocument,
    test: EntityDocument,
    environmentId: string,
    analysis: Analysis | null,
    uncertain: boolean,
  ): IssuePayloadValue {
    const environment = this.ctx.entities.get("Environment", this.ctx.workspaceId, environmentId);
    const testName = String(test.name);
    const environmentName = String(environment?.name ?? environmentId);
    const observation = analysis?.diagnosis?.observation ?? null;
    const lines = uncertain
      ? [
          "TestMaster observed a failed Run. The cause of the failure is not established; treat this report as unconfirmed.",
        ]
      : ["TestMaster observed a failed Run."];
    lines.push(
      "",
      `Test: ${testName}`,
      `Environment: ${environmentName}`,
      `Run: ${run.id}`,
      `Test revision: ${run.revisionId}`,
    );
    if (!uncertain && analysis) lines.push(`Failure kind: ${analysis.failureKind}`);
    if (observation) {
      lines.push("", `Observation: ${observation.summary}`);
      if (observation.expected) lines.push(`Expected: ${observation.expected}`);
      if (observation.observed) lines.push(`Observed: ${observation.observed}`);
    }
    if (!uncertain && analysis?.diagnosis)
      lines.push("", `Conclusion: ${analysis.diagnosis.conclusion.text}`);
    if (!uncertain && analysis) lines.push(`Recommended action: ${analysis.recommendedAction}`);
    const title = uncertain
      ? `${UNCONFIRMED_TITLE_PREFIX}${testName} in ${environmentName}`
      : `${testName} failed in ${environmentName}`;
    return {
      title: outbound(title, NAME_MAX_LENGTH),
      body: outbound(lines.join("\n"), DESCRIPTION_MAX_LENGTH),
      labels: uncertain
        ? ["testmaster", UNCONFIRMED_LABEL]
        : ["testmaster", `testmaster-${analysis?.failureKind}`],
      link: {
        url: `${this.deps.publicOrigin.replace(/\/+$/u, "")}/runs/${run.id}`,
        title: outbound(`TestMaster Run ${run.id}`, NAME_MAX_LENGTH),
      },
    };
  }

  // ------------------------------------------------------------------ preview and execute (INT-031)

  /** Renders exactly what execution would send and records the hash that execution must present. */
  preview(id: string): IssueLinkPreview {
    const link = this.linkOf(id);
    this.ctx.authorize("W", link.projectId);
    if (link.status === "executed")
      throw new ContractError("PRECONDITION_FAILED", "Issue link was already executed", {
        reasonCode: "issue_link_executed",
      });
    const integration = this.integration(link.integrationId, link.projectId);
    const payloadHash = payloadHashOf(link.payload);
    this.ctx.entities.update("IssueLink", this.ctx.workspaceId, link.id, Number(link.version), {
      ...link,
      status: "previewed",
      payloadHash,
      failure: null,
    });
    auditSecurity(this.ctx, "issue_links.preview", link.id, "allowed");
    return {
      issueLink: this.linkOf(id),
      payload: link.payload,
      payloadHash,
      destination: {
        provider: integration.provider as IssueLinkPreview["destination"]["provider"],
        kind: link.kind,
        issueKey: link.issueKey,
        container: containerOf(integration),
      },
    };
  }

  /**
   * Sends the previewed payload, once the caller presents its hash and acknowledges it. A tracker
   * refusal is recorded on the link (`failed`) and never loses an issue that was already created.
   */
  async execute(id: string, input: IssueLinkExecuteInput): Promise<IssueLinkDoc> {
    validate("IssueLinkExecuteInput", input);
    const link = this.linkOf(id);
    this.ctx.authorize("W", link.projectId);
    if (link.status !== "previewed")
      throw new ContractError("PRECONDITION_FAILED", "Preview the issue link before executing it", {
        reasonCode: "issue_link_not_previewed",
        status: link.status,
      });
    const hash = payloadHashOf(link.payload);
    if (link.payloadHash !== hash || input.payloadHash !== hash)
      throw new ContractError("INVALID_ARGUMENT", "Payload hash does not match the preview", {
        reasonCode: "payload_hash_mismatch",
      });
    const integration = this.integration(link.integrationId, link.projectId);
    if (link.kind === "create") {
      const open = this.openLink(link.projectId, integration.id, link.signature, link.id);
      if (open)
        throw new ContractError(
          "PRECONDITION_FAILED",
          "An open issue already covers this failure",
          {
            reasonCode: "duplicate_issue_link",
            issueKey: open.issueKey,
          },
        );
    }
    // Claim: a concurrent execution of the same version fails here, before any request leaves.
    let version = Number(link.version);
    const save = (next: Record<string, unknown>): void => {
      this.ctx.entities.update("IssueLink", this.ctx.workspaceId, link.id, version, {
        ...link,
        ...next,
      } as EntityDocument);
      version += 1;
    };
    save({});
    auditSecurity(this.ctx, "issue_links.execute", link.id, "requested");
    let issueKey = link.issueKey;
    try {
      const adapter = await this.adapter(integration);
      if (link.kind === "create" && !issueKey) {
        issueKey = (await adapter.createIssue(link.payload)).issueKey;
        // The issue exists from here on: remember it so a retry links instead of creating again.
        save({ issueKey });
      }
      if (!issueKey) throw new ContractError("INTERNAL", "Issue link has no issue to attach to");
      await adapter.linkRun(issueKey, link.payload.link);
    } catch (error) {
      const created = link.issueKey === null && issueKey !== null;
      save({
        status: "failed",
        issueKey,
        failure: this.failureOf(error, created ? issueKey : null),
      });
      auditSecurity(this.ctx, "issue_links.execute", link.id, "denied");
      return this.linkOf(id);
    }
    save({
      status: "executed",
      issueKey,
      executedBy: this.ctx.principalId || "unauthenticated:local",
      executedAt: new Date().toISOString(),
      externalStatus: null,
      externalStatusCategory: "open",
      syncState: "ok",
      failure: null,
    });
    auditSecurity(this.ctx, "issue_links.execute", link.id, "allowed");
    return this.linkOf(id);
  }

  private failureOf(error: unknown, createdKey: string | null): IssueLink["failure"] {
    const reasonCode =
      error instanceof ContractError && typeof error.details.reasonCode === "string"
        ? error.details.reasonCode
        : error instanceof ContractError
          ? error.code
          : "tracker_unavailable";
    const message = error instanceof ContractError ? error.message : "Tracker call failed";
    return {
      reasonCode: fit(reasonCode, NAME_MAX_LENGTH),
      detail: fit(
        createdKey
          ? `Issue ${createdKey} was created but linking the Run failed: ${message}`
          : message,
        FAILURE_DETAIL_LIMIT,
      ),
    };
  }

  // ---------------------------------------------------------------------------------- listing

  /** Links of one Run and/or one project, newest first. */
  list(filter: IssueLinkListFilter): IssueLinkDoc[] {
    if (!filter.runId && !filter.projectId)
      throw new ContractError("INVALID_ARGUMENT", "runId or projectId is required");
    let projectId = filter.projectId;
    if (filter.runId) {
      const run = requireEntity(this.ctx, "Run", filter.runId);
      const owner = String(requireEntity(this.ctx, "TestCase", String(run.testId)).projectId);
      if (projectId && projectId !== owner)
        throw new ContractError("INVALID_ARGUMENT", "Run belongs to another project");
      projectId = owner;
    }
    this.ctx.authorize("R", projectId);
    return this.page({
      projectId: projectId as string,
      ...(filter.runId ? { runId: filter.runId } : {}),
    });
  }

  private page(where: Record<string, string>): IssueLinkDoc[] {
    const items: IssueLinkDoc[] = [];
    let cursor: PageCursor | null = null;
    do {
      const page: { items: IssueLinkDoc[]; next: PageCursor | null } = this.ctx.entities.page(
        "IssueLink",
        this.ctx.workspaceId,
        { limit: 100, where, ...(cursor ? { cursor } : {}) },
      );
      items.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return items;
  }

  // ---------------------------------------------------------------------------- sync (INT-032)

  /**
   * Records what each tracker says about the executed links of a project. Only IssueLink rows are
   * written: a closed, deleted, moved or unreachable issue never changes a Run, its outcome, its
   * gates or its analysis.
   */
  async sync(projectId: string): Promise<IssueLinkSyncReceipt> {
    this.ctx.authorize("W", projectId);
    const links: IssueLinkSyncReceipt["links"] = [];
    for (const candidate of this.page({ projectId, status: "executed" })) {
      const link = await this.syncOne(candidate);
      links.push({
        id: link.id as IssueLinkSyncReceipt["links"][number]["id"],
        syncState: link.syncState,
        externalStatus: link.externalStatus,
        externalStatusCategory: link.externalStatusCategory,
      });
    }
    auditSecurity(this.ctx, "issue_links.sync", projectId, "allowed");
    return {
      projectId: projectId as IssueLinkSyncReceipt["projectId"],
      checked: links.length,
      links,
    };
  }

  /** One controller pass over every project of this workspace that holds an executed link. */
  async syncAll(): Promise<number> {
    const rows = this.ctx.database.all(
      "SELECT DISTINCT project_id FROM issue_links WHERE workspace_id=? AND status='executed'",
      this.ctx.workspaceId,
    );
    let checked = 0;
    for (const row of rows) {
      try {
        checked += (await this.sync(String(row.project_id))).checked;
      } catch (error) {
        if (!(error instanceof ContractError)) throw error;
      }
    }
    return checked;
  }

  private async syncOne(link: IssueLinkDoc): Promise<IssueLinkDoc> {
    const observation = await this.observe(link);
    if (!observation) return link;
    const next = { ...link, ...observation, syncedAt: new Date().toISOString() };
    try {
      this.ctx.entities.update(
        "IssueLink",
        this.ctx.workspaceId,
        link.id,
        Number(link.version),
        next as EntityDocument,
      );
    } catch (error) {
      // Another pass recorded a newer observation first; theirs stands.
      if (error instanceof ContractError && error.code === "REVISION_CONFLICT")
        return this.linkOf(link.id);
      throw error;
    }
    return this.linkOf(link.id);
  }

  /** What the tracker says now; `null` when it cannot be asked and the last known state stands. */
  private async observe(link: IssueLinkDoc): Promise<Observation | null> {
    const issueKey = link.issueKey;
    if (!issueKey) return null;
    let integration: StoredIntegration;
    try {
      integration = this.deps.integrations.stored(link.integrationId);
    } catch {
      return { syncState: "revoked" };
    }
    if (integration.state === "revoked") return { syncState: "revoked" };
    if (integration.state === "paused") return null;
    try {
      const fetched = await (await this.adapter(integration)).fetchIssue(issueKey);
      if (isDeleted(fetched)) return { syncState: "deleted" };
      const moved =
        fetched.issueKey !== issueKey || fetched.projectKey !== containerOfKey(issueKey);
      return {
        syncState: moved ? "conflict" : "ok",
        externalStatus: fit(fetched.status, NAME_MAX_LENGTH),
        externalStatusCategory: fetched.statusCategory,
      };
    } catch (error) {
      if (error instanceof ContractError && isCredentialReason(error.details.reasonCode))
        return { syncState: "revoked" };
      return null;
    }
  }
}
