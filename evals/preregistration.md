# Preregistered experimental M2 model evaluation

**Status: not executed.** This document and `preregistration.json` must be committed by the orchestrator before any model or Docker trial. Phase 1 runs scoring unit tests only. No `PREREGISTERED` marker is used. Phase 2 requires an explicit “go phase 2” and the actual preregistration commit hash.

## Frozen corpus and split

The authoritative machine-readable design is [preregistration.json](preregistration.json). The corpus is [corpus/manifest.json](corpus/manifest.json), raw-byte SHA-256 `016dfc28cb5030abac53839c279b3161952e663b0dac9fa02e6a64776ec79e16`. Input documents, oracle and prompt-bearing implementation files also have raw-byte hashes; the harness refuses changed files before live calls. Corpus manifest labels are not model input and are not silently relabelled.

There is **one application family**, `reference-shop`. Holdout across families is **not possible**. Mutant-level split/order is frozen by sorting hex SHA-256 of `testmaster-m2-eval-2026-10-05:<caseId>`:

| Order | Case | Mutant | Split |
|---|---|---|---|
| 1 | shop-defect-004 | price-rounding | development |
| 2 | shop-defect-001 | no-password-validation | development |
| 3 | shop-defect-002 | toast-without-persist | development |
| 4 | shop-defect-006 | schema-field-renamed | development |
| 5 | shop-defect-007 | pagination-skip | development |
| 6 | shop-defect-008 | idempotency-ignored | development |
| 7 | shop-defect-003 | health-degraded | mutant-level holdout |
| 8 | shop-defect-005 | orders-auth-bypass | mutant-level holdout |

The baseline is a paired control, not a ninth defect trial. Selector drift is M3/nonfunctional and outside this business-defect pilot. Holdout shares the full application documents and generation procedure: it cannot establish unseen-family generalization. All trials use unchanged full PRD/OpenAPI; no target labels, oracle code/verdicts or application implementation are sent to the model. No development-result tuning precedes holdout.

Corpus labels and the intentional empty-cart conflict still lack independent human review. The manifest currently says all cases are development and not benchmark-eligible; the preregistration defines a separate immutable pilot split, not a claim that those corpus review prerequisites have been met. This run is an exploratory **independent-code-oracle evaluation**, not a human-adjudicated release benchmark. Conflicting requirements remain unapproved rather than inventing two human reviewers.

## Configuration actually sent

Provider `quantforge`, OpenAI-compatible endpoint `https://api.quantforge.com.br/v1`, model `deepseek-v4.1-flash`; secret comes only from `QUANTFORGE_API_KEY`. Configuration/allowlist are user-HOME scoped, with explicit project consent before sources leave the machine.

Inspection of `packages/application/src/ai/model.ts` and `packages/model-gateway/src/gateway.ts` fixes:

- `temperature: 0`, `max_tokens: 8192`, `response_format: {type: "json_object"}`.
- `top_p`, `seed`, `tools`, and `reasoning_effort` are **omitted**, not claimed as explicit settings.
- Prompt versions `normalize-1`, `plan-1`; response schema version `1.0.0`.
- 180,000 ms model deadline; max input bytes 1,048,576 and conservative input tokens 100,000; max two structural repairs and one transport retry per repair only without usable response.
- Local shared strict Ajv validation plus semantic proposal validation; no model/provider substitution.
- Fresh HOME/project per trial, no shared cache. Temperature zero does not guarantee deterministic remote results. Remote weight snapshot/fingerprint may be unavailable; existing ModelCall metadata is retained without fabricated fingerprints.

No provider prices are declared. Monetary cost stays **unknown**, never zero; measured input/output/reasoning tokens, call latency, repairs, retries, cache flags and outcomes are retained through `usage`.

## Pipeline and independent scoring

Each trial first runs its independent raw-HTTP/read-only-SQLite oracle on separate fresh healthy and mutant instances. These verdicts never enter the AI input. It then uses the **built CLI**:

1. Fresh local project, declared provider/allowlist and consent.
2. `source add` unchanged PRD/OpenAPI; `discover --scope codebase` over documents only.
3. `requirement normalize` both revisions. A separate rule-based evaluator requires `originKind=user_spec`, source-revision grounding, nonempty acceptance criteria and no unresolved conflicts. Sort text then ID; approve at most the first 12. Record every decision and cap exclusion before generation. This is not independent human semantic intent review.
4. `plan generate --type backend` once per approved requirement. Accept all locally validated executable proposals, unchanged, without choosing by outcomes. Failed generation receives an error record, not an invented proposal count or a retry.
5. For every accepted immutable revision, `test run --mode replay --heal off --max-attempts 1 --wait` on a fresh healthy instance and fresh mutant instance. Docker only; no process fallback. Record full command envelopes/exit codes, Run/revision IDs, step results, events and verified artifacts. Accepted plans are never edited.

