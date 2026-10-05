import { ContractError } from "@testmaster/contracts";
import type { EntityDocument } from "@testmaster/persistence";
import type { ResolvedConfig } from "../config.js";
import { requireEntity, type ServiceContext } from "../context.js";
import { CodeImportService } from "./code-import.js";
import { ModelService } from "./model.js";
export interface CodeGenerationInput {
  projectId: string;
  proposalIds?: string[];
  revisionIds?: string[];
  budget?: { modelCalls?: number };
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
    const candidates: EntityDocument[] = [];
    const validationErrors: { path: string; message: string }[] = [];
    for (const id of revisions) {
      const revision = requireEntity(this.ctx, "TestRevision", id);
      const test = requireEntity(this.ctx, "TestCase", String(revision.testId));
      if (test.projectId !== input.projectId || !revision.plan)
        throw new ContractError(
          "POLICY_DENIED",
          "Revision is outside the project or has no grounded plan",
        );
      const result = await new ModelService(this.ctx, this.config).complete<{
        code: string;
        format: "playwright" | "pytest";
      }>({
        projectId: input.projectId,
        purpose: "generate_code",
        responseSchema: "AIGeneratedCodeOutput",
        data: { plan: revision.plan, format: "playwright" },
        dataClasses: ["plans"],
        instructions:
          "Return standalone Playwright test code importing only @playwright/test. Preserve every deterministic plan assertion and action. Use page.goto relative URLs and runner-configured baseURL. No shell, dependency installs, eval, filesystem or empty assertions. Do not use TestMaster APIs.",
        ...(signal ? { signal } : {}),
      });
      try {
        candidates.push(
          await new CodeImportService(this.ctx, this.config).createGeneratedRevision(test.id, {
            ...result.output,
            parentId: revision.id,
          }),
        );
      } catch (error) {
        if (!(error instanceof ContractError)) throw error;
        validationErrors.push({ path: id, message: error.message });
      }
    }
    return { candidates, validationErrors };
  }
}
