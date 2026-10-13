import {
  type AttemptView,
  ContractError,
  type HealingProposal,
  type ProjectMetrics,
} from "@testmaster/contracts";
import type { ReportsService } from "./artifacts.js";
import { allEntities, requireEntity, type ServiceContext } from "./context.js";
import type { QuarantineService } from "./quarantine.js";
import type { RunsService } from "./runs.js";

/** Newest Runs a dashboard window reads; every Run costs a bundle verification. */
export const metricsRunCap = 200;
const dayMs = 24 * 60 * 60 * 1000;
export interface MetricsWindow {
  since?: string;
  until?: string;
  limit?: number;
}

/**
 * Read models for the portal that need joins no single service owns: Attempts with the policy and
 * reason that created them (UX-029), healing proposals of a failed Run (UX-040) and dashboard
 * metrics that keep every quarantine exclusion visible (VAL-007).
 */
export class RunViewsService {
  constructor(
    readonly ctx: ServiceContext,
    readonly runs: RunsService,
    readonly reports: ReportsService,
    readonly quarantine: QuarantineService,
    readonly now: () => number = Date.now,
  ) {}

  attempts(runId: string): AttemptView[] {
    const run = this.runs.get(runId);
    const cell = run.matrixCell as { limits?: { maxAttempts?: number } };
    const maxAttempts = cell.limits?.maxAttempts ?? 2;
    const rows = this.ctx.database.all(
      "SELECT id FROM attempts WHERE workspace_id=? AND run_id=? ORDER BY number",
      this.ctx.workspaceId,
      runId,
    );
    const attempts = rows.map((row) => requireEntity(this.ctx, "Attempt", String(row.id)));
    const steps = this.runs.steps(runId);
    return attempts.map((attempt, index) => {
      const previous = index > 0 ? attempts[index - 1] : undefined;
      const lastReason = previous
        ? steps.filter((step) => step.attemptId === previous.id && step.reasonCode).at(-1)
            ?.reasonCode
        : undefined;
      return {
        id: String(attempt.id),
        runId,
        number: Number(attempt.number),
        workerId: (attempt.workerId as string | null) ?? null,
        phase: attempt.phase as AttemptView["phase"],
        startedAt: (attempt.startedAt as string | null) ?? null,
        endedAt: (attempt.endedAt as string | null) ?? null,
        outcome: (attempt.outcome as AttemptView["outcome"]) ?? null,
        kind: previous ? "retry" : "initial",
        policy: { maxAttempts },
        retry: previous
          ? {
              previousAttemptId: String(previous.id),
              previousOutcome: (previous.outcome as AttemptView["outcome"]) ?? null,
              category: previous.outcome === "failed" ? "diagnostic" : "infrastructure",
              reasonCode: ((lastReason as string | undefined) ??
                (previous.outcome === "inconclusive" ? "worker_lost" : null)) as NonNullable<
                AttemptView["retry"]
              >["reasonCode"],
            }
          : null,
      };
    });
  }

  healingProposals(runId: string): HealingProposal[] {
    this.runs.get(runId);
    return allEntities(this.ctx, "HealingProposal").filter(
      (proposal) => proposal.failedRunId === runId,
    ) as unknown as HealingProposal[];
  }

  async metrics(projectId: string, window: MetricsWindow = {}): Promise<ProjectMetrics> {
    this.ctx.authorize("R", projectId);
    const project = requireEntity(this.ctx, "Project", projectId);
    const until = window.until ?? new Date(this.now()).toISOString();
    const since = window.since ?? new Date(Date.parse(until) - 30 * dayMs).toISOString();
    if (
      !Number.isFinite(Date.parse(since)) ||
      !Number.isFinite(Date.parse(until)) ||
      Date.parse(since) >= Date.parse(until)
    )
      throw new ContractError("INVALID_ARGUMENT", "The window needs since earlier than until");
    const limit = Math.min(window.limit ?? metricsRunCap, metricsRunCap);
    const inWindow = this.runs
      .list()
      .filter((run) => {
        const test = requireEntity(this.ctx, "TestCase", run.testId);
        return (
          test.projectId === project.id &&
          String(run.createdAt) >= since &&
          String(run.createdAt) <= until
        );
      })
      .sort(
        (a, b) =>
          String(b.createdAt).localeCompare(String(a.createdAt)) ||
          String(b.id).localeCompare(String(a.id)),
      );
    const selected = inWindow.slice(0, limit);
    const metrics = await this.reports.metrics(selected.map((run) => run.id));
    const now = this.now();
    const quarantined = this.quarantine.list(projectId).map((record) => ({
      testId: record.testId,
      owner: record.owner,
      reason: record.reason,
      expiresAt: record.expiresAt,
      active: Date.parse(record.expiresAt) > now,
      runsInWindow: selected.filter((run) => run.testId === record.testId).length,
      failedRunsInWindow: selected.filter(
        (run) => run.testId === record.testId && run.outcome === "failed",
      ).length,
    }));
    return {
      projectId,
      window: { since, until },
      considered: selected.length,
      truncated: inWindow.length > selected.length,
      metrics,
      quarantined,
      limitations: [
        "Quarantine never removes a Run from these rates: runs of quarantined tests stay in every denominator.",
        "Retries never enter the denominator; first-attempt rates read Attempt 1 only.",
      ],
    };
  }
}
