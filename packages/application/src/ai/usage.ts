import { ContractError, validate } from "@testmaster/contracts";
import { type ModelCallRecord, type Money, SqliteBudgetLedger } from "@testmaster/persistence";
import { requireEntity, type ServiceContext } from "../context.js";
export interface UsageQuery {
  projectId?: string;
  runId?: string;
  model?: string;
  since?: string;
  until?: string;
}
export function aggregateUsage(calls: readonly ModelCallRecord[]) {
  const tokens = {
    inputTokens: 0 as number | null,
    outputTokens: 0 as number | null,
    reasoningTokens: 0 as number | null,
  };
  const measuredTokens = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const unknownTokenCalls = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const costs: Record<string, Money> = {};
  let unknownCostCalls = 0;
  for (const call of calls) {
    for (const key of ["inputTokens", "outputTokens", "reasoningTokens"] as const) {
      const count = call.usage[key];
      if (count === null) {
        tokens[key] = null;
        unknownTokenCalls[key]++;
      } else {
        measuredTokens[key] += count;
        if (tokens[key] !== null) tokens[key] += count;
      }
    }
    if (call.cost === "unknown") unknownCostCalls++;
    else {
      const key = `${call.cost.currency}:${call.cost.scale}`;
      costs[key] = {
        ...call.cost,
        amount: (BigInt(costs[key]?.amount ?? "0") + BigInt(call.cost.amount)).toString(),
      };
    }
  }
  return {
    tokens,
    measuredTokens,
    unknownTokenCalls,
    estimatedTokens: null,
    cost: unknownCostCalls ? ("unknown" as const) : Object.values(costs),
    measuredCosts: Object.values(costs),
    unknownCostCalls,
    cacheHitCalls: calls.filter((call) => call.cacheHit).length,
    runtimeMs: calls.reduce((sum, call) => sum + call.latency, 0),
    componentAccounting:
      "Reasoning is a disclosed output component; cache hits are disclosed separately. Neither is added to input plus output.",
  };
}
export class UsageService {
  constructor(readonly ctx: ServiceContext) {}
  setBudget(projectId: string, input: { tokens: number }) {
    this.ctx.authorize("A", projectId);
    requireEntity(this.ctx, "Project", projectId);
    if (Object.keys(input).some((key) => key !== "tokens"))
      throw new ContractError("INVALID_ARGUMENT", "Unknown budget field");
    new SqliteBudgetLedger(this.ctx.database).setTokenLimit(
      this.ctx.workspaceId,
      projectId,
      input.tokens,
    );
    return this.get({ projectId });
  }
  get(query: UsageQuery = {}) {
    validate("UsageQuery", query);
    const { projectId, runId, model, since, until } = query;
    this.ctx.authorize("R", projectId);
    if (since && until && Date.parse(since) > Date.parse(until))
      throw new ContractError("INVALID_ARGUMENT", "Since must not exceed until");
    if (runId) {
      const run = requireEntity(this.ctx, "Run", runId);
      const test = requireEntity(this.ctx, "TestCase", String(run.testId));
      this.ctx.authorize("R", String(test.projectId));
      if (projectId && test.projectId !== projectId)
        throw new ContractError("INVALID_ARGUMENT", "Run is not in the selected project");
    }
    const calls = this.ctx.database
      .all<{ data_json: string; project_id: string }>(
        "SELECT data_json,project_id FROM model_calls WHERE workspace_id=? AND (? IS NULL OR project_id=?) AND (? IS NULL OR created_at>=?) AND (? IS NULL OR created_at<=?) ORDER BY created_at,id",
        this.ctx.workspaceId,
        projectId ?? null,
        projectId ?? null,
        since ?? null,
        since ?? null,
        until ?? null,
        until ?? null,
      )
      .filter((row) => {
        try {
          this.ctx.authorize("R", row.project_id);
          return true;
        } catch (error) {
          if (error instanceof ContractError && error.code === "FORBIDDEN") return false;
          throw error;
        }
      })
      .map((row) => JSON.parse(row.data_json) as ModelCallRecord)
      .filter((call) => (!runId || call.runId === runId) && (!model || call.model === model))
      .map((call) => {
        const { rawPrompt: _rawPrompt, ...redacted } = call;
        return redacted;
      });
    const reservations = this.ctx.database
      .all<{ project_id: string; state: string; estimate_json: string; cost_json: string | null }>(
        "SELECT project_id,state,estimate_json,cost_json FROM budget_reservations WHERE workspace_id=? AND (? IS NULL OR project_id=?)",
        this.ctx.workspaceId,
        projectId ?? null,
        projectId ?? null,
      )
      .filter((row) => {
        try {
          this.ctx.authorize("R", row.project_id);
          return true;
        } catch (error) {
          if (error instanceof ContractError && error.code === "FORBIDDEN") return false;
          throw error;
        }
      });
    const limit = projectId
      ? this.ctx.database.get<Money>(
          "SELECT amount,currency,scale FROM budget_limits WHERE workspace_id=? AND project_id=?",
          this.ctx.workspaceId,
          projectId,
        )
      : undefined;
    let remaining: Money | "unknown" | null = limit ? { ...limit } : null;
    let used = 0n;
    if (limit)
      for (const reservation of reservations) {
        if (reservation.state === "released") continue;
        const cost = JSON.parse(
          reservation.state === "reserved"
            ? reservation.estimate_json
            : (reservation.cost_json ?? '"unknown"'),
        ) as Money | "unknown";
        if (cost === "unknown" || cost.currency !== limit.currency || cost.scale !== limit.scale) {
          remaining = "unknown";
          break;
        }
        used += BigInt(cost.amount);
      }
    if (remaining && remaining !== "unknown")
      remaining.amount = (
        BigInt(remaining.amount) > used ? BigInt(remaining.amount) - used : 0n
      ).toString();
    const tokenBudget = projectId
      ? new SqliteBudgetLedger(this.ctx.database).tokenBudget(this.ctx.workspaceId, projectId)
      : null;
    const runs = this.ctx.database
      .all<{ project_id: string; run_id: string; storage_bytes: number }>(
        "SELECT t.project_id,a.run_id,SUM(a.bytes) AS storage_bytes FROM artifacts a JOIN runs r ON r.workspace_id=a.workspace_id AND r.id=a.run_id JOIN tests t ON t.workspace_id=r.workspace_id AND t.id=r.test_id WHERE a.workspace_id=? AND (? IS NULL OR t.project_id=?) AND (? IS NULL OR a.run_id=?) AND (? IS NULL OR a.created_at>=?) AND (? IS NULL OR a.created_at<=?) GROUP BY t.project_id,a.run_id",
        this.ctx.workspaceId,
        projectId ?? null,
        projectId ?? null,
        runId ?? null,
        runId ?? null,
        since ?? null,
        since ?? null,
        until ?? null,
        until ?? null,
      )
      .filter((row) => {
        try {
          this.ctx.authorize("R", row.project_id);
          return !model || calls.some((call) => call.runId === row.run_id);
        } catch (error) {
          if (error instanceof ContractError && error.code === "FORBIDDEN") return false;
          throw error;
        }
      })
      .map((row) => ({
        projectId: row.project_id,
        runId: row.run_id,
        storageBytes: row.storage_bytes,
        runtimeMs: calls
          .filter((call) => call.runId === row.run_id)
          .reduce((sum, call) => sum + call.latency, 0),
      }));
    return {
      query,
      calls,
      ...aggregateUsage(calls),
      runs,
      storageBytes: runs.reduce((sum, run) => sum + run.storageBytes, 0),
      lifetimeBudget: {
        scope: "project_lifetime",
        remaining,
        tokenBudget,
        reservations: {
          reserved: reservations.filter((row) => row.state === "reserved").length,
          settled: reservations.filter((row) => row.state === "settled").length,
          released: reservations.filter((row) => row.state === "released").length,
        },
      },
    };
  }
}
