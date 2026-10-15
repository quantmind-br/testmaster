import { randomUUID } from "node:crypto";
import { ContractError } from "@testmaster/contracts";
import { canonicalJson } from "@testmaster/domain";
import type { PersistenceDatabase } from "./database.js";

export interface Money {
  amount: string;
  currency: string;
  scale: number;
}
export interface BudgetReserveRequest {
  workspaceId: string;
  projectId: string;
  purpose: string;
  provider: string;
  model: string;
  estimate: Money | "unknown";
  idempotencyKey: string;
  reservedTokens?: number;
}
export type BudgetReserveResult =
  | { ok: true; reservationId: string }
  | { ok: false; reasonCode: "budget_exhausted"; remaining: Money | "unknown" };
export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens?: number | null;
}
export interface BudgetLedger {
  reserve(request: BudgetReserveRequest): Promise<BudgetReserveResult>;
  settle(reservationId: string, usage: TokenUsage, cost: Money | "unknown"): Promise<void>;
  release(reservationId: string, reason: string): Promise<void>;
}
export interface ValidationFailureSummary {
  code: string;
  message: string;
  issues: { path: string; rule: string; message: string }[];
  omittedIssues: number;
}
export interface ModelCallRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  createdAt: string;
  purpose: string;
  provider: string;
  model: string;
  promptHash: string;
  modelConfigHash?: string;
  sourceRevisionIds?: string[];
  runId?: string;
  inputRefs: string[];
  usage: TokenUsage;
  cost: Money | "unknown";
  priceTableVersion?: string | null;
  costBasis?: "estimated" | "unknown" | "not_billed";
  latency: number;
  outcome: "success" | "invalid" | "failed" | "cancelled";
  cacheHit: boolean;
  repairAttempt: number;
  transportAttempt: number;
  reservationId: string | null;
  responseHash: string | null;
  finishReason: string | null;
  failureReason?: "output_truncated" | "content_filtered";
  validationFailure?: ValidationFailureSummary;
  rawPrompt?: string;
}
export interface ModelCallRecorder {
  record(call: ModelCallRecord): Promise<void>;
}
function integerMoney(value: Money): bigint {
  if (
    !/^\d+$/u.test(value.amount) ||
    !/^[A-Z]{3}$/u.test(value.currency) ||
    !Number.isInteger(value.scale) ||
    value.scale < 0 ||
    value.scale > 18
  )
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Money must use nonnegative integer amount, ISO currency and scale 0–18",
    );
  return BigInt(value.amount);
}
export class SqliteBudgetLedger implements BudgetLedger {
  constructor(readonly database: PersistenceDatabase) {}
  setLimit(workspaceId: string, projectId: string, limit: Money): void {
    integerMoney(limit);
    this.database.withTx(() => {
      const existing = this.database.get(
        "SELECT currency,scale FROM budget_limits WHERE workspace_id=? AND project_id=?",
        workspaceId,
        projectId,
      );
      if (
        existing &&
        (existing.currency !== limit.currency || Number(existing.scale) !== limit.scale)
      )
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Budget currency and scale cannot change while accounting exists",
        );
      this.database.run(
        "INSERT INTO budget_limits(workspace_id,id,created_at,project_id,currency,scale,amount) VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace_id,project_id) DO UPDATE SET amount=excluded.amount",
        workspaceId,
        randomUUID(),
        new Date().toISOString(),
        projectId,
        limit.currency,
        limit.scale,
        limit.amount,
      );
    });
  }
  setTokenLimit(workspaceId: string, projectId: string, tokens: number): void {
    if (!Number.isSafeInteger(tokens) || tokens < 0)
      throw new ContractError("INVALID_ARGUMENT", "Token quota must be a nonnegative safe integer");
    this.database.run(
      "INSERT INTO token_budget_limits(workspace_id,project_id,tokens) VALUES(?,?,?) ON CONFLICT(workspace_id,project_id) DO UPDATE SET tokens=excluded.tokens",
      workspaceId,
      projectId,
      tokens,
    );
  }
  /** Cumulative project token quota; `limit: null` means the operator configured none. */
  tokenBudget(workspaceId: string, projectId: string) {
    const limit =
      this.database.get<{ tokens: number }>(
        "SELECT tokens FROM token_budget_limits WHERE workspace_id=? AND project_id=?",
        workspaceId,
        projectId,
      )?.tokens ?? null;
    const used =
      this.database.get<{ tokens: number }>(
        "SELECT COALESCE(SUM(CASE WHEN state='reserved' THEN reserved_tokens ELSE COALESCE(charged_tokens,CASE WHEN json_type(usage_json,'$.inputTokens')='integer' AND json_type(usage_json,'$.outputTokens')='integer' THEN CAST(json_extract(usage_json,'$.inputTokens') AS INTEGER)+CAST(json_extract(usage_json,'$.outputTokens') AS INTEGER) ELSE CASE WHEN reserved_tokens=0 THEN 100000 ELSE reserved_tokens END END) END),0) AS tokens FROM budget_reservations WHERE workspace_id=? AND project_id=? AND state<>'released'",
        workspaceId,
        projectId,
      )?.tokens ?? 0;
    return { limit, used, remaining: limit === null ? null : Math.max(0, limit - used) };
  }
  async reserve(request: BudgetReserveRequest): Promise<BudgetReserveResult> {
    if (request.estimate !== "unknown") integerMoney(request.estimate);
    const tokens = request.reservedTokens ?? 0;
    if (!Number.isSafeInteger(tokens) || tokens < 0)
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Reserved tokens must be a nonnegative safe integer",
      );
    return this.database.withTx(() => {
      const existing = this.database.get(
        "SELECT id,state,data_json FROM budget_reservations WHERE workspace_id=? AND project_id=? AND idempotency_key=?",
        request.workspaceId,
        request.projectId,
        request.idempotencyKey,
      );
      if (existing) {
        if (existing.data_json !== canonicalJson(request) || existing.state !== "reserved")
          throw new ContractError(
            "IDEMPOTENCY_CONFLICT",
            "Budget reservation key is changed or already consumed",
          );
        return { ok: true, reservationId: String(existing.id) };
      }
      const active =
        this.database.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM budget_reservations WHERE workspace_id=? AND project_id=? AND state='reserved'",
          request.workspaceId,
          request.projectId,
        )?.count ?? 0;
      if (active >= 2) return { ok: false, reasonCode: "budget_exhausted", remaining: "unknown" };
      const tokenRemaining = this.tokenBudget(request.workspaceId, request.projectId).remaining;
      if (tokenRemaining !== null && tokens > tokenRemaining)
        return { ok: false, reasonCode: "budget_exhausted", remaining: "unknown" };
      const limit = this.database.get<{ amount: string; currency: string; scale: number }>(
        "SELECT amount,currency,scale FROM budget_limits WHERE workspace_id=? AND project_id=?",
        request.workspaceId,
        request.projectId,
      );
      if (limit) {
        if (request.estimate === "unknown")
          return { ok: false, reasonCode: "budget_exhausted", remaining: "unknown" };
        if (request.estimate.currency !== limit.currency || request.estimate.scale !== limit.scale)
          throw new ContractError("INVALID_ARGUMENT", "Budget currencies and scales must match");
        const rows = this.database.all<{
          state: string;
          estimate_json: string;
          cost_json: string | null;
        }>(
          "SELECT state,estimate_json,cost_json FROM budget_reservations WHERE workspace_id=? AND project_id=? AND state<>'released'",
          request.workspaceId,
          request.projectId,
        );
        let used = 0n;
        for (const row of rows) {
          const cost = JSON.parse(
            row.state === "reserved" ? row.estimate_json : (row.cost_json ?? '"unknown"'),
          ) as Money | "unknown";
          if (cost === "unknown")
            return { ok: false, reasonCode: "budget_exhausted", remaining: "unknown" };
          if (cost.currency !== limit.currency || cost.scale !== limit.scale)
            throw new ContractError(
              "INVALID_ARGUMENT",
              "Stored usage denomination differs from budget",
            );
          used += integerMoney(cost);
        }
        const remaining = BigInt(limit.amount) > used ? BigInt(limit.amount) - used : 0n;
        if (integerMoney(request.estimate) > remaining)
          return {
            ok: false,
            reasonCode: "budget_exhausted",
            remaining: {
              amount: remaining.toString(),
              currency: limit.currency,
              scale: limit.scale,
            },
          };
      }
      const reservationId = randomUUID();
      this.database.run(
        "INSERT INTO budget_reservations(workspace_id,id,created_at,project_id,purpose,provider,model,estimate_json,idempotency_key,state,data_json,reserved_tokens) VALUES(?,?,?,?,?,?,?,?,?,'reserved',?,?)",
        request.workspaceId,
        reservationId,
        new Date().toISOString(),
        request.projectId,
        request.purpose,
        request.provider,
        request.model,
        canonicalJson(request.estimate),
        request.idempotencyKey,
        canonicalJson(request),
        tokens,
      );
      return { ok: true, reservationId };
    });
  }
  async settle(reservationId: string, usage: TokenUsage, cost: Money | "unknown"): Promise<void> {
    if (cost !== "unknown") integerMoney(cost);
    for (const value of Object.values(usage))
      if (value !== null && (!Number.isSafeInteger(value) || value < 0))
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Token counts must be null or nonnegative integers",
        );
    this.database.withTx(() => {
      const row = this.database.get("SELECT * FROM budget_reservations WHERE id=?", reservationId);
      if (!row) throw new ContractError("NOT_FOUND", "Budget reservation not found");
      if (
        row.state === "settled" &&
        row.cost_json === canonicalJson(cost) &&
        row.usage_json === canonicalJson(usage)
      )
        return;
      if (row.state !== "reserved")
        throw new ContractError("IDEMPOTENCY_CONFLICT", "Reservation already settled or released");
      const estimate = JSON.parse(String(row.estimate_json)) as Money | "unknown";
      if (
        cost !== "unknown" &&
        estimate !== "unknown" &&
        (cost.currency !== estimate.currency || cost.scale !== estimate.scale)
      )
        throw new ContractError("INVALID_ARGUMENT", "Settlement denomination mismatch");
      this.database.run(
        "UPDATE budget_reservations SET state='settled',cost_json=?,usage_json=?,charged_tokens=? WHERE id=? AND state='reserved'",
        canonicalJson(cost),
        canonicalJson(usage),
        usage.inputTokens === null || usage.outputTokens === null
          ? Number(row.reserved_tokens)
          : usage.inputTokens + usage.outputTokens,
        reservationId,
      );
      this.database.run(
        "INSERT INTO usage_entries(workspace_id,id,created_at,project_id,reservation_id,cost_json,usage_json) VALUES(?,?,?,?,?,?,?)",
        row.workspace_id,
        randomUUID(),
        new Date().toISOString(),
        row.project_id,
        reservationId,
        canonicalJson(cost),
        canonicalJson(usage),
      );
    });
  }
  async release(reservationId: string, reason: string): Promise<void> {
    this.database.withTx(() => {
      const row = this.database.get(
        "SELECT state,release_reason FROM budget_reservations WHERE id=?",
        reservationId,
      );
      if (row?.state === "released" && row.release_reason === reason) return;
      if (row?.state !== "reserved")
        throw new ContractError("IDEMPOTENCY_CONFLICT", "Unknown or consumed reservation");
      this.database.run(
        "UPDATE budget_reservations SET state='released',release_reason=? WHERE id=?",
        reason,
        reservationId,
      );
    });
  }
}
export class SqliteModelCallRecorder implements ModelCallRecorder {
  constructor(readonly database: PersistenceDatabase) {}
  async record(call: ModelCallRecord): Promise<void> {
    this.database.withTx(() => {
      this.database.run(
        "INSERT INTO model_calls(workspace_id,id,created_at,project_id,purpose,provider,model,prompt_hash,latency,outcome,reservation_id,cache_hit,repair_attempt,data_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        call.workspaceId,
        call.id,
        call.createdAt,
        call.projectId,
        call.purpose,
        call.provider,
        call.model,
        call.promptHash,
        call.latency,
        call.outcome,
        call.reservationId,
        Number(call.cacheHit),
        call.repairAttempt,
        canonicalJson(call),
      );
    });
  }
}
