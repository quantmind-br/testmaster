import {
  ContractError,
  type ExecutablePlan,
  type PlanIssue,
  type Proposal,
  type ProposalBatch,
  type ProposalBatchSummary,
  type ProposalPreview,
  type Requirement,
  type TestCase,
  type TestRevision,
  validate,
} from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import {
  AuditRepository,
  type EntityDocument,
  IdempotencyRepository,
} from "@testmaster/persistence";
import {
  EvidenceCatalog,
  type GeneratedProposal,
  inspectGeneratedProposals,
  type SourceEvidenceRef,
  type UnsupportedRequirement,
  validateGeneratedProposals,
  validateProposalPlan,
} from "@testmaster/planner";
import { auditPromotion, authoringTransaction } from "../authoring.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "../context.js";
import { estimateDuration, flattenSteps, planSimilarity } from "../plan-analysis.js";
import { stepIdAt } from "../plan-validation.js";
import type { ModelService } from "./model.js";
import {
  type ConflictDecision,
  type RequirementSnapshot,
  type RequirementsService,
  refuseConflicted,
  refuseRejected,
  requirementContentHash,
  requirementContentHashes,
  requirementRejection,
  supersedingConflict,
} from "./requirements.js";
import { applyServerBasePath, unresolvedSchemaPointers } from "./source-documents.js";

const AUTH_PROFILE_INSTRUCTION =
  'When authProfiles are supplied, a request to an endpoint that needs a logged-in session or credential the profile manages (cookie session, bearer or API-key header) sets "auth": "profile" in the request input, so the environment\'s bound auth profile supplies the session for that request only; do not copy session secrets into headers for it. Leave auth out for public endpoints and for requests that must be unauthenticated (401/403 negatives). When no authProfiles are supplied never set auth.';
const JSON_BODY_SET_INSTRUCTION =
  'A secret or a value captured by an earlier request that belongs inside a JSON body (a password, an id) is bound with body.set, never nested in the body literal: {"kind":"json","value":{"user":"demo"},"set":[{"pointer":"/password","value":{"secretRef":<entry id>}}]}. A {"secretRef":...} or {"variableRef":...} object inside body.value is plain data and is sent as written.';
const BROWSER_POSTCONDITION_INSTRUCTION =
  "A browser plan that ends after a state-changing action (login, navigation, click, submit) must assert a positive, observable post-condition on rendered content after the last such action: a visible, textContains, textEquals, valueEquals or countEquals (above 0) assertion on a locator for content that exists only when the action worked, such as the dashboard heading after login. A URL check and the absence of earlier elements also hold on a blank page and are rejected.";
type StoredProposal = Proposal & EntityDocument;
function secretRefsOf(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) secretRefsOf(item, found);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      if (key === "secretRef" && typeof item === "string") found.push(item);
      else secretRefsOf(item, found);
  return found;
}
type StoredBatch = ProposalBatch & EntityDocument;
export type PlanGenerationType = "frontend" | "backend" | "integration" | "auto";
const planRunners = { backend: "http", frontend: "playwright", integration: "http" } as const;
export interface ProposalReceipt {
  accepted: string[];
  retained: string[];
  rejected: string[];
}

function validateIntegrationPlan(plan: ExecutablePlan): void {
  const requests = plan.steps.flatMap((step, index) =>
    step.kind === "action" && step.operation === "request" ? [{ step, index }] : [],
  );
  const captures = new Set<string>();
  for (const { step, index } of requests) {
    const input = step.input;
    const values = [
      ...input.pathSegments,
      ...(input.query ?? []).flatMap(({ name, value }) => [name, value]),
      ...Object.values(input.headers ?? {}),
      ...(input.body?.kind === "json" || input.body?.kind === "text"
        ? [input.body.value]
        : input.body?.kind === "form"
          ? input.body.fields.flatMap(({ name, value }) => [name, value])
          : []),
      ...(input.body?.kind === "json" ? (input.body.set ?? []).map(({ value }) => value) : []),
    ];
    if (
      requests.length >= 2 &&
      values.some((value) => "variableRef" in value && captures.has(value.variableRef)) &&
      plan.steps.slice(index + 1).some((assertion) => {
        if (
          assertion.kind !== "assertion" ||
          assertion.required === false ||
          !("responseStepId" in assertion.input) ||
          assertion.input.responseStepId !== step.id
        )
          return false;
        try {
          validateProposalPlan({
            ...plan,
            steps: [
              ...plan.steps.slice(0, index + 1).filter((prior) => prior.kind !== "assertion"),
              assertion,
            ],
          });
          return true;
        } catch (error) {
          if (error instanceof ContractError && error.code === "INVALID_ARGUMENT") return false;
          throw error;
        }
      })
    )
      return;
    for (const capture of input.capture ?? []) {
      captures.add(capture.name);
      captures.add(`${step.id}.${capture.name}`);
    }
  }
  throw new ContractError(
    "INVALID_ARGUMENT",
    "Integration proposals require at least two requests, a capture consumed by a later request, and a required business assertion over that downstream response",
  );
}
/** A generated proposal refused by the semantic checks; `index` is its position in the model output. */
interface GenerationRefusal {
  index: number;
  requirementIds: string[];
  reasonCode: string;
  message: string;
  pointers?: string[];
}
interface GenerationInspection {
  valid: GeneratedProposal[];
  refused: GenerationRefusal[];
  unsupported: UnsupportedRequirement[];
}
/**
 * The atomic refusal of a generated batch: nothing is stored. The message is the first refusal's,
 * so a single refused proposal reports exactly its cause; `details.refused` lists every one.
 */
