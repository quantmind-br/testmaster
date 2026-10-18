import { ContractError } from "@testmaster/contracts";
import type { Application } from "./application.js";

/** What a caller selects: accepted proposals or existing revisions, or the failed run of a candidate. */
export interface GenerateTestsRequest {
  proposalIds?: string[] | undefined;
  revisionIds?: string[] | undefined;
  runId?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
}

/** One candidate revision the call created. */
export interface GeneratedCandidate {
  id: string;
  testId: string;
  testName: string;
  /** The revision the code was generated from, regenerated, or repaired. */
  sourceRevisionId: string;
  proposalId?: string;
  repairedFromRunId?: string;
}

export interface GeneratedTests {
  requested: number;
  candidates: GeneratedCandidate[];
  /** One entry per revision whose candidate the checks refused after every repair. */
  validationErrors: { path: string; message: string }[];
}

function invalidSelection(path: string, rule: string, summary: string, message: string): never {
  const issues = [{ path, rule, message: summary }];
  throw new ContractError("INVALID_ARGUMENT", message, { issues }, issues);
}

/**
 * Generates code candidates for a selection of one project: the shared core of MCP
 * `testmaster_generate_tests` and `testmaster test generate`. The selection is checked before any
 * model call; the model call has no deadline and only `signal` stops it.
 */
export async function generateTests(
  app: Application,
  request: GenerateTestsRequest,
  signal?: AbortSignal,
): Promise<GeneratedTests> {
  const { revisionIds, proposalIds, runId } = request;
  // `runId` repairs one failed candidate; the other two select what to generate from.
  if (runId !== undefined && (revisionIds || proposalIds))
    invalidSelection(
      "/runId",
      "not",
      "runId cannot be combined with proposalIds or revisionIds",
      "runId repairs the candidate of one failed run and cannot be combined with proposalIds or revisionIds",
    );
  if (!revisionIds && !proposalIds && runId === undefined)
    invalidSelection(
      "",
      "required",
      "must have proposalIds or revisionIds, or runId",
      "Provide proposalIds or revisionIds (at least one, all from one project), or the runId of a failed code candidate run",
    );
  const projects = new Set<string>();
  if (runId !== undefined)
    projects.add(String(app.tests.get(String(app.runs.get(runId).testId)).projectId));
  for (const id of revisionIds ?? [])
    projects.add(String(app.tests.get(String(app.revisions.get(id).testId)).projectId));
  for (const id of proposalIds ?? []) {
    const proposal = app.context.entities.get("Proposal", app.context.workspaceId, id);
    if (!proposal) throw new ContractError("NOT_FOUND", "Proposal unavailable");
    const batch = app.proposals.get(String(proposal.batchId));
    app.context.authorize("X", String(batch.projectId));
    projects.add(String(batch.projectId));
  }
  if (projects.size !== 1)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Provide proposalIds or revisionIds that belong to a single project",
    );
  const result = await app.codeGeneration.generate(
    {
      projectId: [...projects][0] as string,
      ...(revisionIds ? { revisionIds } : {}),
      ...(proposalIds ? { proposalIds } : {}),
      ...(runId !== undefined ? { runId } : {}),
      ...(request.provider !== undefined ? { provider: request.provider } : {}),
      ...(request.model !== undefined ? { model: request.model } : {}),
    },
    signal,
  );
  // Candidates come back as revision ids only; name the test and the proposal each belongs to.
  const proposalOfRevision = new Map<string, string>();
  for (const proposalId of proposalIds ?? []) {
    const extensions = app.context.entities.get("Proposal", app.context.workspaceId, proposalId)
      ?.extensions as Record<string, unknown> | undefined;
    const accepted =
      extensions?.["testmaster:candidateRevisionId"] ?? extensions?.candidateRevisionId;
    if (typeof accepted === "string") proposalOfRevision.set(accepted, proposalId);
  }
  return {
    requested: result.requested,
    candidates: result.candidates.map((candidate) => {
      const proposalId = proposalOfRevision.get(String(candidate.parentId));
      const repairedFromRunId = (candidate.extensions as Record<string, unknown> | undefined)?.[
        "testmaster:repairedFromRunId"
      ];
      return {
        id: String(candidate.id),
        testId: String(candidate.testId),
        testName: app.tests.get(String(candidate.testId)).name,
        sourceRevisionId: String(candidate.parentId),
        ...(proposalId ? { proposalId } : {}),
        ...(typeof repairedFromRunId === "string" ? { repairedFromRunId } : {}),
      };
    }),
    validationErrors: result.validationErrors,
  };
}
