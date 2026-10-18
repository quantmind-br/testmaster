import type { ExecutablePlan, RunRequest } from "@testmaster/contracts";
import { requireEntity, type ServiceContext } from "./context.js";
import { freshPassingRun } from "./coverage.js";
import { isTrialTest } from "./trial-tests.js";

/**
 * The prior Run that satisfies a `runPolicy: "once"` test for this request, or `null` when the
 * request must dispatch. A request is satisfied when it is an ordinary replay of the test's active
 * revision and the latest completed replay of that revision against the environment's active
 * revision and the same destination is fresh passing evidence (`freshPassingRun`, the definition
 * coverage uses). A new environment revision, a new test revision, a different destination or a
 * later non-passing replay re-arms the test. Healing verifications, trials, flake studies,
 * repetitions and agent runs never skip: they exist to run again.
 */
export function onceSatisfiedRun(ctx: ServiceContext, request: RunRequest): string | null {
  if (
    (request.mode ?? "replay") !== "replay" ||
    request.origin === "verification" ||
    request.repetitionIndex !== undefined ||
    request.extensions?.["testmaster:flakeStudy"] === true
  )
    return null;
  // A missing test or environment is the ordinary admission path's refusal, not this check's.
  const test = ctx.entities.get("TestCase", ctx.workspaceId, request.testId);
  if (!test || test.archivedAt || isTrialTest(test) || !test.activeRevisionId) return null;
  if (request.revisionId && request.revisionId !== test.activeRevisionId) return null;
  const plan = requireEntity(ctx, "TestRevision", String(test.activeRevisionId)).plan as
    | ExecutablePlan
    | null
    | undefined;
  if (plan?.runPolicy !== "once") return null;
  ctx.authorize("X", String(test.projectId));
  const environment = ctx.entities.get("Environment", ctx.workspaceId, request.environmentId);
  if (!environment || environment.projectId !== test.projectId || environment.archivedAt)
    return null;
  const environmentRevision = requireEntity(
    ctx,
    "EnvironmentRevision",
    String(environment.activeRevisionId),
  );
  const target = request.extensions?.["testmaster:targetUrl"];
  const baseUrl =
    typeof target === "string"
      ? new URL(target).origin
      : (environmentRevision.targetOrigins as string[])[0];
  const prior = ctx.database.get(
    "SELECT id,outcome,gate,mode FROM runs WHERE workspace_id=? AND test_id=? AND revision_id=? AND environment_revision_id=? AND mode='replay' AND phase='completed' ORDER BY created_at DESC,id DESC LIMIT 1",
    ctx.workspaceId,
    test.id,
    test.activeRevisionId,
    environmentRevision.id,
  );
  if (!prior) return null;
  const run = requireEntity(ctx, "Run", String(prior.id));
  if ((run.matrixCell as Record<string, unknown>).baseUrl !== baseUrl) return null;
  const reduced = ctx.database
    .all(
      "SELECT data_json FROM outbox WHERE workspace_id=? AND aggregate_id=? AND type='run.reduced' ORDER BY seq DESC LIMIT 1",
      ctx.workspaceId,
      prior.id,
    )
    .map((row) => JSON.parse(String(row.data_json)) as Record<string, unknown>)[0];
  const attempts = ctx.database
    .all(
      "SELECT number,outcome FROM attempts WHERE workspace_id=? AND run_id=? ORDER BY number",
      ctx.workspaceId,
      prior.id,
    )
    .map((row) => ({ number: Number(row.number), outcome: row.outcome as string | null }));
  const evidence = ctx.database.get(
    "SELECT 1 AS present FROM snapshots WHERE workspace_id=? AND run_id=? LIMIT 1",
    ctx.workspaceId,
    prior.id,
  );
  return freshPassingRun({
    run: { mode: String(prior.mode) },
    result: {
      outcome: prior.outcome === null ? null : String(prior.outcome),
      gate: String(prior.gate),
      passedOnRetry: Boolean(reduced?.passedOnRetry),
      firstAttemptOutcome: (reduced?.firstAttemptOutcome as string | null | undefined) ?? null,
    },
    evidenceState: evidence ? "committed" : "unavailable",
    attempts,
  })
    ? String(prior.id)
    : null;
}