function refusalError(
  refused: readonly GenerationRefusal[],
  extra: Record<string, unknown> = {},
): ContractError {
  const [first, ...rest] = refused;
  if (!first) throw new ContractError("INTERNAL", "A refusal needs at least one refused proposal");
  return new ContractError(
    "INVALID_ARGUMENT",
    rest.length
      ? `${first.message} (${rest.length} more refused proposal${rest.length === 1 ? "" : "s"}; see details.refused)`
      : first.message,
    { atomicity: "all_or_nothing", refused, ...extra },
    refused.map((item) => ({
      path: `/proposals/${item.index}`,
      rule: item.reasonCode,
      message: item.pointers?.length
        ? `${item.message}: ${item.pointers.join(", ")}`
        : item.message,
    })),
  );
}
/** Every selected requirement is proposed or declined exactly once; a refused proposal still claims its own. */
function coverageGap(
  state: GenerationInspection,
  requirementIds: readonly string[],
): ContractError | undefined {
  const claims = [
    ...state.valid.map((proposal) => proposal.requirementRefs),
    ...state.refused.map((item) => item.requirementIds),
  ];
  const covered = (requirementId: string): number =>
    claims.filter((refs) => refs.includes(requirementId)).length +
    state.unsupported.filter((item) => item.requirementId === requirementId).length;
  if (
    claims.length + state.unsupported.length !== requirementIds.length ||
    requirementIds.some((requirementId) => covered(requirementId) !== 1)
  )
    return new ContractError(
      "INVALID_ARGUMENT",
      "Generation must cover each selected requirement exactly once",
    );
  return undefined;
}
export class ProposalsService {
  constructor(
    readonly ctx: ServiceContext,
    readonly model: ModelService,
    readonly requirements: RequirementsService,
  ) {}
  /** Auth profiles of the project an HTTP request may use with `auth: "profile"`; none when unreadable. */
  private offeredAuthProfiles(
    projectId: string,
  ): { name: string; kind: string; origins: string[] }[] {
    try {
      this.ctx.authorize("R", projectId);
    } catch {
      return [];
    }
    return allEntities(this.ctx, "AuthProfile")
      .filter((profile) => profile.projectId === projectId)
      .map((profile) => ({
        name: String(profile.name),
        kind: String(profile.kind),
        origins: profile.originBindings as string[],
      }));
  }
  /** Secret names and ids the model may reference; none when the caller cannot read secrets. */
  private offeredSecrets(): { secretRef: string; name: string }[] {
    try {
      this.ctx.authorize("R");
    } catch {
      return [];
    }
    return allEntities(this.ctx, "SecretReference")
      .filter((secret) => !secret.revokedAt && !secret.managedBy)
      .map((secret) => ({ secretRef: String(secret.id), name: String(secret.locator) }));
  }
  async generate(input: {
    projectId: string;
    sourceSnapshotId?: string;
    /** `auto` lets the model choose frontend or backend per requirement; absent means backend. */
    type?: PlanGenerationType;
    requirementIds?: string[];
    provider?: string;
    model?: string;
    signal?: AbortSignal;
    idempotencyKey?: string;
    /**
     * After the repairs, store the proposals that pass and list the refused ones in
     * `testmaster:refusedProposals`; absent, one refused proposal refuses the whole batch.
     */
    partialGeneration?: boolean;
  }): Promise<StoredBatch> {
    this.ctx.authorize("W", input.projectId);
    if (input.idempotencyKey) {
      const { signal: _signal, idempotencyKey: _key, ...body } = input;
      const actorScope = `${this.ctx.principalId}:${input.projectId}`;
      const receipt = this.ctx.database.get(
        "SELECT expires_at FROM idempotency_receipts WHERE workspace_id=? AND actor_scope=? AND operation='proposal.generate' AND key=?",
        this.ctx.workspaceId,
        actorScope,
        input.idempotencyKey,
      );
      if (receipt && String(receipt.expires_at) > new Date().toISOString())
        return new IdempotencyRepository(this.ctx.database).execute<StoredBatch>(
          {
            workspaceId: this.ctx.workspaceId,
            actorScope,
            operation: "proposal.generate",
            key: input.idempotencyKey,
            body,
          },
          () => {
            throw new ContractError(
              "PRECONDITION_FAILED",
              "Generation receipt expired during retry",
            );
          },
        ).receipt;
    }
    const snapshot = this.requirements.snapshot(input.projectId);
    if (input.sourceSnapshotId && input.sourceSnapshotId !== snapshot.fingerprint)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "sourceSnapshotId must be the current requirement snapshot fingerprint returned by testmaster_normalize_requirements and readable at testmaster://requirements/{projectId}; the supplied value does not match (the snapshot changed since it was read, or the value is not a fingerprint)",
        { reasonCode: "requirement_snapshot_mismatch" },
      );
    // Without an explicit selection every requirement still in scope is planned: rejected ones and
    // the ones a conflict decision superseded are left out. An explicit selection of either is
    // refused by requireApproved below, like a requirement whose conflict is still undecided.
    const requirements = snapshot.requirements.filter((item) =>
      input.requirementIds
        ? input.requirementIds.includes(item.id)
        : !requirementRejection(item) && !supersedingConflict(item.id, snapshot.conflicts),
    );
    if (
      !requirements.length ||
      input.requirementIds?.some((id) => !requirements.some((requirement) => requirement.id === id))
    )
      throw new ContractError("INVALID_ARGUMENT", "Select known approved requirements");
    for (const requirement of requirements) this.requireApproved(requirement, snapshot.conflicts);
    const catalog = new EvidenceCatalog(
      requirements.flatMap((item) => item.sourceRefs) as SourceEvidenceRef[],
    );
    const type = input.type ?? "backend";
    const allowed = type === "auto" ? (["backend", "frontend"] as const) : [type];
    const typeInstruction =
      type === "auto"
        ? 'Choose each plan\'s type from the requirement: "backend" with runner "http" when it is observable through HTTP API status, headers or JSON; "frontend" with runner "playwright" when it is observable only in the browser UI. Where a user visiting a web page ends up (a redirect to a login page, a return_to parameter) is a browser outcome: single-page applications redirect in the browser after a 200 HTML answer, so assert the final URL in a frontend plan, and assert an HTTP 3xx status and Location header only when a source states the server answers that way.'
        : `Every plan must have type "${type}" and runner "${planRunners[type]}".${type === "integration" ? ' Build an HTTP workflow with at least two request steps: capture a value from an earlier response and use its "stepId.captureName" variableRef in a later request pathSegments, query, headers or body. Include a required deterministic business assertion referencing that later request through responseStepId. A single request, unused capture, or assertion only over the initial response is not an integration workflow.' : ""}`;
    const secrets = this.offeredSecrets();
    const authProfiles = this.offeredAuthProfiles(input.projectId);
    const declineInstruction =
      'A requirement that is not observable through HTTP responses or the browser for this request (for example a command-line program: its exit status, stdout, stderr or a terminal UI) must NOT get an invented endpoint, page or assertion. List it instead in "unsupported" as {"requirementId": <exact requirement id>, "reason": <one short sentence>} and give it no proposal. Every supplied requirement appears exactly once, either as a proposal or in "unsupported"; "proposals" may be empty when every requirement is declined. Always answer with the JSON shape {"proposals": [...], "unsupported": [...]}; never return an "error" property or any other shape.';
    const requirementIds = requirements.map((item) => item.id);
    const offeredSecrets = new Set(secrets.map((secret) => secret.secretRef));
    const unrunnable = (
      plan: ExecutablePlan,
    ): Pick<GenerationRefusal, "reasonCode" | "message" | "pointers"> | undefined => {
      if (
        !authProfiles.length &&
        flattenSteps(plan.steps).some((step) => step.operation === "request" && step.input.auth)
      )
        return {
          reasonCode: "auth_profile_not_offered",
          message:
            'Generated proposal sets auth "profile" but the project has no auth profile (none was offered); remove the auth field or send a supplied secret as a header',
        };
      if (secretRefsOf(plan).some((ref) => !offeredSecrets.has(ref)))
        return {
          reasonCode: "secret_not_offered",
          message: "Generated proposal references a secret that was not offered",
        };
      const pointers = unresolvedSchemaPointers(this.ctx, plan);
      if (pointers.length)
        return {
          reasonCode: "schema_pointer_unresolved",
          message:
            "Generated jsonSchema assertion does not reach a schema in the cited source revision",
          pointers,
        };
      // Any HTTP 200 passes for an unrelated page (e.g. an HTML portal behind a mistyped path),
      // so a success status only counts together with an assertion over the body or headers.
      if (
        plan.runner === "http" &&
        !plan.steps.some(
          (step) =>
            step.kind === "assertion" &&
            step.required !== false &&
            !(step.expectation.predicate === "statusIn" && step.expectation.values.includes(200)),
        )
      )
        return {
          reasonCode: "http_status_only",
          message:
            "A generated HTTP proposal needs a body, schema or header assertion beyond a 200 status check",
        };
      if (
        !(allowed as readonly string[]).includes(plan.type) ||
        plan.runner !== planRunners[plan.type as keyof typeof planRunners]
      )
        return {
          reasonCode: "plan_type_mismatch",
          message:
            type === "auto"
              ? "Generated proposals must be backend/http or frontend/playwright plans"
              : `Generated proposals must be ${type} plans using the ${planRunners[type]} runner`,
        };
      if (type === "integration") {
        try {
          validateIntegrationPlan(plan);
        } catch (error) {
          if (error instanceof ContractError)
            return { reasonCode: "integration_workflow_invalid", message: error.message };
          throw error;
        }
      }
      return undefined;
    };
    // Output-wide defects throw; each proposal that fails on its own is collected, all of them.
    const inspect = (raw: unknown): GenerationInspection => {
      const inspected = inspectGeneratedProposals(raw, requirementIds, catalog);
      const refused: GenerationRefusal[] = inspected.refused.map((item) => ({
        index: item.index,
        requirementIds: item.requirementIds,
        reasonCode: item.reasonCode,
        message: item.error.message,
        ...(item.pointers?.length ? { pointers: item.pointers } : {}),
      }));
      const valid: { index: number; proposal: GeneratedProposal }[] = [];
      for (const { index, proposal } of inspected.accepted) {
        const plan = applyServerBasePath(
          this.ctx,
          proposal.plan,
          proposal.evidenceRefs.map((ref) => ref.sourceRevisionId),
        );
        const reason = unrunnable(plan);
        if (reason) refused.push({ index, requirementIds: proposal.requirementRefs, ...reason });
        else valid.push({ index, proposal: { ...proposal, plan } });
      }
      refused.sort((a, b) => a.index - b.index);
      return {
        valid: valid.map((item) => item.proposal),
        refused,
        unsupported: inspected.unsupported,
      };
    };
    // The gateway runs this inside its repair loop, so the model sees every refusal as feedback.
    let latestRaw: unknown;
    const check = (raw: unknown): void => {
      latestRaw = raw;
      const state = inspect(raw);
      if (state.refused.length) throw refusalError(state.refused);
      const gap = coverageGap(state, requirementIds);
      if (gap) throw gap;
    };
    // Only an explicit `partialGeneration` keeps the last attempt's valid proposals after the
    // repairs ran out; the gateway reports the check's own error and the invalid call's id.
    const recoverPartial = (error: unknown): { modelCallId: string; output: unknown } => {
      const modelCallId =
        error instanceof ContractError && error.details.atomicity === "all_or_nothing"
          ? error.details.modelCallId
          : undefined;
      if (!input.partialGeneration || typeof modelCallId !== "string" || latestRaw === undefined)
        throw error;
      return { modelCallId, output: latestRaw };
    };
    const output = await this.model
      .complete<unknown>({
        projectId: input.projectId,
        purpose: "plan",
        responseSchema: "AIProposalsOutput",
        data: {
          // Locators (paths, JSON pointers) stay visible; outputs cite only the opaque handles.
          requirements: requirements.map(({ sourceRefs, ...requirement }) => ({
            ...requirement,
            evidence: (sourceRefs as SourceEvidenceRef[]).map((ref) => ({
              evidenceId: catalog.handle(ref),
              ...ref,
            })),
          })),
          type,
          sourceSnapshotId: snapshot.fingerprint,
          // Names and ids only: values never leave the vault.
          ...(secrets.length ? { secrets } : {}),
          // Names and kinds only: each environment binds one of them, and the runner applies its session.
          ...(authProfiles.length ? { authProfiles } : {}),
        },
        instructions: `Return exactly one independent executable proposal per supplied requirement that an HTTP or browser plan can observe, not an intent. ${declineInstruction} ${typeInstruction} Copy requirement IDs exactly and cite only the evidenceId values supplied with that requirement. Use deterministic business assertions deriving expected values only from approved requirements. Include an assertion that would fail if the required feature were broken; body/html visibility and broad all-status checks are trivial and rejected, and an HTTP 200 status check alone is trivial too: add a body, schema or header assertion. HTTP paths are relative pathSegments of literal values, written as the source document's paths (a declared server path prefix such as /v1 is added to the request automatically). A jsonSchema assertion's pointer must be a non-empty JSON pointer into the cited source document that reaches the response schema: either inside the operation, for example /paths/~1items/get/responses/200/content/application~1json/schema, or a document-level schema such as /components/schemas/Item; an empty pointer is rejected. When a secrets entry fits the target API, send its credential as a header whose value is {"secretRef": <entry id>} (for example authorization) on every request unless the source explicitly declares the operation public (security: []): specifications often omit security, and a request without a needed credential only proves the 401. Use only secretRef ids from the supplied secrets and never invent secret values. Secrets entries are valid credentials: a negative case (wrong password, unknown user, invalid or missing token) sends literal values that are visibly fake, such as "not-a-real-password", and never a secrets entry, so a refusal proves the check and no real credential is spent on it. ${AUTH_PROFILE_INSTRUCTION} ${JSON_BODY_SET_INSTRUCTION} Frontend locators use testId/role/label. ${BROWSER_POSTCONDITION_INSTRUCTION} Do not invent absolute destinations or secret values.`,
        sourceRevisionIds: [...new Set(catalog.refs.map((ref) => ref.sourceRevisionId))],
        dataClasses: ["requirements"],
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        check,
        // A partial generation keeps the valid proposals of an output whose other proposals break
        // the schema or the plan semantics, so each proposal is validated by `check` on its own.
        ...(input.partialGeneration ? { callerValidatesSchema: true } : {}),
      })
      .catch(recoverPartial);
    const generated = inspect(output.output);
    if (generated.refused.length && !generated.valid.length)
      throw refusalError(generated.refused, { modelCallId: output.modelCallId });
    const gap = coverageGap(generated, requirementIds);
    if (gap) throw gap;
    if (!generated.valid.length)
      throw new ContractError(
        "CAPABILITY_UNAVAILABLE",
        "None of the selected requirements can be observed through HTTP or the browser, so no plan was generated. Terminal (CLI/TUI) tests cannot be generated by the model: write them by hand (docs/usage/terminal-tests.md)",
        {
          capability: "plan-generation",
          reasonCode: "requirement_not_observable",
          unsupported: generated.unsupported,
          modelCallId: output.modelCallId,
          hint: "Author terminal plans manually; see docs/usage/terminal-tests.md",
        },
      );
    const commit = () => {
      if (this.requirements.snapshot(input.projectId).fingerprint !== snapshot.fingerprint)
        throw new ContractError("REVISION_CONFLICT", "Requirements changed during generation", {
          diff: { before: snapshot, current: this.requirements.snapshot(input.projectId) },
        });
      const batch = entity(this.ctx, "pbt", {
        projectId: input.projectId,
        sourceSnapshotId: snapshot.fingerprint,
        state: "proposed",
        extensions: {
          "testmaster:requirementVersion": snapshot.version,
          "testmaster:requirementHashes": requirementContentHashes(snapshot.requirements),
          "testmaster:modelCallId": output.modelCallId,
          ...(generated.unsupported.length
            ? { "testmaster:unsupportedRequirements": generated.unsupported }
            : {}),
          ...(generated.refused.length
            ? {
                "testmaster:refusedProposals": generated.refused.map(
                  ({ index: _index, ...refusal }) => refusal,
                ),
              }
            : {}),
        },
      }) as StoredBatch;
      this.ctx.entities.insert("ProposalBatch", batch);
      for (const item of generated.valid) {
        const proposal = entity(this.ctx, "pro", {
          batchId: batch.id,
          ...item,
          state: "proposed",
          validation: "valid",
          extensions: { "testmaster:authorship": { kind: "llm", modelCallId: output.modelCallId } },
        }) as StoredProposal;
        this.ctx.entities.insert("Proposal", proposal);
      }
      this.audit("proposals.generated", batch.id, null, batch);
      return batch;
    };
    if (input.idempotencyKey) {
      const { signal: _signal, idempotencyKey: _key, ...body } = input;
      return new IdempotencyRepository(this.ctx.database).execute(
        {
          workspaceId: this.ctx.workspaceId,
          actorScope: `${this.ctx.principalId}:${input.projectId}`,
          operation: "proposal.generate",
          key: input.idempotencyKey,
          body,
        },
        commit,
      ).receipt;
    }
    return authoringTransaction(this.ctx, commit);
  }
  private requireApproved(requirement: Requirement, conflicts: readonly ConflictDecision[]): void {
    // Rejected and superseded requirements are refused first: approving them cannot help.
    refuseRejected(requirement, "planned");
    refuseConflicted(requirement.id, conflicts, "planned");
    if (!requirement.approval)
      throw new ContractError("PRECONDITION_FAILED", "Requirements need explicit approval", {
        requirementId: requirement.id,
      });
    const approval = requireEntity(this.ctx, "Approval", requirement.approval);
    if (approval.revokedAt || Date.parse(String(approval.expiresAt)) <= Date.now())
      throw new ContractError("PRECONDITION_FAILED", "Requirement approval is no longer valid", {
        requirementId: requirement.id,
      });
  }
  /**
   * The requirements a proposal cites that differ from the ones it was generated from: changed, or
   * no longer in the approved snapshot. Empty while the snapshot the batch was made from is
   * current. A batch stored without content hashes has no baseline, so every cited one counts.
   */
  private changedRequirements(
    batch: StoredBatch,
    proposal: StoredProposal,
    snapshot: RequirementSnapshot,
  ): string[] {
    if (snapshot.fingerprint === batch.sourceSnapshotId) return [];
    const baseline = (batch.extensions as Record<string, unknown> | undefined)?.[
      "testmaster:requirementHashes"
    ] as Record<string, string> | undefined;
    const current = new Map(snapshot.requirements.map((item) => [item.id, item]));
    const cited = new Set([
      ...proposal.requirementRefs,
      ...(proposal.plan.kind === "executable" ? proposal.plan.requirementRefs : []),
    ]);
    return [...cited].filter((requirementId) => {
      const item = current.get(requirementId);
      return !item || baseline?.[requirementId] !== requirementContentHash(item);
    });
  }
  /** Refuses accepting proposals whose cited requirements changed; the rest of the batch is unaffected. */
  private requireFreshRequirements(batch: StoredBatch, selected: readonly StoredProposal[]): void {
    const snapshot = this.requirements.snapshot(batch.projectId);
    const stale = selected.flatMap((proposal) => {
      const requirementIds = this.changedRequirements(batch, proposal, snapshot);
      return requirementIds.length ? [{ proposalId: proposal.id, requirementIds }] : [];
    });
    if (!stale.length) return;
    throw new ContractError(
      "PRECONDITION_FAILED",
      `Proposal source requirements are stale: ${stale.length} of the selected proposals cite requirements that changed after generation`,
      {
        reasonCode: "proposal_requirements_stale",
        staleProposals: stale,
        changedRequirementIds: [...new Set(stale.flatMap((item) => item.requirementIds))],
        nextAction:
          "Reject the stale proposals and generate them again from the current requirements (generate_plan with requirementIds), or accept the other proposals of the batch without them",
      },
    );
  }
  list(projectId: string): StoredBatch[] {
    this.ctx.authorize("R", projectId);
    return (allEntities(this.ctx, "ProposalBatch") as StoredBatch[]).filter(
      (item) => item.projectId === projectId,
    );
  }
  get(id: string): StoredBatch {
    const batch = requireEntity(this.ctx, "ProposalBatch", id) as StoredBatch;
    this.ctx.authorize("R", batch.projectId);
    return batch;
  }
  detail(id: string): { batch: StoredBatch; proposals: StoredProposal[] } {
    const batch = this.get(id);
    return {
      batch,
      proposals: (allEntities(this.ctx, "Proposal") as StoredProposal[]).filter(
        (item) => item.batchId === id,
      ),
    };
  }
  edit(id: string, plan: ExecutablePlan, expectedVersion: number): StoredProposal {
    validateProposalPlan(plan);
    return authoringTransaction(this.ctx, () => {
      const current = requireEntity(this.ctx, "Proposal", id) as StoredProposal;
      const batch = this.get(current.batchId);
      this.ctx.authorize("W", batch.projectId);
      if (current.version !== expectedVersion)
        throw new ContractError("REVISION_CONFLICT", "Proposal changed", {
          diff: {
            expectedVersion,
            currentVersion: current.version,
            submitted: plan,
            current: current.plan,
          },
        });
      if (current.state !== "proposed")
        throw new ContractError("PRECONDITION_FAILED", "Only retained proposals may be edited");
      const evidenceRefs = current.evidenceRefs as SourceEvidenceRef[];
      validateGeneratedProposals(
        {
          proposals: [
            {
              plan,
              requirementRefs: current.requirementRefs,
              evidenceRefs,
              warnings: [],
            },
          ],
        },
        current.requirementRefs,
        evidenceRefs,
      );
      const edits =
        ((current.extensions as Record<string, unknown> | undefined)?.["testmaster:edits"] as
          | unknown[]
          | undefined) ?? [];
      const next = {
        ...current,
        plan,
        // The model's warnings describe the plan it wrote, not this one; the audit event keeps them.
        warnings: [],
        version: expectedVersion + 1,
        extensions: {
          ...current.extensions,
          "testmaster:edits": [
            ...edits,
            {
              principalId: this.ctx.principalId,
              at: new Date().toISOString(),
              fromVersion: expectedVersion,
            },
          ],
        },
      } as StoredProposal;
      this.ctx.entities.update("Proposal", this.ctx.workspaceId, id, expectedVersion, next);
      this.ctx.entities.update(
        "ProposalBatch",
        this.ctx.workspaceId,
        batch.id,
        batch.version ?? 1,
        { ...batch, version: (batch.version ?? 1) + 1 },
      );
      this.audit("proposal.edited", id, current, next);
      return next;
    });
  }
  accept(
    id: string,
    input: {
      proposalIds: string[];
      expectedVersion: number;
      idempotencyKey: string;
      acknowledgedDuplicates?: string[];
      reason?: string;
    },
  ): ProposalReceipt {
    return this.review(id, {
      acceptIds: input.proposalIds,
      rejectIds: [],
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      ...(input.acknowledgedDuplicates
        ? { acknowledgedDuplicates: input.acknowledgedDuplicates }
        : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    });
  }
  reject(
    id: string,
    input: { proposalIds: string[]; expectedVersion: number; idempotencyKey?: string },
  ): ProposalReceipt {
    return this.review(id, {
      acceptIds: [],
      rejectIds: input.proposalIds,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
    });
  }
  review(
    id: string,
    input: {
      acceptIds: string[];
      rejectIds: string[];
      expectedVersion: number;
      idempotencyKey: string;
      acknowledgedDuplicates?: string[];
      reason?: string;
    },
  ): ProposalReceipt {
    const batch = this.get(id);
    this.ctx.authorize("W", batch.projectId);
    if (!input.acceptIds.length && !input.rejectIds.length)
      throw new ContractError("INVALID_ARGUMENT", "A nonempty proposal subset is required");
    if (
      new Set([...input.acceptIds, ...input.rejectIds]).size !==
      input.acceptIds.length + input.rejectIds.length
    )
      throw new ContractError("INVALID_ARGUMENT", "Duplicate or overlapping proposal IDs");
    return new IdempotencyRepository(this.ctx.database).execute(
      {
        workspaceId: this.ctx.workspaceId,
        actorScope: `${this.ctx.principalId}:${batch.projectId}`,
        operation: `proposal.review:${id}`,
        key: input.idempotencyKey,
        body: input,
      },
      () => {
        const { batch: current, proposals } = this.detail(id);
        if (current.state === "stale")
          throw new ContractError(
            "PRECONDITION_FAILED",
            "Source inputs changed; regenerate proposals",
          );
        if (current.version !== input.expectedVersion)
          throw new ContractError("REVISION_CONFLICT", "Proposal batch changed", {
            diff: {
              expectedVersion: input.expectedVersion,
              currentVersion: current.version,
              proposals,
            },
          });
        if (
          [...input.acceptIds, ...input.rejectIds].some(
            (proposalId) =>
              !proposals.some(
                (proposal) => proposal.id === proposalId && proposal.state === "proposed",
              ),
          )
        )
          throw new ContractError("INVALID_ARGUMENT", "Unknown or already decided proposal");
        if (input.acceptIds.length) {
          this.requireFreshRequirements(
            current,
            proposals.filter((proposal) => input.acceptIds.includes(proposal.id)),
          );
          this.requireDuplicateDecisions(
            current,
            proposals,
            input.acceptIds,
            input.acknowledgedDuplicates ?? [],
          );
        }
        const accepted: string[] = [];
        const rejected: string[] = [];
        for (const proposal of proposals) {
          if (input.acceptIds.includes(proposal.id)) {
            if (proposal.validation !== "valid" || proposal.plan.kind !== "executable")
              throw new ContractError("INVALID_ARGUMENT", "Invalid proposal cannot enter a suite");
            validateProposalPlan(proposal.plan);
            const snapshot = this.requirements.snapshot(current.projectId);
            for (const requirementId of proposal.requirementRefs)
              this.requireApproved(this.requirements.get(requirementId), snapshot.conflicts);
            const refined = this.refinedTest(current);
            let test: TestCase & EntityDocument;
            let ordinal = 1;
            if (refined) {
              // A refinement of an existing test adds a candidate revision; the active revision never moves here.
              test = requireEntity(this.ctx, "TestCase", refined.testId) as TestCase &
                EntityDocument;
              if (test.archivedAt)
                throw new ContractError(
                  "PRECONDITION_FAILED",
                  "Archived resource cannot be modified",
                );
              ordinal = Number(
                this.ctx.database.get(
                  "SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM test_revisions WHERE workspace_id=? AND test_id=?",
                  this.ctx.workspaceId,
                  test.id,
                )?.ordinal,
              );
            } else {
              test = entity(this.ctx, "tst", {
                projectId: current.projectId,
                name: proposal.plan.name,
                activeRevisionId: null,
                tags: proposal.plan.tags ?? [],
                priority: proposal.plan.priority ?? "normal",
                archivedAt: null,
              }) as TestCase & EntityDocument;
              this.ctx.entities.insert("TestCase", test);
            }
            const revision = entity(this.ctx, "rev", {
              testId: test.id,
              ordinal,
              contentHash: semanticHash(proposal.plan, "plan"),
              plan: proposal.plan,
              codeArtifactId: null,
              runnerKind: proposal.plan.runner,
              author: this.ctx.principalId,
              parentId: refined?.baseRevisionId ?? null,
              origin: "generated",
              extensions: {
                "testmaster:proposalId": proposal.id,
                "testmaster:batchId": id,
                "testmaster:authorship": this.authorshipOf(current, proposal),
                "testmaster:acceptance": {
                  principalId: this.ctx.principalId,
                  credentialKind: this.ctx.actor.credentialKind ?? "local",
                  at: new Date().toISOString(),
                  batchVersion: current.version,
                },
                ...(input.reason ? { "testmaster:justification": input.reason } : {}),
              },
            }) as TestRevision & EntityDocument;
            this.ctx.entities.insert("TestRevision", revision);
            if (!refined) {
              this.ctx.entities.update("TestCase", this.ctx.workspaceId, test.id, 1, {
                ...test,
                activeRevisionId: revision.id,
                version: 2,
              });
              auditPromotion(this.ctx, test.id, revision.id, null);
            }
            this.ctx.entities.update(
              "Proposal",
              this.ctx.workspaceId,
              proposal.id,
              proposal.version ?? 1,
              {
                ...proposal,
                state: "accepted",
                extensions: {
                  ...proposal.extensions,
                  "testmaster:candidateRevisionId": revision.id,
                  "testmaster:testId": test.id,
                },
              },
            );
            if (input.acknowledgedDuplicates?.includes(proposal.id))
              this.audit("proposal.duplicate_acknowledged", proposal.id, null, {
                revisionId: revision.id,
              });
            accepted.push(test.id);
          } else if (input.rejectIds.includes(proposal.id)) {
            this.ctx.entities.update(
              "Proposal",
              this.ctx.workspaceId,
              proposal.id,
              proposal.version ?? 1,
              { ...proposal, state: "rejected" },
            );
            rejected.push(proposal.id);
          }
        }
        const retained = proposals
          .filter(
            (proposal) =>
              proposal.state === "proposed" &&
              !input.acceptIds.includes(proposal.id) &&
              !input.rejectIds.includes(proposal.id),
          )
          .map((proposal) => proposal.id);
        this.ctx.entities.update("ProposalBatch", this.ctx.workspaceId, id, current.version, {
          ...current,
          state: retained.length
            ? "proposed"
            : accepted.length || proposals.some((proposal) => proposal.state === "accepted")
              ? "accepted"
              : "rejected",
          version: current.version + 1,
        });
        const receipt = { accepted, retained, rejected };
        this.audit("proposals.reviewed", id, current, receipt);
        return receipt;
      },
    ).receipt;
  }
  private refinedTest(batch: StoredBatch): { testId: string; baseRevisionId: string } | null {
    const value = (batch.extensions as Record<string, unknown> | undefined)?.[
      "testmaster:refinesTest"
    ] as { testId: string; baseRevisionId: string } | undefined;
    return value ?? null;
  }
  private authorshipOf(
    batch: StoredBatch,
    proposal: StoredProposal,
  ): {
    generatedBy: string | null;
    humanEdits: { principalId: string; at: string; fromVersion: number }[];
    refinedFrom: string | null;
  } {
    const extensions = proposal.extensions as Record<string, unknown> | undefined;
    const llm = extensions?.["testmaster:authorship"] as { modelCallId?: string } | undefined;
    const batchCall = (batch.extensions as Record<string, unknown> | undefined)?.[
      "testmaster:modelCallId"
    ];
    const refines = extensions?.["testmaster:refines"];
    return {
      generatedBy: llm?.modelCallId ?? (typeof batchCall === "string" ? batchCall : null),
      humanEdits:
        (extensions?.["testmaster:edits"] as
          | { principalId: string; at: string; fromVersion: number }[]
          | undefined) ?? [],
      refinedFrom: typeof refines === "string" ? refines : null,
    };
  }
  /** Existing tests and other selected proposals that look like this proposal (UX-017). */
  private similarities(
    batch: StoredBatch,
    proposal: StoredProposal,
    siblings: readonly StoredProposal[],
    selectedIds: readonly string[],
  ): ProposalPreview["items"][number]["similar"] {
    if (proposal.plan.kind !== "executable") return [];
    const own = {
      plan: proposal.plan,
      requirements: [...new Set([...proposal.requirementRefs, ...proposal.plan.requirementRefs])],
    };
    const found: ProposalPreview["items"][number]["similar"] = [];
    const refined = this.refinedTest(batch)?.testId;
    for (const test of allEntities(this.ctx, "TestCase") as (TestCase & EntityDocument)[]) {
      if (test.projectId !== batch.projectId || test.archivedAt || !test.activeRevisionId) continue;
      if (test.id === refined) continue;
      const plan = this.ctx.entities.get(
        "TestRevision",
        this.ctx.workspaceId,
        test.activeRevisionId,
      )?.plan as ExecutablePlan | null | undefined;
      if (!plan) continue;
      const result = planSimilarity(own, { plan, requirements: plan.requirementRefs });
      if (result.score >= 0.5)
        found.push({ kind: "test", id: test.id, name: test.name, ...result });
    }
    for (const sibling of siblings) {
      if (sibling.id === proposal.id || sibling.state !== "proposed") continue;
      if (sibling.plan.kind !== "executable") continue;
      const result = planSimilarity(own, {
        plan: sibling.plan,
        requirements: [...new Set([...sibling.requirementRefs, ...sibling.plan.requirementRefs])],
      });
      if (result.score >= 0.5)
        found.push({
          kind: "proposal",
          id: sibling.id,
          name: sibling.plan.name,
          score: result.score,
          // Only another proposal accepted in the same operation would create the duplicate.
          exactDuplicate: result.exactDuplicate && selectedIds.includes(sibling.id),
        });
    }
    return found.sort((a, b) => b.score - a.score).slice(0, 20);
  }
  private requireDuplicateDecisions(
    batch: StoredBatch,
    proposals: readonly StoredProposal[],
    acceptIds: readonly string[],
    acknowledged: readonly string[],
  ): void {
    if (acknowledged.some((id) => !acceptIds.includes(id)))
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Acknowledged duplicate is not part of the selection",
      );
    const unresolved = acceptIds.flatMap((proposalId) => {
      const proposal = proposals.find((item) => item.id === proposalId);
      if (!proposal || acknowledged.includes(proposalId)) return [];
      const exact = this.similarities(batch, proposal, proposals, acceptIds).filter(
        (item) => item.exactDuplicate,
      );
      return exact.length ? [{ proposalId, duplicates: exact }] : [];
    });
    if (unresolved.length)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Selected proposals duplicate existing content; accepting them needs an explicit decision",
        { reason: "duplicate_decision_required", duplicates: unresolved },
      );
  }
  /** Batches of a project with their decision counts and staleness, newest first (UX-018). */
  summaries(projectId: string): ProposalBatchSummary[] {
    const batches = this.list(projectId);
    const proposals = allEntities(this.ctx, "Proposal") as StoredProposal[];
    return batches.map((batch) => {
      const own = proposals.filter((proposal) => proposal.batchId === batch.id);
      const extensions = (batch.extensions as Record<string, unknown> | undefined) ?? {};
      const refined = this.refinedTest(batch);
      const reason = extensions["testmaster:invalidatedBy"];
      const call = extensions["testmaster:modelCallId"];
      return {
        id: batch.id,
        createdAt: String(batch.createdAt),
        projectId: batch.projectId,
        state: batch.state,
        version: batch.version ?? 1,
        origin: refined ? "refinement" : "generated",
        refinesTestId: refined?.testId ?? null,
        stale: batch.state === "stale",
        staleReason: typeof reason === "string" ? reason : null,
        counts: {
          proposed: own.filter((proposal) => proposal.state === "proposed").length,
          accepted: own.filter((proposal) => proposal.state === "accepted").length,
          rejected: own.filter((proposal) => proposal.state === "rejected").length,
        },
        modelCallId: typeof call === "string" ? call : null,
      };
    });
  }
  /**
   * What accepting a selection would create, with structural and semantic validation, similarity and
   * who wrote what. It reads only persisted state, so an unavailable model never blocks acceptance (UX-015).
   */
  preview(id: string, proposalIds: readonly string[]): ProposalPreview {
    const { batch, proposals } = this.detail(id);
    const selected = proposalIds.map((proposalId) => {
      const found = proposals.find((proposal) => proposal.id === proposalId);
      if (!found)
        throw new ContractError("INVALID_ARGUMENT", "Proposal does not belong to this batch", {
          proposalId,
        });
      return found;
    });
    const extensions = (batch.extensions as Record<string, unknown> | undefined) ?? {};
    const reason = extensions["testmaster:invalidatedBy"];
    const stale = batch.state === "stale";
    const snapshot = this.requirements.snapshot(batch.projectId);
    const refined = this.refinedTest(batch);
    const nextOrdinal = refined
      ? Number(
          this.ctx.database.get(
            "SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM test_revisions WHERE workspace_id=? AND test_id=?",
            this.ctx.workspaceId,
            refined.testId,
          )?.ordinal,
        )
      : 1;
    let created = 0;
    const items = selected.map((proposal): ProposalPreview["items"][number] => {
      const structural: PlanIssue[] = [];
      const semantic: PlanIssue[] = [];
      const failure = (code: string, error: unknown, into: PlanIssue[]): void => {
        if (!(error instanceof ContractError)) throw error;
        const list = error.issues.length
          ? error.issues
          : [{ path: "", rule: "", message: error.message }];
        for (const item of list)
          into.push({
            severity: "error",
            code: item.rule ? `${code}_${item.rule}` : code,
            field: item.path,
            stepId: stepIdAt(proposal.plan, item.path),
            message: item.message,
          });
      };
      let plan: ExecutablePlan | null = null;
      if (proposal.plan.kind !== "executable")
        structural.push({
          severity: "error",
          code: "intent_plan_not_executable",
          field: "/kind",
          stepId: null,
          message: "Only an executable plan can become a test; edit the proposal first.",
        });
      else
        try {
          plan = validate<ExecutablePlan>("ExecutablePlan", proposal.plan);
        } catch (error) {
          failure("schema", error, structural);
        }
      if (plan)
        try {
          validateProposalPlan(plan);
        } catch (error) {
          failure("assertion", error, semantic);
        }
      if (proposal.validation !== "valid")
        semantic.push({
          severity: "error",
          code: "proposal_invalid",
          field: "",
          stepId: null,
          message: "The proposal did not pass validation when it was stored.",
        });
      if (proposal.state !== "proposed")
        semantic.push({
          severity: "error",
          code: "already_decided",
          field: "",
          stepId: null,
          message: `The proposal was already ${proposal.state}.`,
        });
      if (stale)
        semantic.push({
          severity: "error",
          code: "source_stale",
          field: "",
          stepId: null,
          message: "Source inputs changed after generation; regenerate or review the sources.",
        });
      for (const requirementId of proposal.requirementRefs)
        try {
          this.requireApproved(this.requirements.get(requirementId), snapshot.conflicts);
        } catch (error) {
          failure("requirement", error, semantic);
        }
      const changed = stale ? [] : this.changedRequirements(batch, proposal, snapshot);
      if (changed.length)
        semantic.push({
          severity: "error",
          code: "requirements_changed",
          field: "",
          stepId: null,
          message: `The requirements this proposal cites changed after generation: ${changed.join(", ")}.`,
        });
      const selectable = !structural.length && !semantic.length;
      const similar = this.similarities(batch, proposal, proposals, proposalIds);
      const steps = plan ? flattenSteps(plan.steps) : [];
      return {
        proposalId: proposal.id,
        state: proposal.state,
        selectable,
        validation: {
          structural: structural.length ? "invalid" : "valid",
          semantic: semantic.length ? "invalid" : "valid",
          issues: [...structural, ...semantic],
        },
        revision: plan
          ? {
              action: refined ? "create_revision" : "create_test",
              testId: refined?.testId ?? null,
              testName: plan.name,
              ordinal: refined ? nextOrdinal + created++ : 1,
              parentRevisionId: refined?.baseRevisionId ?? null,
              origin: "generated",
              runner: plan.runner,
              type: plan.type,
              contentHash: semanticHash(plan, "plan"),
              stepCount: steps.length,
              assertionCount: steps.filter((step) => step.kind === "assertion").length,
              estimate: estimateDuration(plan),
            }
          : null,
        authorship: this.authorshipOf(batch, proposal),
        similar,
        needsDecision: similar.some((item) => item.exactDuplicate),
      };
    });
    let permitted = true;
    try {
      this.ctx.authorize("W", batch.projectId);
    } catch (error) {
      if (!(error instanceof ContractError) || error.code !== "FORBIDDEN") throw error;
      permitted = false;
    }
    return {
      batchId: batch.id,
      batchVersion: batch.version ?? 1,
      batchState: batch.state,
      stale,
      staleReason: typeof reason === "string" ? reason : null,
      policy: {
        canAccept: permitted,
        reason: permitted ? null : "write_permission_required",
        text: "Accepting a generated proposal makes it an active test. It is an explicit decision by any caller with write permission, human or agent, recorded with the acting principal.",
      },
      items,
      blocked: items.some((item) => !item.selectable),
    };
  }
  private audit(action: string, resourceId: string, before: unknown, after: unknown): void {
    new AuditRepository(this.ctx.database).append({
      workspaceId: this.ctx.workspaceId,
      actor: this.ctx.principalId,
      action,
      resourceId,
      requestId: crypto.randomUUID(),
      beforeHash: before ? semanticHash(before) : null,
      afterHash: semanticHash(after),
      timestamp: new Date().toISOString(),
    });
  }
}
