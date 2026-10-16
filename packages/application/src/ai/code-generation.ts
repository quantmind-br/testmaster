import { ContractError, type ExecutablePlan } from "@testmaster/contracts";
import type { EntityDocument } from "@testmaster/persistence";
import { CODE_IMPORT_RULES, type ImportedCodeBundle } from "@testmaster/planner";
import type { ResolvedConfig } from "../config.js";
import { allEntities, requireEntity, type ServiceContext } from "../context.js";
import { CodeImportService, type CodeSecretBinding } from "./code-import.js";
import { ModelService } from "./model.js";
import { type SchemaCitation, schemaCitations, sourceSchemasFor } from "./source-documents.js";

/** What the model must obey; the importer enforces the same constants (planner `CODE_IMPORT_RULES`). */
const generationInstructions = `Return standalone Playwright test code importing only @playwright/test. Preserve every deterministic plan assertion and action. Use page.goto relative URLs and runner-configured baseURL. No shell, dependency installs, eval, filesystem or empty assertions. Do not use TestMaster APIs. A plan value {"secretRef": <id>} is a credential: read it with secrets.get(NAME), where NAME is the entry of the data "secrets" list (name, id, allowedOrigins; never values) whose id matches. A plan request step with "auth": "profile" is sent with the environment's logged-in auth profile session: send it with the profileRequest fixture (destructure it in the test callback, async ({ profileRequest }) => { ... }), an APIRequestContext with the session applied, and use the profilePage fixture the same way for a browser flow that needs that session. The plain request and page fixtures are never authenticated: use them for steps without "auth" (for example a request that must answer 401), and never copy cookies, tokens or other session values into the code. A profileRequest does not follow redirects when the profile sends a header credential. A plan assertion with predicate "jsonSchema" checks a JSON value of the response against the source schema it cites (sourceRevisionId and pointer): the data "sourceSchemas" list names each cited schema with the plan steps that use it. The schema documents are frozen into the test and cannot be read, so check each one with the sourceSchemas fixture, never with hand-written structural assertions, and never skip it. The code is machine-checked before it is accepted and any violation is refused, so obey every rule: ${CODE_IMPORT_RULES.join(" ")}`;
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
  budget?: {
    modelCalls?: number;
  };
  /** Model provider; absent: the first allowed provider. Validated before any model call. */
  provider?: string;
  /** Model id; absent: the provider's first structured-output model. Validated before any call. */
  model?: string;
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
  async generate(input: CodeGenerationInput, signal?: AbortSignal) {
    this.ctx.authorize("X", input.projectId);
    this.ctx.authorize("W", input.projectId);
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
    const importer = new CodeImportService(this.ctx, this.config);
    const offered = this.offeredSecrets(input.projectId);
    const candidates: EntityDocument[] = [];
    const validationErrors: GenerationFailure[] = [];
    const modelCallIds: string[] = [];
    try {
      for (const id of revisions) {
        const revision = requireEntity(this.ctx, "TestRevision", id);
        const test = requireEntity(this.ctx, "TestCase", String(revision.testId));
        if (test.projectId !== input.projectId || !revision.plan)
          throw new ContractError(
            "POLICY_DENIED",
            "Revision is outside the project or has no grounded plan",
          );
        // The code checks the schemas the plan cites through the sourceSchemas fixture, so they are
        // resolved now, exactly as the plan's runner input resolves them, and frozen into the bundle.
        const citations = schemaCitations(revision.plan as ExecutablePlan);
        const schemas = citations.length
          ? sourceSchemasFor(this.ctx, revision.plan as ExecutablePlan)
          : {};
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
              plan: revision.plan,
              format: "playwright",
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
            dataClasses: ["plans"],
            instructions: generationInstructions,
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
              const unauthenticated = profileSteps(revision.plan);
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
                parentId: revision.id,
                modelCallId: result.modelCallId,
                secretRefs: offered,
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
