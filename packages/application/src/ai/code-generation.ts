import { ContractError } from "@testmaster/contracts";
import type { EntityDocument } from "@testmaster/persistence";
import { CODE_IMPORT_RULES, type ImportedCodeBundle } from "@testmaster/planner";
import type { ResolvedConfig } from "../config.js";
import { requireEntity, type ServiceContext } from "../context.js";
import { CodeImportService } from "./code-import.js";
import { ModelService } from "./model.js";

/** What the model must obey; the importer enforces the same constants (planner `CODE_IMPORT_RULES`). */
const generationInstructions = `Return standalone Playwright test code importing only @playwright/test. Preserve every deterministic plan assertion and action. Use page.goto relative URLs and runner-configured baseURL. No shell, dependency installs, eval, filesystem or empty assertions. Do not use TestMaster APIs. The code is machine-checked before it is accepted and any violation is refused, so obey every rule: ${CODE_IMPORT_RULES.join(" ")}`;
// A refused candidate is a per-revision result; any other failure (budget, provider) is not.
const refusalCodes: readonly string[] = ["INVALID_ARGUMENT", "POLICY_DENIED", "PAYLOAD_TOO_LARGE"];
/**
 * Deadline of each revision's model call (first attempt and repairs). Generated code is long
 * output, and a refused first answer is followed by repairs, so the 180 s default of the other
 * purposes cut a call that was still making progress.
 */
export const CODE_GENERATION_DEADLINE_MS = 300000;
/** `reasonCode` of a `validationErrors` entry whose revision reached the model deadline. */
export const CODE_GENERATION_DEADLINE_REASON = "model_deadline_exceeded";
const maximumDeadlineMs = 600000;
interface GenerationFailure {
  path: string;
  message: string;
  reasonCode?: string;
  modelCallId?: string;
}
export interface CodeGenerationInput {
  projectId: string;
  proposalIds?: string[];
  revisionIds?: string[];
  budget?: {
    modelCalls?: number;
    /** Deadline of each revision's model call, repairs included; default {@link CODE_GENERATION_DEADLINE_MS}. */
    deadlineMs?: number;
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
    const deadlineMs = input.budget?.deadlineMs ?? CODE_GENERATION_DEADLINE_MS;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > maximumDeadlineMs)
      throw new ContractError(
        "INVALID_ARGUMENT",
        `Code generation deadlineMs must be an integer from 1 to ${maximumDeadlineMs}`,
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
            data: { plan: revision.plan, format: "playwright" },
            dataClasses: ["plans"],
            instructions: generationInstructions,
            deadlineMs,
            ...(choice.providerId !== undefined && choice.explicit
              ? { provider: choice.providerId }
              : {}),
            ...(choice.modelId !== undefined && choice.explicit ? { model: choice.modelId } : {}),
            ...(signal ? { signal } : {}),
            check: async (raw) => {
              const output = raw as { code: string; format: "playwright" | "pytest" };
              accepted.bundle = await importer.checkGeneratedCode(output);
            },
          });
          modelCallIds.push(result.modelCallId);
          candidates.push(
            await importer.createGeneratedRevision(
              test.id,
              { ...result.output, parentId: revision.id },
              accepted.bundle,
            ),
          );
        } catch (error) {
          if (!(error instanceof ContractError)) throw error;
          const callId = error.details.modelCallId;
          const known = typeof callId === "string" ? callId : undefined;
          // A deadline also names the recorded request it cut, which may have been billed.
          const lastCallId = error.details.lastModelCallId;
          const last = typeof lastCallId === "string" ? lastCallId : known;
          // The revision's own deadline is a per-revision result, but a caller cancellation (the
          // gateway reports it as another code) or an aborted signal stays fatal.
          if (error.code === "UPSTREAM_TIMEOUT" && !signal?.aborted) {
            for (const recorded of [known, last])
              if (recorded && !modelCallIds.includes(recorded)) modelCallIds.push(recorded);
            const refusal = (error.details.validationFailure as { message?: unknown } | undefined)
              ?.message;
            const reason =
              typeof refusal === "string" ? `; the last response was refused: ${refusal}` : "";
            validationErrors.push({
              path: id,
              message:
                `Model call reached its ${deadlineMs} ms deadline, repairs included${reason}`.slice(
                  0,
                  8000,
                ),
              reasonCode: CODE_GENERATION_DEADLINE_REASON,
              ...(last ? { modelCallId: last } : {}),
            });
            continue;
          }
          // Only a candidate the checks refused after every repair is a per-revision result.
          if (!refusalCodes.includes(error.code) || error.details.candidateStatus !== "invalid")
            throw error;
          if (known && !modelCallIds.includes(known)) modelCallIds.push(known);
          validationErrors.push({ path: id, message: error.message });
        }
      }
    } catch (error) {
      // A fatal failure after paid calls must not hide what was already created.
      if (!(error instanceof ContractError) || (!candidates.length && !modelCallIds.length))
        throw error;
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
    if (!candidates.length) {
      // Every revision reaching its deadline is a timeout of the call, not a refusal of the code.
      if (validationErrors.every((entry) => entry.reasonCode === CODE_GENERATION_DEADLINE_REASON))
        throw new ContractError(
          "UPSTREAM_TIMEOUT",
          "No generated candidate finished before the model deadline",
          {
            reasonCode: CODE_GENERATION_DEADLINE_REASON,
            requested: revisions.length,
            deadlineMs,
            validationErrors,
            modelCallIds,
          },
        );
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
    }
    return { requested: revisions.length, candidates, validationErrors };
  }
}
