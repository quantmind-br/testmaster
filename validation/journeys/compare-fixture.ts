import { type Application, scaffoldPlan } from "@testmaster/application";
import type { ExecutablePlan } from "@testmaster/contracts";
import { ExecutionRepository } from "@testmaster/persistence";
import { seedRun } from "../../packages/application/src/run-seed.testing.js";

/**
 * Data for the comparison, batch matrix, flake study and quarantine pages (UX-035..UX-038),
 * shared by the page journey and the portal accessibility sweep. Runs, batches and studies are
 * admitted through the application services on the stack's PostgreSQL database and finished
 * through the lease repository, exactly as a worker would.
 */
export type Outcome = "passed" | "failed";

export interface CompareFixture {
  readonly projectId: string;
  readonly stagingId: string;
  readonly canaryId: string;
  readonly checkout: string;
  readonly login: string;
  readonly bulk: string;
  readonly checkoutRevision: string;
  /** Same test and environment, revision 1 passed. */
  readonly passedRevisionOne: string;
  /** Same test and environment, revision 2 failed. */
  readonly failedRevisionTwo: string;
  /** A Run of a different test: not comparable with the others. */
  readonly otherTest: string;
  /** Three Runs plus one member that was not dispatched. */
  readonly incompleteBatch: string;
  readonly incompleteFailedRun: string;
  readonly completeBatch: string;
  readonly runningBatch: string;
  /** Two batches of the same thirty cases with opposite verdicts (empty unless `bulk` was requested). */
  readonly bulkLeft: string;
  readonly bulkRight: string;
  readonly finishedStudy: string;
  readonly runningStudy: string;
  readonly runningStudyRuns: readonly string[];
}

/** Finishes one admitted Run the way a worker does: claim, run, finalize with a verdict. */
export function finishRun(system: Application, runId: string, outcome: Outcome): void {
  const execution = new ExecutionRepository(system.database);
  const fence = execution.leases.claim({
    workspaceId: system.context.workspaceId,
    owner: "journey-worker",
    queue: "local",
    leaseMs: 600_000,
    runIds: [runId],
  });
  if (!fence) throw new Error(`Run ${runId} cannot be claimed`);
  execution.progress(fence, "preparing");
  execution.progress(fence, "running");
  const run = system.runs.get(runId);
  execution.finalize(fence, {
    ...run,
    phase: "completed",
    status: outcome,
    outcome,
    gate: outcome === "passed" ? "passed" : "failed",
    cleanupOutcome: "not_required",
    analysisStatus: "not_requested",
  });
}

interface BatchMemberInput {
  readonly testId: string;
  readonly environmentId: string;
  readonly repetitionIndex?: number;
}

interface Admitted {
  readonly batchId: string;
  readonly runIds: string[];
}

/** Runs `admit` with a stubbed live worker and preflight so admission queues Runs without executing. */
async function withQueuedAdmission<T>(system: Application, admit: () => Promise<T>): Promise<T> {
  const liveWorker = system.runs.host.liveWorker;
  const preflight = system.preflight;
  system.runs.host.liveWorker = () => true;
  system.preflight = async () => {};
  try {
    return await admit();
  } finally {
    system.runs.host.liveWorker = liveWorker;
    system.preflight = preflight;
  }
}

async function admitBatch(
  system: Application,
  selection: readonly BatchMemberInput[],
  partialDispatch = false,
): Promise<Admitted> {
  const receipt = await withQueuedAdmission(system, () =>
    system.batches.admit({
      selection: [...selection],
      ...(partialDispatch ? { partialDispatch: true } : {}),
    }),
  );
  return { batchId: receipt.batchId, runIds: [...receipt.allMembers] };
}

async function admitFlakeStudy(
  system: Application,
  input: { revisionId: string; environmentId: string; n: number; seed: number },
): Promise<Admitted> {
  const receipt = await withQueuedAdmission(system, () =>
    system.flake.study({
      testRevision: input.revisionId,
      environment: input.environmentId,
      n: input.n,
      seed: input.seed,
    }),
  );
  return { batchId: receipt.batchId, runIds: [...receipt.allMembers] };
}

function environmentOf(system: Application, runId: string): string {
  const cell = system.runs.get(runId).matrixCell;
  if (
    cell === null ||
    typeof cell !== "object" ||
    Array.isArray(cell) ||
    !("environmentId" in cell)
  )
    throw new Error(`Run ${runId} has no environment in its matrix cell`);
  return String(cell.environmentId);
}

