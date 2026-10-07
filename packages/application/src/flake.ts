import { type BatchReceipt, ContractError, type Run, validate } from "@testmaster/contracts";
import { flakeStatistics, semanticHash } from "@testmaster/domain";
import { runMatrixCell } from "./comparisons.js";
import { requireEntity, type ServiceContext } from "./context.js";
import type { AdmissionSnapshot } from "./provenance.js";
import type { AdmissionOptions, BatchesService, RunsService } from "./runs.js";
import type { WorkerService } from "./worker.js";

export interface FlakeStudyInput {
  testRevision: string;
  environment: string;
  n: number;
  seed: number;
  includeStudyIds?: string[];
}
export interface FlakeStudyReport {
  batchId: string;
  studyIds: string[];
  testId: string;
  revisionId: string;
  environmentRevisionId: string;
  identityHash: string;
  window: { from: string | null; to: string | null };
  counts: {
    nPlanned: number;
    nPass: number;
    nFail: number;
    nBlocked: number;
    nCancelled: number;
    nInconclusive: number;
    nValid: number;
    nInFlight: number;
  };
  failureRate: number | null;
  wilson95: { low: number; high: number } | null;
  zeroFailureUpper95: number | null;
  classification:
    | "insufficient_data"
    | "passing_observed"
    | "deterministic_failure"
    | "suspected_flaky"
    | "confirmed_flaky";
  runIds: string[];
  limitations: string[];
  incompatible: { batchId: string; reasons: string[] }[];
}
export function flakeIdentity(run: Run): { identityHash: string; limitations: string[] } {
  const cell = runMatrixCell(run);
  const snapshot = cell.admissionSnapshot as unknown as AdmissionSnapshot | undefined;
  const limitations: string[] = [];
  if (
    !snapshot?.repository?.commitSha ||
    !snapshot.repository.checkoutSha ||
    snapshot.repository.binding !== "verified"
  )
    limitations.push("source-binding-unavailable");
  if (
    !snapshot?.runnerImageDigest ||
    !snapshot.runtimeIdentity?.nodeVersion ||
    (snapshot.requiredCapabilities.includes("playwright") &&
      (!snapshot.runtimeIdentity.browserVersion || !snapshot.runtimeIdentity.playwrightVersion))
  )
    limitations.push("runtime-identity-unavailable");
  const config = cell.effectiveConfig as { config?: { browser?: unknown } } | undefined;
  const bindings = cell.dependencyBindings as Record<string, unknown>[] | undefined;
  const dependencyIdentity =
    bindings?.map(
      ({ producerRunId: _runId, reusedVariableId: _variableId, ...binding }) => binding,
    ) ?? [];
  return {
    identityHash: semanticHash({
      testId: run.testId,
      revisionId: run.revisionId,
      environmentRevisionId: run.environmentRevisionId,
      repository: snapshot?.repository ?? null,
      sourceRevisions: snapshot?.sourceRevisions ?? null,
      revisionHash: snapshot?.revisionHash ?? null,
      environmentHash: snapshot?.environmentHash ?? null,
      policyHash: snapshot?.policyHash ?? null,
      runnerImageDigest: snapshot?.runnerImageDigest ?? null,
      runtimeIdentity: snapshot?.runtimeIdentity ?? null,
      seed: cell.seed ?? null,
      browser: config?.config?.browser ?? null,
      fixtureHash: cell.fixtureHash ?? null,
      dependencyBindings: dependencyIdentity,
      modelConfigHash: snapshot?.modelConfigHash ?? null,
    }),
    limitations,
  };
}
export class FlakeService {
  constructor(
    readonly ctx: ServiceContext,
    readonly runs: RunsService,
    readonly batches: BatchesService,
    readonly worker: WorkerService,
  ) {}
  async study(
    input: FlakeStudyInput,
    options: AdmissionOptions & { signal?: AbortSignal } = {},
  ): Promise<BatchReceipt> {
    validate("FlakeStudyInput", input);
    const revision = requireEntity(this.ctx, "TestRevision", input.testRevision);
    const test = requireEntity(this.ctx, "TestCase", String(revision.testId));
    this.ctx.authorize("X", String(test.projectId));
    if (
      this.runs.host.config.effectiveConfig.config.healing?.mode !== undefined &&
      this.runs.host.config.effectiveConfig.config.healing.mode !== "off"
    )
      throw new ContractError("POLICY_DENIED", "Flake studies require healing off");
    const receipt = await this.batches.admit(
      {
        selection: Array.from({ length: input.n }, (_, repetitionIndex) => ({
          testId: test.id,
          revisionId: revision.id,
          environmentId: input.environment,
          mode: "replay" as const,
          healingPolicy: "off" as const,
          seed: input.seed,
          repetitionIndex,
          limits: { maxAttempts: 1 },
          extensions: {
            "testmaster:maxConcurrency": 1,
            "testmaster:flakeStudy": true,
            "testmaster:includeStudyIds": input.includeStudyIds ?? [],
          },
        })),
      },
      options,
    );
    if (options.wait) {
      const ids = receipt.allMembers;
      const signal = options.signal ? { signal: options.signal } : {};
      if (!this.runs.host.liveWorker())
        await this.worker.run({ ephemeral: true, runIds: ids, ...signal });
      for (const id of ids) await this.runs.wait(id, signal);
    }
    return receipt;
  }
  report(batchId: string, includeStudyIds?: string[]): FlakeStudyReport {
    const batch = this.batches.get(batchId);
    const selection = batch.selectionSnapshot as {
      selection?: { extensions?: Record<string, unknown> }[];
    };
    const stored = selection.selection?.[0]?.extensions?.["testmaster:includeStudyIds"];
    const included =
      includeStudyIds ??
      (Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
    if (included.length > 20)
      throw new ContractError("INVALID_ARGUMENT", "At most 20 additional studies may be included");
    const studyRuns = (id: string) => {
      const batch = this.batches.get(id);
      const selection = batch.selectionSnapshot as {
        selection?: { repetitionIndex?: number; extensions?: Record<string, unknown> }[];
        requestedRunIds?: string[];
      };
      if (
        !selection.selection?.length ||
        selection.selection.some(
          (member) =>
            member.extensions?.["testmaster:flakeStudy"] !== true ||
            member.repetitionIndex === undefined,
        )
      )
        throw new ContractError("INVALID_ARGUMENT", "Batch is not a flake study", { batchId: id });
      const requested = selection.requestedRunIds ?? (batch.memberRuns as string[]);
      return requested.map((runId) => this.runs.get(runId));
    };
    const base = studyRuns(batchId);
    const first = base[0]!;
    const identity = flakeIdentity(first);
    const all = new Map<string, Run>();
    const incompatible: FlakeStudyReport["incompatible"] = [];
    const studyIds: string[] = [];
    for (const id of [...new Set([batchId, ...included])]) {
      const runs = id === batchId ? base : studyRuns(id);
      const reasons = [
        ...new Set(
          runs.flatMap((run) => {
            const actual = flakeIdentity(run);
            return [
              ...(actual.identityHash !== identity.identityHash ? ["cohort-identity-changed"] : []),
              ...(id !== batchId ? actual.limitations : []),
            ];
          }),
        ),
      ];
      if (reasons.length) {
        if (id === batchId)
          throw new ContractError(
            "PRECONDITION_FAILED",
            "Study contains incompatible frozen identities",
            { reasons },
          );
        incompatible.push({ batchId: id, reasons });
        continue;
      }
      studyIds.push(id);
      for (const run of runs) all.set(run.id, run);
    }
    const runs = [...all.values()];
    const counts = {
      nPlanned: runs.length,
      nPass: 0,
      nFail: 0,
      nBlocked: 0,
      nCancelled: 0,
      nInconclusive: 0,
    };
    for (const run of runs) {
      if (run.outcome === "passed") counts.nPass++;
      else if (run.outcome === "failed") counts.nFail++;
      else if (run.outcome === "blocked") counts.nBlocked++;
      else if (run.outcome === "cancelled") counts.nCancelled++;
      else if (run.outcome === "inconclusive") counts.nInconclusive++;
    }
    const stats = flakeStatistics(counts);
    const dates = runs
      .flatMap((run) => (typeof run.createdAt === "string" ? [run.createdAt] : []))
      .sort();
    return validate<FlakeStudyReport>("FlakeStudyReport", {
      batchId,
      studyIds,
      testId: first.testId,
      revisionId: first.revisionId,
      environmentRevisionId: first.environmentRevisionId,
      identityHash: identity.identityHash,
      window: { from: dates[0] ?? null, to: dates.at(-1) ?? null },
      ...stats,
      classification: identity.limitations.length ? "insufficient_data" : stats.classification,
      runIds: runs.map((run) => run.id),
      limitations: [
        ...identity.limitations,
        ...stats.limitations,
        "Target fixture reset and independent intermittent-cause evidence are not inferred from repeat count",
      ],
      incompatible,
    });
  }
}
