import { ContractError } from "@testmaster/contracts";
import type { ModelCallRecord, Money } from "@testmaster/persistence";
import type { ServiceContext } from "../context.js";
export class UsageService {
  constructor(readonly ctx: ServiceContext) {}
  get(projectId?: string, since?: string) {
    this.ctx.authorize("R", projectId);
    if (since && !Number.isFinite(Date.parse(since)))
      throw new ContractError("INVALID_ARGUMENT", "Since must be an RFC3339 timestamp");
    const calls = this.ctx.database
      .all<{ data_json: string; project_id: string }>(
        "SELECT data_json,project_id FROM model_calls WHERE workspace_id=? AND (? IS NULL OR project_id=?) AND (? IS NULL OR created_at>=?) ORDER BY created_at,id",
        this.ctx.workspaceId,
        projectId ?? null,
        projectId ?? null,
        since ?? null,
        since ?? null,
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
      .map((row) => JSON.parse(row.data_json) as ModelCallRecord);
    const tokenTotals = {
      inputTokens: 0 as number | null,
      outputTokens: 0 as number | null,
      reasoningTokens: 0 as number | null,
    };
    const costs: Record<string, Money> = {};
    let unknownCostCalls = 0;
    for (const call of calls) {
      for (const key of ["inputTokens", "outputTokens", "reasoningTokens"] as const)
        tokenTotals[key] =
          tokenTotals[key] === null || call.usage[key] === null
            ? null
            : tokenTotals[key] + call.usage[key];
      if (call.cost === "unknown") unknownCostCalls++;
      else {
        const key = `${call.cost.currency}:${call.cost.scale}`;
        costs[key] = {
          ...call.cost,
          amount: (BigInt(costs[key]?.amount ?? "0") + BigInt(call.cost.amount)).toString(),
        };
      }
    }
    let remaining: Money | "unknown" | null = null;
    const limit = projectId
      ? this.ctx.database.get<{ amount: string; currency: string; scale: number }>(
          "SELECT amount,currency,scale FROM budget_limits WHERE workspace_id=? AND project_id=?",
          this.ctx.workspaceId,
          projectId,
        )
      : undefined;
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
    if (limit) {
      let used = 0n;
      remaining = { ...limit };
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
      if (remaining !== "unknown")
        remaining.amount = (
          BigInt(limit.amount) > used ? BigInt(limit.amount) - used : 0n
        ).toString();
    }
    return {
      calls,
      tokens: tokenTotals,
      cost: unknownCostCalls ? "unknown" : Object.values(costs),
      measuredCosts: Object.values(costs),
      unknownCostCalls,
      budgetRemaining: remaining,
      reservations: {
        reserved: reservations.filter((row) => row.state === "reserved").length,
        settled: reservations.filter((row) => row.state === "settled").length,
        released: reservations.filter((row) => row.state === "released").length,
      },
      runtimeMs: null,
      storageBytes: null,
    };
  }
}