**Primary:** detected mutants / **all eight planned trials**. Credit requires a same accepted revision with healthy `outcome=passed` and `gate=passed`, mutant `outcome=failed`, a required assertion failure (`assertion_failed`), plus independent healthy/defect oracle confirmation. Action errors, transport errors, timeouts, missing runs and passing baselines with failed cleanup gates cannot earn detection credit.

The oracle does not depend on TestMaster or the generating LLM. The structural evaluator alone never establishes behavioral success. Inferential generation failures and unobserved cases remain primary misses.

Secondary metrics:

- False failure rate on healthy: failed healthy replays / healthy replays with passed or failed outcomes; unavailable outcomes separately.
- Valid returned proposals / all returned proposals; failed schema generation without a returned proposal count is an error and an unavailable raw-proposal denominator, not 0% or 100% fabricated validity.
- Measured tokens and monetary known/unknown costs, conservative charged token budget, monotonic command/trial/wall durations.
- Per-case, failure-category, development/holdout strata. Calls/proposals never inflate primary trial n.

## Budget, exclusions and stopping

Census: **8 trials, one per each of eight M0–M2 business mutants**; only one independent application-family cluster. This is below the normative 30-family exploratory and 100-case/three-trial comparative guidance. It is a feasibility/coverage pilot, not a powered quality comparison.

Cap: **12,000,000 input+output tokens and 7,200,000 ms wall time**. Before each model CLI command reserve `6 × (100000 + 8192) = 649152` tokens, including bounded repairs/retries. Settle to measured provider usage after each command; unknown usage retains the conservative charge. Reasoning tokens are reported separately, not double-counted with output. The harness stops before a reservation that could exceed the remaining cap. Model deadlines and command cancellation constrain wall time; finalization allows bounded evidence/usage collection after cancellation.

Stop only after all scheduled trials, budget/deadline, missing key, or an unsafe condition, never after desirable/undesirable scores. No replacement trials, outer pipeline retries or post-result exclusion changes. Unstarted cases still have ledgers and remain primary misses. Unsafe conditions require operator interruption and a recorded safety decision; no automatic safety certification is implied.

Only the **conditional** denominator may exclude explicit substantiated `oracle_error`, `oracle_mismatch`, `sandbox_unavailable`, `worker_lost`, `provider_transport`, `provider_timeout`, `budget_exhausted`, `wall_time_exhausted`, `missing_key` or `not_started`. Unknown `INTERNAL`/precondition failures, policy denials, invalid generation/proposals, no accepted tests, unresolved conflicts and generated action/assertion failures are not infrastructure exclusions. Exit code alone is insufficient. Errors and exclusions retain structured command/verdict evidence. Product/fixture bugs cannot be hidden by deleting cases.

## Statistics and experimental graduation

Use two-sided Wilson 95% intervals (`z=1.96`) for proportions. Zero denominators yield `insufficientData`, with null estimate/bounds. Because cases share a family, intervals are descriptive and must not be represented as independent-family population bounds. Report n planned, conditional n, errors, exclusions, truncation and independent-family count explicitly. No parity, rare-event, p99, or universal-generalization claim.

Predeclared graduation requires at least 30 independently held-out families, 100 independent cases and three trials/case; primary and holdout lower Wilson bounds ≥0.80; healthy false-failure upper bound ≤0.05; independent human labels and no critical safety failure. This eight-trial single-family pilot cannot satisfy prerequisites, even at 8/8. Capabilities therefore remain **experimental**.

## Running after the handshake

The orchestrator owns builds, formatting, integration checks and the preregistration commit. Phase 1 scoring-only check:

```sh
pnpm exec vitest run --project unit tools/src/evals/scoring.test.ts
```

After “go phase 2”, build the tools/CLI if stale, then:

```sh
node tools/dist/evals/run.js --execute-preregistered <actual-preregistration-commit-hash>
```

The explicit flag/commit records authorization provenance; it is not cryptographic proof of git history. The runner never invokes git. It writes `evals/results/<runId>/trial-*.json`, retained evidence and round reports, plus `evals/results/report.json` and `report.md`. Temporary isolated workspaces are kept for diagnosis and are not a generated-test passing claim. Do not put this runner into ordinary unit tests or execute it before preregistration is committed.
