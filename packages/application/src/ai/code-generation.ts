import { ContractError, type ExecutablePlan, type StepResult } from "@testmaster/contracts";
import { environmentSecretValues, scrubEvidenceValue } from "@testmaster/domain";
import type { EntityDocument } from "@testmaster/persistence";
import {
  CODE_IMPORT_RULES,
  type CodeImportFormat,
  type ImportedCodeBundle,
} from "@testmaster/planner";
import type { ResolvedConfig } from "../config.js";
import { allEntities, requireEntity, type ServiceContext } from "../context.js";
import { governingPlan } from "../revision-plan.js";
import { CodeImportService, type CodeSecretBinding } from "./code-import.js";
import { ModelService } from "./model.js";
import {
  type SchemaCitation,
  schemaCitations,
  sourceSchemasFor,
  unusableSchemas,
  unusableSchemaText,
} from "./source-documents.js";

/** What the model must obey; the importer enforces the same constants (planner `CODE_IMPORT_RULES`). */
const generationInstructions = `Return standalone Playwright test code importing only @playwright/test. Preserve every deterministic plan assertion and action. Use page.goto relative URLs and runner-configured baseURL. No shell, dependency installs, eval, filesystem or empty assertions. Do not use TestMaster APIs. A plan value {"secretRef": <id>} is a credential: read it with secrets.get(NAME), where NAME is the entry of the data "secrets" list (name, id, allowedOrigins; never values) whose id matches. A plan request step with "auth": "profile" is sent with the environment's logged-in auth profile session: send it with the profileRequest fixture (destructure it in the test callback, async ({ profileRequest }) => { ... }), an APIRequestContext with the session applied, and use the profilePage fixture the same way for a browser flow that needs that session. The plain request and page fixtures are never authenticated: use them for steps without "auth" (for example a request that must answer 401), and never copy cookies, tokens or other session values into the code. A profileRequest does not follow redirects when the profile sends a header credential. A plan assertion with predicate "jsonSchema" checks a JSON value of the response against the source schema it cites (sourceRevisionId and pointer): the data "sourceSchemas" list names each cited schema with the plan steps that use it. The schema documents are frozen into the test and cannot be read, so check each one with the sourceSchemas fixture, never with hand-written structural assertions, and never skip it. A plan assertion with predicate "jsonConforms" carries its JSON Schema inline in the plan: check every constraint it states (type, required, const, enum, minimum, maximum, items) with expect assertions on that JSON value. Read text and URLs the way the plan runner does, so the code passes and fails where the plan does. A textEquals or textContains assertion on a locator compares the element's innerText exactly: await expect.poll(() => locator.innerText()).toBe(VALUE) or .toContain(VALUE); never toHaveText or toContainText, which read other text and normalize whitespace (they read an element in <head>, such as title, as empty). On a response (input.responseStepId) they compare the whole body text: expect(await response.text()).toBe(VALUE) or .toContain(VALUE). A response assertion with input.xmlPath reads the XML body through the xml fixture (destructure it in the test callback, async ({ request, xml }) => { ... }): const selected = xml.select(await response.text(), XML_PATH) returns {count, text}, where text is the string value of the first selected node (null when none); assert selected.text for textEquals or textContains and selected.count for countEquals, countAtLeast or countAtMost, never a regular expression or a hand-written XML parser. urlEquals compares the full page URL exactly: await expect(page).toHaveURL(VALUE); urlMatches tests its pattern as an unanchored regular expression with flag u against the full URL: await expect(page).toHaveURL(new RegExp(PATTERN, "u")). The code is machine-checked before it is accepted and any violation is refused, so obey every rule: ${CODE_IMPORT_RULES.join(" ")}`;
/** Ids of the plan's request steps that ask for the environment's auth profile session. */
function profileSteps(plan: unknown, found: string[] = []): string[] {
  if (Array.isArray(plan)) for (const item of plan) profileSteps(item, found);
  else if (plan && typeof plan === "object") {
    const step = plan as { id?: unknown; operation?: unknown; input?: { auth?: unknown } };
    if (step.operation === "request" && step.input?.auth === "profile") found.push(String(step.id));
    for (const child of Object.values(plan)) profileSteps(child, found);
  }
  return found;
}
/** Largest source-schema set frozen into a code bundle; the stored bundle must stay readable (8 MiB cap). */
const SCHEMAS_MAX_BYTES = 4 * 1024 * 1024;
/** Source schemas the code must check, one entry per cited schema with the steps that use it. */
function offeredSchemas(citations: readonly SchemaCitation[]) {
  const offered = new Map<
    string,
    { sourceRevisionId: string; pointer: string; stepIds: string[] }
  >();
  for (const { stepId, sourceRevisionId, pointer } of citations) {
    const entry = offered.get(`${sourceRevisionId}${pointer}`);
    if (entry) entry.stepIds.push(stepId);
    else
      offered.set(`${sourceRevisionId}${pointer}`, {
        sourceRevisionId,
        pointer,
        stepIds: [stepId],
      });
  }
  return [...offered.values()];
}
/** Why code cannot check the plan's cited schemas, found before any model call; undefined when it can. */
function schemaRefusal(
  citations: readonly SchemaCitation[],
  schemas: Record<string, unknown>,
): string | undefined {
  const missing = citations.filter(
    ({ sourceRevisionId, pointer }) => !Object.hasOwn(schemas, `${sourceRevisionId}${pointer}`),
  );
  if (missing.length)
    return `Step ${missing.map((item) => `${JSON.stringify(item.stepId)} cites source schema ${item.sourceRevisionId}#${item.pointer}`).join(", ")}, which its source revision no longer provides: the generated code cannot check it, so no model call was made`;
  const unusable = unusableSchemas(citations, schemas);
  if (unusable.length)
    return `${unusable.map(unusableSchemaText).join("; ")}; fix the schema in a new source revision or cite another pointer. No model call was made`;
  if (Buffer.byteLength(JSON.stringify(schemas)) > SCHEMAS_MAX_BYTES)
    return `The source schemas cited by the plan exceed ${SCHEMAS_MAX_BYTES} bytes and cannot be frozen into the code bundle, so no model call was made`;
  return undefined;
}
// A refused candidate is a per-revision result; any other failure (budget, provider) is not.
const refusalCodes: readonly string[] = ["INVALID_ARGUMENT", "POLICY_DENIED", "PAYLOAD_TOO_LARGE"];
interface GenerationFailure {
  path: string;
  message: string;
}
export interface CodeGenerationInput {
  projectId: string;
  proposalIds?: string[];
  revisionIds?: string[];
  /**
   * A completed, failed Run of a code candidate revision: the model repairs that candidate from
   * the Run's failed steps. Exclusive with `proposalIds` and `revisionIds`.
   */
  runId?: string;
  budget?: {
    modelCalls?: number;
  };
  /** Model provider; absent: the first allowed provider. Validated before any model call. */
  provider?: string;
  /** Model id; absent: the provider's first structured-output model. Validated before any call. */
  model?: string;
}
/** What the model sees of a step that did not pass, scrubbed of secret values. */
interface RepairStep {
  stepId: string;
  title?: string;
  status: string;
  reasonCode?: string;
  error?: string;
  expected: unknown;
  observed: unknown;
}
/** The failed candidate a repair rewrites and the Run that failed it. */
interface RepairSource {
  runId: string;
  outcome: string | null;
  gate: string;
  format: CodeImportFormat;
  files: Record<string, string>;
  steps: RepairStep[];
}
/** One revision to write code for: from its plan, or (with `repair`) from a failed candidate. */
interface GenerationTarget {
  revision: EntityDocument;
  test: EntityDocument;
  /** The plan the code must preserve: the revision's own, or the one a candidate came from. */
  plan: ExecutablePlan | null;
  repair?: RepairSource;
}
/** Steps a repair shows the model; a candidate that failed more than this shows its first ones. */
const REPAIR_STEPS = 20;
const REPAIR_MESSAGE_CHARS = 2000;
const repairInstructions = `Repair mode: data.files is the code of a candidate that failed the Run data.failedRun, whose steps that did not pass are listed with their recorded error, expected and observed values. Return the whole corrected code of the entrypoint in the candidate's format (data.format), checking the same behavior: fix how the code observes the page or response (locators, waits, how a value is read), never weaken, loosen or drop an assertion, and keep every assertion and action of data.plan when it is given. The product may be at fault: when the recorded failure shows the product behaving differently from the plan, keep the assertion as it is.`;
function refuseRepair(message: string, reasonCode: string): never {
  throw new ContractError("PRECONDITION_FAILED", message, { reasonCode });
}
export class CodeGenerationService {
  constructor(
    readonly ctx: ServiceContext,
    readonly config: ResolvedConfig,
  ) {}
  /**
   * Secrets the generated code may read: active, caller-readable secrets whose allowed origins
   * cover every origin of some active environment of the project. Names, ids and origins only.
   */
  private offeredSecrets(projectId: string): (CodeSecretBinding & { allowedOrigins: string[] })[] {
    try {
      this.ctx.authorize("R");
    } catch {
      return [];
    }
    const environments: string[][] = [];
    for (const environment of allEntities(this.ctx, "Environment")) {
      if (environment.projectId !== projectId || environment.archivedAt) continue;
      const revision = this.ctx.entities.get(
        "EnvironmentRevision",
        this.ctx.workspaceId,
        String(environment.activeRevisionId),
      );
      if (revision) environments.push(revision.targetOrigins as string[]);
    }
    return allEntities(this.ctx, "SecretReference")
      .filter((secret) => !secret.revokedAt && !secret.managedBy)
      .filter((secret) => {
        const allowed = secret.allowedOrigins as string[];
        return environments.some((origins) => origins.every((origin) => allowed.includes(origin)));
      })
      .map((secret) => ({
        name: String(secret.locator),
        secretRef: String(secret.id),
        allowedOrigins: secret.allowedOrigins as string[],
      }));
  }
  /**
   * The failed candidate of Run `runId` and what the model needs to repair it. Every refusal
   * comes before any model call.
   */
  private async repairTarget(
    projectId: string,
    runId: string,
    importer: CodeImportService,
  ): Promise<GenerationTarget> {
    const run = requireEntity(this.ctx, "Run", runId);
    const revision = requireEntity(this.ctx, "TestRevision", String(run.revisionId));
    const test = requireEntity(this.ctx, "TestCase", String(run.testId));
    if (test.projectId !== projectId)
      throw new ContractError("NOT_FOUND", "Run does not exist in this project", { runId });
    if (revision.plan)
      refuseRepair(
        `Run ${runId} ran a plan revision, not a code candidate; a plan is repaired with testmaster_propose_healing (locator or wait changes) or a new revision saved with testmaster_save_test. No model call was made`,
        "plan_revision",
      );
    if (!revision.codeRef)
      refuseRepair(`Run ${runId} ran a revision with no code`, "not_code_candidate");
    if (run.phase !== "completed")
      refuseRepair(
        `Run ${runId} is ${String(run.phase)}; wait until it completes. No model call was made`,
        "run_not_completed",
      );
    if (run.outcome !== "failed" && run.gate !== "failed")
      refuseRepair(
        `Run ${runId} ended ${String(run.outcome)} with gate ${String(run.gate)}; only a failed run (outcome or gate failed) is repaired. No model call was made`,
        "run_not_failed",
      );
    const { bundle } = await importer.readBundle(String(revision.id));
    return {
      revision,
      test,
      plan: governingPlan(this.ctx, String(revision.id)),
      repair: {
        runId,
        outcome: run.outcome === null ? null : String(run.outcome),
        gate: String(run.gate),
        format: bundle.format,
        files: bundle.files,
        steps: this.repairSteps(runId),
      },
    };
  }
  /** The steps of the Run's last attempt that did not pass, scrubbed of host secret values. */
  private repairSteps(runId: string): RepairStep[] {
    const secrets = environmentSecretValues();
    return this.ctx.database
      .all(
        "SELECT s.data_json FROM steps s JOIN attempts a ON a.workspace_id=s.workspace_id AND a.id=s.attempt_id WHERE a.workspace_id=? AND a.run_id=? AND a.id=(SELECT id FROM attempts WHERE workspace_id=a.workspace_id AND run_id=a.run_id ORDER BY number DESC LIMIT 1) ORDER BY s.step_index",
        this.ctx.workspaceId,
        runId,
      )
      .map((row) => JSON.parse(String(row.data_json)) as StepResult)
      .filter((step) => step.status !== "passed")
      .slice(0, REPAIR_STEPS)
      .map((step) =>
        scrubEvidenceValue(
          {
            stepId: step.planStepId,
            ...(step.title ? { title: step.title } : {}),
            status: step.status,
            ...(step.reasonCode ? { reasonCode: step.reasonCode } : {}),
            ...(step.error ? { error: step.error.message.slice(0, REPAIR_MESSAGE_CHARS) } : {}),
            expected: step.expected,
            observed: step.observed,
          },
          secrets,
        ),
      );
  }
  /** The revisions named by `revisionIds` and accepted `proposalIds`, in order, without duplicates. */
  private selectedRevisions(input: CodeGenerationInput): string[] {
    const revisions = [...new Set(input.revisionIds ?? [])];
    for (const id of input.proposalIds ?? []) {
      const proposal = requireEntity(this.ctx, "Proposal", id);
      const batch = requireEntity(this.ctx, "ProposalBatch", String(proposal.batchId));
      if (batch.projectId !== input.projectId || proposal.state !== "accepted")
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Code generation requires accepted project proposals",
        );
      const revisionId =
        (proposal.extensions as Record<string, unknown> | undefined)?.[
          "testmaster:candidateRevisionId"
        ] ?? (proposal.extensions as Record<string, unknown> | undefined)?.candidateRevisionId;
      if (typeof revisionId !== "string")
        throw new ContractError("PRECONDITION_FAILED", "Proposal has no accepted revision");
      if (!revisions.includes(revisionId)) revisions.push(revisionId);
    }
    return revisions;
  }
  /** A revision to generate code for from its plan; it must be a plan revision of the project. */
  private planTarget(projectId: string, id: string): GenerationTarget {
    const revision = requireEntity(this.ctx, "TestRevision", id);
    const test = requireEntity(this.ctx, "TestCase", String(revision.testId));
    if (test.projectId !== projectId || !revision.plan)
      throw new ContractError(
        "POLICY_DENIED",
        "Revision is outside the project or has no grounded plan",
      );
    return { revision, test, plan: revision.plan as ExecutablePlan };
  }
  async generate(input: CodeGenerationInput, signal?: AbortSignal) {
    this.ctx.authorize("X", input.projectId);
    this.ctx.authorize("W", input.projectId);
    if (input.runId !== undefined && (input.proposalIds?.length || input.revisionIds?.length))
      throw new ContractError(
        "INVALID_ARGUMENT",
        "runId repairs the candidate of one failed run and cannot be combined with proposalIds or revisionIds",
      );
    const importer = new CodeImportService(this.ctx, this.config);
    const repair =
      input.runId !== undefined
        ? await this.repairTarget(input.projectId, input.runId, importer)
        : undefined;
    const revisions = repair ? [String(repair.revision.id)] : this.selectedRevisions(input);
    const maximum = input.budget?.modelCalls ?? 10;
    if (
      !Number.isInteger(maximum) ||
      maximum < 1 ||
      maximum > 20 ||
      !revisions.length ||
      revisions.length > maximum
    )
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Code generation selection exceeds the model-call budget",
      );
    // An explicit model is refused here, before any revision is read for a paid call.
    const models = new ModelService(this.ctx, this.config);
    const choice = models.select(
      {
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
      },
      "Code generation",
    );
    const offered = this.offeredSecrets(input.projectId);
    const candidates: EntityDocument[] = [];
    const validationErrors: GenerationFailure[] = [];
    const modelCallIds: string[] = [];
    try {
      for (const id of revisions) {
        const target = repair ?? this.planTarget(input.projectId, id);
        const { revision, test, plan } = target;
        // The code checks the schemas the plan cites through the sourceSchemas fixture, so they are
        // resolved now, exactly as the plan's runner input resolves them, and frozen into the bundle.
        const citations = plan ? schemaCitations(plan) : [];
        const schemas = plan && citations.length ? sourceSchemasFor(this.ctx, plan) : {};
        const refusal = schemaRefusal(citations, schemas);
        if (refusal) {
          validationErrors.push({ path: id, message: refusal });
          continue;
        }
        // The importer is the response check: its refusal is repair feedback to the model, and the
        // bundle it accepted is the one stored, so the code is not imported twice.
        const accepted: { bundle?: ImportedCodeBundle } = {};
        try {
          const result = await models.complete<{
            code: string;
            format: "playwright" | "pytest";
          }>({
            projectId: input.projectId,
            purpose: "generate_code",
            responseSchema: "AIGeneratedCodeOutput",
            data: {
              ...(plan ? { plan } : {}),
              format: target.repair?.format ?? "playwright",
              ...(target.repair
                ? {
                    files: target.repair.files,
                    failedRun: {
                      runId: target.repair.runId,
                      outcome: target.repair.outcome,
                      gate: target.repair.gate,
                      steps: target.repair.steps,
                    },
                  }
                : {}),
              ...(offered.length
                ? {
                    secrets: offered.map((secret) => ({
                      name: secret.name,
                      id: secret.secretRef,
                      allowedOrigins: secret.allowedOrigins,
                    })),
                  }
                : {}),
              ...(citations.length ? { sourceSchemas: offeredSchemas(citations) } : {}),
            },
            dataClasses: target.repair ? ["plans", "execution_evidence"] : ["plans"],
            instructions: target.repair
              ? `${generationInstructions} ${repairInstructions}`
              : generationInstructions,
            ...(choice.providerId !== undefined && choice.explicit
              ? { provider: choice.providerId }
              : {}),
            ...(choice.modelId !== undefined && choice.explicit ? { model: choice.modelId } : {}),
            ...(signal ? { signal } : {}),
            check: async (raw) => {
              const output = raw as { code: string; format: "playwright" | "pytest" };
              accepted.bundle = await importer.checkGeneratedCode(
                output,
                offered.map((secret) => secret.name),
                schemas,
              );
              const unchecked = citations.filter(
                ({ sourceRevisionId, pointer }) =>
                  !Object.hasOwn(accepted.bundle?.schemas ?? {}, `${sourceRevisionId}${pointer}`),
              );
              if (unchecked.length)
                throw new ContractError(
                  "INVALID_ARGUMENT",
                  `The plan checks ${unchecked.map((item) => `step ${JSON.stringify(item.stepId)} against source schema ${JSON.stringify(item.sourceRevisionId)} ${JSON.stringify(item.pointer)}`).join(", ")} but the code never calls sourceSchemas.violations with that revision id and pointer: destructure sourceSchemas in the test callback and assert expect(sourceSchemas.violations(sourceRevisionId, pointer, body)).toEqual([]) for every cited schema`,
                );
              const unauthenticated = profileSteps(plan);
              if (unauthenticated.length && !accepted.bundle.profile)
                throw new ContractError(
                  "INVALID_ARGUMENT",
                  `The plan sends ${unauthenticated.map((id) => JSON.stringify(id)).join(", ")} with "auth": "profile" but the code does not use the auth profile session: destructure profileRequest in the test callback and send those requests with it (the plain request fixture is never authenticated)`,
                );
            },
          });
          modelCallIds.push(result.modelCallId);
          candidates.push(
            await importer.createGeneratedRevision(
              test.id,
              {
                ...result.output,
                parentId: String(revision.id),
                modelCallId: result.modelCallId,
                secretRefs: offered,
                ...(target.repair ? { repairedFromRunId: target.repair.runId } : {}),
              },
              accepted.bundle,
            ),
          );
        } catch (error) {
          // Only a candidate the checks refused after every repair is a per-revision result.
          if (
            !(error instanceof ContractError) ||
            !refusalCodes.includes(error.code) ||
            error.details.candidateStatus !== "invalid"
          )
            throw error;
          const callId = error.details.modelCallId;
          if (typeof callId === "string" && !modelCallIds.includes(callId))
            modelCallIds.push(callId);
          validationErrors.push({ path: id, message: error.message });
        }
      }
    } catch (error) {
      // A fatal failure after paid calls must not hide what was already created.
      if (!(error instanceof ContractError) || (!candidates.length && !modelCallIds.length))
        throw error;
      // A cancelled request is recorded and may be billed, so it is listed beside the others.
      for (const callId of [error.details.modelCallId, error.details.lastModelCallId])
        if (typeof callId === "string" && !modelCallIds.includes(callId)) modelCallIds.push(callId);
      throw new ContractError(
        error.code,
        error.message,
        {
          ...error.details,
          requested: revisions.length,
          candidateRevisionIds: candidates.map((candidate) => candidate.id),
          validationErrors,
          modelCallIds,
        },
        error.issues,
      );
    }
    if (!candidates.length)
      throw new ContractError(
        "INVALID_ARGUMENT",
        "No generated candidate passed the import checks",
        {
          reasonCode: "generated_code_refused",
          requested: revisions.length,
          validationErrors,
          modelCallIds,
        },
      );
    return { requested: revisions.length, candidates, validationErrors };
  }
}