export async function seedCompareFixture(
  system: Application,
  options: { readonly projectName: string; readonly bulk: boolean },
): Promise<CompareFixture> {
  const projectId = String(system.projects.create({ name: options.projectName }).id);
  const create = (name: string) =>
    String(system.environments.create({ projectId, name, baseUrl: "http://127.0.0.1:9" }).id);
  const stagingId = create("staging");
  const canaryId = create("canary");
  const test = (name: string) =>
    String(system.tests.create({ projectId, plan: scaffoldPlan("backend"), name }).id);
  const checkout = test("Checkout flow");
  const login = test("Login flow");
  const bulk = test("Bulk comparison");

  // Run comparison: revision 1 passed, revision 2 of the same test failed, and a Run of another test.
  const firstRevision = system.revisions.list(checkout)[0];
  if (!firstRevision) throw new Error("The test has no revision");
  const secondPlan: ExecutablePlan = {
    ...(firstRevision.plan as ExecutablePlan),
    name: "Checkout flow, second revision",
  };
  const secondRevision = system.revisions.create(checkout, secondPlan, firstRevision.id);
  const seeded = (testId: string, outcome: Outcome, revisionId?: string) =>
    seedRun(system, {
      testId,
      environmentId: stagingId,
      attempts: [
        {
          outcome,
          steps: [
            {
              stepId: "s1",
              status: outcome,
              ...(outcome === "failed" ? { reasonCode: "assertion_mismatch" } : {}),
            },
          ],
        },
      ],
      ...(revisionId ? { request: { revisionId } } : {}),
    }).then((run) => run.runId);
  const passedRevisionOne = await seeded(checkout, "passed", firstRevision.id);
  const failedRevisionTwo = await seeded(checkout, "failed", secondRevision.id);
  const otherTest = await seeded(login, "failed");

  // Matrix: three Runs (one failing only in canary), one member that cannot be dispatched.
  const missing = "tst_00000000-0000-4000-8000-000000000000";
  const incomplete = await admitBatch(
    system,
    [
      { testId: checkout, environmentId: stagingId },
      { testId: checkout, environmentId: canaryId },
      { testId: login, environmentId: stagingId },
      { testId: missing, environmentId: stagingId },
    ],
    true,
  );
  let incompleteFailedRun = "";
  for (const runId of incomplete.runIds) {
    const failing =
      system.runs.get(runId).testId === checkout && environmentOf(system, runId) === canaryId;
    if (failing) incompleteFailedRun = runId;
    finishRun(system, runId, failing ? "failed" : "passed");
  }

  // A complete, all-passed batch: every test in every environment.
  const complete = await admitBatch(
    system,
    [checkout, login].flatMap((testId) =>
      [stagingId, canaryId].map((environmentId) => ({ testId, environmentId })),
    ),
  );
  for (const runId of complete.runIds) finishRun(system, runId, "passed");

  // A batch that is still running, so it can be cancelled.
  const running = await admitBatch(system, [{ testId: login, environmentId: canaryId }]);

  // Two batches of the same thirty cases with opposite verdicts: more than one page of differences.
  let bulkLeft = "";
  let bulkRight = "";
  if (options.bulk) {
    const repetitions = Array.from({ length: 30 }, (_, repetitionIndex) => ({
      testId: bulk,
      environmentId: stagingId,
      repetitionIndex,
    }));
    const left = await admitBatch(system, repetitions);
    for (const runId of left.runIds) finishRun(system, runId, "passed");
    const right = await admitBatch(system, repetitions);
    for (const runId of right.runIds) finishRun(system, runId, "failed");
    bulkLeft = left.batchId;
    bulkRight = right.batchId;
  }

  // Flake studies: one finished, one with two Runs still going.
  const finished = await admitFlakeStudy(system, {
    revisionId: firstRevision.id,
    environmentId: stagingId,
    n: 4,
    seed: 1,
  });
  const outcomes: Outcome[] = ["passed", "failed", "passed", "passed"];
  finished.runIds.forEach((runId, index) => {
    finishRun(system, runId, outcomes[index] ?? "passed");
  });
  const live = await admitFlakeStudy(system, {
    revisionId: firstRevision.id,
    environmentId: stagingId,
    n: 4,
    seed: 2,
  });
  for (const runId of live.runIds.slice(0, 2)) finishRun(system, runId, "passed");

  return {
    projectId,
    stagingId,
    canaryId,
    checkout,
    login,
    bulk,
    checkoutRevision: firstRevision.id,
    passedRevisionOne,
    failedRevisionTwo,
    otherTest,
    incompleteBatch: incomplete.batchId,
    incompleteFailedRun,
    completeBatch: complete.batchId,
    runningBatch: running.batchId,
    bulkLeft,
    bulkRight,
    finishedStudy: finished.batchId,
    runningStudy: live.batchId,
    runningStudyRuns: live.runIds,
  };
}
