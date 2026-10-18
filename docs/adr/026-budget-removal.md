# ADR-026: Removal of budgets

- Status: accepted
- Date: 2026-10-18
- Amends: [ADR-024](024-consent-removal.md) (decision 2 and the budget clauses of decision 1 and its consequences), [ADR-007](007-structured-output.md) (budget reservation before a model call)
- Scope: model gateway, usage ledger, code generation, exploration, agent mode, runner, schedules, alerts, settings, the evaluation harness and the specifications that required budgets.

## Context

Several features capped spending or usage and refused, paused, skipped or stopped work once the cap was reached: a cumulative project token quota, a monetary project ceiling (with no surface able to set it), a reservation before every model call that was refused when it did not fit, per-command model-call caps in code generation and exploration, a hard cap of 50 action-resolution calls in agent mode, an agent request counter in the runner, daily firing and run caps on schedules, and token and call caps in the evaluation harness and the replay smoke. The operator decided that none of them should exist: the user decides that the work is to be done, and a budget can only interrupt it midway. This applies the premise that a safeguard whose only effect is to interrupt progressing work has no benefit (AGENTS.md).

## Decision

1. **No budget refuses work.** No code path refuses, pauses, skips or stops work because a count of tokens, money, model calls, requests, firings or runs was reached. The removed surfaces are deleted, not turned into no-ops: `testmaster budget set`, `POST /v1/projects/{id}/budget`, `TokenBudgetInput`, the portal token-budget form, `--max-model-calls`, `budget.modelCalls` of `testmaster_explore`, the `budget` argument of `testmaster_generate_tests`, `--max-fires-per-day`, `--max-runs-per-day`, the schedule `budget` object and the `budget_exhausted` alert.
2. **Accounting stays.** `budget_reservations`, `model_calls` and `usage_entries` keep recording each call: a reservation is opened before the call, settled with the measured usage or released. It is a ledger record, never an admission check. Cost of an unpriced model is `unknown`, never zero. `testmaster usage` reports reservations, tokens, cost, runtime and storage.
3. **Limits that protect a named resource stay.** They are not budgets: the two concurrent model compute slots per project (`QUOTA_EXCEEDED`, `reasonCode: quota_exceeded`), context-window and payload admission, the upload backlog, the storage reserve, the MCP session cap, API rate limits, the exploration `steps` and `timeMs` envelope on untrusted targets (its clock pauses while a model answer is pending), DOM candidate caps and resource page sizes. The schedule failure breaker `autoPauseAfterFailures` stays; it moves out of the removed `budget` object to a top-level schedule field.
4. **Agent boundary.** The runner still refuses a non-action step in an agent flow with `security_precondition_failed`; only the request counter is gone.
5. **Storage.** Migration 24 drops `token_budget_limits` and `budget_limits`. Schedule revisions are immutable and unvalidated JSON, so revisions saved with a `budget` object are mapped when read (the failure limit is kept, the daily caps are ignored) and their bytes are not rewritten. `budget_exhausted` stays a readable value of the persisted reason enums; no code produces it.
6. **Evaluation.** Registrations carry no budget: the token budget and the preregistered wall-clock deadline `maxWallTimeMs` are both removed. The eval runners never kill a command, never refuse the next command and never skip a trial for elapsed time; only an explicit cancellation of the evaluation stops it. Frozen registrations that still contain `budget` parse unchanged and are never rewritten; the field is ignored.

## Consequences

- A user who wants to bound spending does so outside TestMaster, at the provider account or by removing a provider from `allowedModelProviders`. TestMaster records what was spent and never stops a call for it.
- A schedule that fires too often is corrected by editing or pausing it; it is no longer skipped silently after a daily count.
- Historical evidence is immutable: results under `validation/results`, `evals/results` and `evals/rounds`, frozen registrations, earlier changelog entries and applied migrations 1–23 keep their budget wording and tables. Registry items that described budgets are reconciled in the registry, not in the evidence.

## Authority

[SPEC](../../SPEC.md), [requirements](../../specs/01-requirements.md), [operations](../../specs/08-operations.md), [validation](../../specs/10-validation.md). This record describes a decision, not proof that every control has passed acceptance.