import type { ReasoningEffort } from "@testmaster/contracts";

export type { ReasoningEffort };
export interface MoneyAmount {
  amount: string;
  currency: string;
  scale: number;
}
export type Cost = MoneyAmount | "unknown";
export interface BudgetReservationInput {
  workspaceId: string;
  projectId: string;
  purpose: string;
  provider: string;
  model: string;
  estimate: Cost;
  idempotencyKey: string;
  reservedTokens?: number;
}
export type BudgetReservationResult =
  | { ok: true; reservationId: string }
  | { ok: false; reasonCode: "budget_exhausted"; remaining: Cost };
export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens?: number | null;
}
export interface BudgetLedger {
  reserve(r: BudgetReservationInput): Promise<BudgetReservationResult>;
  settle(reservationId: string, usage: TokenUsage, cost: Cost): Promise<void>;
  release(reservationId: string, reason: string): Promise<void>;
}
/**
 * Bounded, scrubbed account of why a model response failed local validation. It carries schema
 * paths, rule names and validator messages only, never model output text.
 */
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
  cost: Cost;
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
export interface ModelCapabilities {
  structuredJson?: boolean;
  toolCalls?: boolean;
  vision?: boolean;
  contextTokens?: number;
  maxOutputTokens?: number;
}
export interface ModelPrice {
  currency: string;
  scale: number;
  inputPerMillion: string;
  outputPerMillion: string;
  version: string;
  /** Optional rate for provider-reported cached input tokens; absent prices them as input. */
  cacheReadPerMillion?: string;
}
export interface ProviderConfig {
  id: string;
  kind: "openai-compatible";
  baseUrl: string;
  apiKeyEnv: string;
  models: { id: string; capabilities: ModelCapabilities; reasoningEffort?: ReasoningEffort }[];
  prices?: Record<string, ModelPrice>;
}
export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface ModelTool {
  name: string;
  description: string;
  argumentsSchema: string;
}
export interface ModelToolCall {
  id: string;
  name: string;
  arguments: unknown;
}
export interface ModelRequest {
  workspaceId: string;
  projectId: string;
  runId?: string;
  purpose:
    | "summarize"
    | "normalize"
    | "plan"
    | "resolve_action"
    | "generate_code"
    | "classify"
    | "analyze"
    | "heal";
  provider: string;
  model: string;
  messages: ModelMessage[];
  modelConfigHash: string;
  promptVersion: string;
  schemaVersion: string;
  sourceRevisionIds: string[];
  inputRefs: string[];
  locale: string;
  policyHash: string;
  responseSchema?: string;
  tools?: ModelTool[];
  requiredCapabilities?: (keyof ModelCapabilities)[];
  /**
   * Semantic validation of the schema-valid output (grounding, policy, importability). It throws
   * a ContractError, whose `issues` become repair feedback and a bounded recorded validation
   * failure, exactly like a schema violation. Any other error is a defect and is not repaired.
   */
  check?: (output: unknown) => Promise<void> | void;
  reasoningEffort?: ReasoningEffort;
  dataPolicy: {
    dataClasses: string[];
    maxInputBytes: number;
    maxInputTokens: number;
    recordRawPrompt?: boolean;
    secrets?: string[];
  };
  /** Caller cancellation; a model request has no deadline and is never cut by elapsed time. */
  signal?: AbortSignal;
  cache?: boolean;
}
export interface ModelResult<T = unknown> {
  modelCallId: string;
  output: T;
  toolCalls: ModelToolCall[];
  reasoningContent: string | null;
  usage: TokenUsage;
  cost: Cost;
  latency: number;
  finishReason: string | null;
  responseHash: string;
  resolvedModel: string;
  cacheHit: boolean;
  warnings: string[];
}
export interface ModelCache {
  get(key: string): Promise<ModelResult | null>;
  set(key: string, value: ModelResult): Promise<void>;
}
export interface GatewayOptions {
  providers: ProviderConfig[];
  allowedProviders: string[];
  allowedEndpoints: string[];
  budgetLedger: BudgetLedger;
  recorder: ModelCallRecorder;
  cache?: ModelCache;
  env?: (name: string) => string | undefined;
  maxResponseBytes?: number;
}
