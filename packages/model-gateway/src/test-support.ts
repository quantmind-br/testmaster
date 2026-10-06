import type {
  BudgetLedger,
  BudgetReservationInput,
  BudgetReservationResult,
  Cost,
  ModelCallRecord,
  ModelRequest,
  ProviderConfig,
  TokenUsage,
} from "./types.js";

/** Atomic synchronous mutation before any await: deterministic budget-race oracle. */
export class TestBudgetLedger implements BudgetLedger {
  spent = 0n;
  reserved = 0n;
  readonly reservations = new Map<string, Cost>();
  readonly settlements: { usage: TokenUsage; cost: Cost }[] = [];
  constructor(private readonly limit = 1_000_000n) {}
  async reserve(r: BudgetReservationInput): Promise<BudgetReservationResult> {
    const amount = r.estimate === "unknown" ? 1n : BigInt(r.estimate.amount);
    if (this.spent + this.reserved + amount > this.limit)
      return { ok: false, reasonCode: "budget_exhausted", remaining: "unknown" };
    const id = `reservation-${this.reservations.size}-${crypto.randomUUID()}`;
    this.reservations.set(id, r.estimate);
    this.reserved += amount;
    return { ok: true, reservationId: id };
  }
  async settle(id: string, usage: TokenUsage, cost: Cost): Promise<void> {
    const estimate = this.reservations.get(id);
    if (estimate === undefined) throw new Error("Unknown or already settled reservation");
    const held = estimate === "unknown" ? 1n : BigInt(estimate.amount);
    this.reserved -= held;
    this.spent += cost === "unknown" ? held : BigInt(cost.amount);
    this.reservations.delete(id);
    this.settlements.push({ usage, cost });
  }
  async release(id: string): Promise<void> {
    const estimate = this.reservations.get(id);
    if (estimate === undefined) throw new Error("Unknown reservation");
    this.reserved -= estimate === "unknown" ? 1n : BigInt(estimate.amount);
    this.reservations.delete(id);
  }
}

export const testProvider: ProviderConfig = {
  id: "fake",
  kind: "openai-compatible",
  baseUrl: "http://127.0.0.1/v1",
  apiKeyEnv: "FAKE_KEY",
  models: [
    { id: "model", capabilities: { structuredJson: true, toolCalls: true, maxOutputTokens: 1024 } },
  ],
};
export const testRequest: ModelRequest = {
  workspaceId: "workspace",
  projectId: "project",
  purpose: "normalize",
  provider: "fake",
  model: "model",
  messages: [{ role: "user", content: "Return Money JSON: amount 1, currency USD, scale 2." }],
  modelConfigHash: "config",
  promptVersion: "prompt-1",
  schemaVersion: "1.0.0",
  sourceRevisionIds: ["source-1"],
  inputRefs: ["source-1"],
  locale: "en",
  policyHash: "policy",
  responseSchema: "Money",
  maxOutputTokens: 128,
  deadlineMs: 5000,
  dataPolicy: {
    dataClasses: ["source"],
    maxInputBytes: 32_768,
    maxInputTokens: 32_768,
    allowUnknownCost: true,
  },
};
export const grantedConsent = {
  dataClasses: ["source"],
  allowUnknownCost: true,
  grantedAt: "2026-10-05T00:00:00Z",
  revokedAt: null,
};
export const completion = {
  model: "model",
  choices: [
    {
      message: {
        content: '{"amount":1,"currency":"USD","scale":2}',
        reasoning_content: "Checked required fields.",
      },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 20,
    completion_tokens: 10,
    completion_tokens_details: { reasoning_tokens: 3 },
  },
};
export type RecordedCalls = ModelCallRecord[];
