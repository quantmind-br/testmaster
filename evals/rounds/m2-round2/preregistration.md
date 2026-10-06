# Preregistered experimental M2 model evaluation — Round 2

**Status: preregistered, not executed; provider dependency blocked.** Candidate product/harness/fixture hashes are frozen in `preregistration.json` and validated offline before commit. Round 1 results remain frozen under `evals/results/m2-reference-shop-2026-10-05-2026-10-05T23-14-51-858Z/` (preregistration commit `f37c3604399446e34a97c763dd0a507b4349660f`). Round 2 does not edit or replace Round 1 registration/results. Phase 2 requires the exact committed Round 2 registration hash, explicit authorization and restoration of the designated model.

## Execution dependency status: blocked

The designated evaluation model `deepseek-v4.1-flash` at provider `quantforge` (`https://api.quantforge.com.br/v1`) was withdrawn by the upstream provider. Authenticated check of `/v1/models` (HTTP 200) confirmed `present: false`, recorded with evidence in `validation/results/model-provider-inventory.json`.

In compliance with project invariants and experimental evaluation rules:
- **No model substitution is permitted.** (No unvetted or alternative model is substituted).
- **No live trials may be initiated** while the assigned model is absent.
- The evaluation pipeline and harness are prepared and offline validated only.
- Execution remains **blocked** on external model restoration by the provider.

## Round 1 retrospective and disclosures

Round 1 was executed on 2026-10-05 with the built real CLI and hardened Docker executor across all 8 defect cases:
- Primary score: 0/8 detected (0.0%, Wilson 95% [0.0%, 32.4%]).
- All 8 independent oracle pairs confirmed healthy and defective ground truth.
- 7 pipelines failed requirement normalization: 22 of 23 model calls hit the 8,192 output token limit with `finishReason: length`. The Round 1 gateway misclassified truncation as schema-invalid and repeated 2 structural repairs that predictably re-truncated.
- 1 pipeline (Trial 03) successfully extracted 17 valid requirements, all with contract-valid `originKind: explicit`. The Round 1 harness filter strictly checked `originKind === "user_spec"`, rejecting all 17 valid requirements and producing a false `no_approved_requirements` failure.
- Zero plan-generation, acceptance, or test replays were executed in Round 1. Zero TestMaster runs were created.
- 8 `evidence_copy_unavailable` errors were recorded because the `.testmaster/runs` directory was missing on disk; this was a harness collector artifact, not evidence loss from executed attempts.

### Round 1-informed pipeline and harness fixes

Round 2 incorporates six specific fixes directly informed by Round 1 evidence:
1. **Model gateway truncation handling:** Completions with `finishReason: length` or `finishReason: content_filter` are classified as `failed` with reason code `output_truncated` / `content_filtered` and stop immediately without blind repair attempts (`packages/model-gateway/src/gateway.ts`).
2. **Chunked requirement normalization:** Source chunks are partitioned into bounded batches of at most 6 chunks or 6,000 canonical UTF-8 bytes (`packages/application/src/ai/normalization.ts`). After batch extraction, a separate source-grounded reconciliation call identifies cross-source conflicts between normalized statements and original source chunks.
3. **Amended origin filter:** The evaluation rule-based reviewer accepts contract-valid `originKind` in `{"explicit", "user_spec"}` with source-revision grounding, nonempty acceptance criteria, and no unresolved conflicts (`tools/src/evals/run.ts`). Inferred and observed requirements remain rejected.
4. **Unknown-cost consent and cumulative token budget:** Trial initialization grants explicit consent via `consent grant --allow-unknown-cost` and enforces the cumulative project token limit via `budget set --tokens 12000000` (`apps/cli/src/usage.ts`, `tools/src/evals/run.ts`).
5. **Accurate evidence collector:** When zero test runs were executed and `.testmaster/runs` is absent on disk, the collector records `no_attempts` rather than fabricated `evidence_copy_unavailable`. Real copy failures when runs exist continue to be reported as `evidence_copy_unavailable` (`tools/src/evals/run.ts`).
6. **Conservative normalization reservation:** Normalization command reserves 4,544,064 tokens (`7 * 6 * (100,000 + 8,192)`) before execution, accounting for 6 extraction batches and 1 reconciliation call, and settles to measured usage upon completion (`tools/src/evals/run.ts`).

### Mutant holdout disclosure

In Round 1, the mutant-level holdout partition consisted of `shop-defect-003` (health-degraded) and `shop-defect-005` (orders-auth-bypass). Because Round 1 was executed and analyzed across all 8 cases, **the mutant holdout is no longer unseen**.

Round 2 retains the exact same split and execution order for descriptive continuity, but **makes no validation holdout or unseen-family generalization claims**. All 8 trials share a single application family (`reference-shop`). Results are descriptive of pipeline yield on this specific corpus.

## Corpus and split

Authorized dataset manifest: `evals/corpus/manifest.json`, raw-byte SHA-256 `016dfc28cb5030abac53839c279b3161952e663b0dac9fa02e6a64776ec79e16`.

Split algorithm: Ascending hex SHA-256 of `testmaster-m2-eval-2026-10-05:<caseId>`:

| Order | Trial | Case ID | Mutant | Strata | Split role |
|---|---|---|---|---|---|
| 1 | trial-01 | shop-defect-004 | price-rounding | business-calculation | development |
| 2 | trial-02 | shop-defect-001 | no-password-validation | authentication | development |
| 3 | trial-03 | shop-defect-002 | toast-without-persist | persistence | development |
| 4 | trial-04 | shop-defect-006 | schema-field-renamed | contract | development |
| 5 | trial-05 | shop-defect-007 | pagination-skip | pagination | development |
| 6 | trial-06 | shop-defect-008 | idempotency-ignored | idempotency | development |
| 7 | trial-07 | shop-defect-003 | health-degraded | health | holdout (observed in R1) |
| 8 | trial-08 | shop-defect-005 | orders-auth-bypass | authorization | holdout (observed in R1) |

## Model and decoding configuration

- Provider: `quantforge`, OpenAI-compatible endpoint `https://api.quantforge.com.br/v1`, model `deepseek-v4.1-flash`, key from `QUANTFORGE_API_KEY`.
- Decoding: `temperature: 0`, `max_tokens: 8192`, `response_format: { type: "json_object" }`.
- Omitted: `top_p`, `seed`, `tools`, `reasoning_effort`.
- Prompts: `normalize: "normalize-2-bounded"`, `plan: "plan-1"`, schema version `1.0.0`.
- Limits: 180,000 ms model deadline, max 1,048,576 input bytes, max 100,000 input tokens, max 2 structural repairs, max 1 transport retry per repair without usable response.
- Validation: Strict shared Ajv 2020 JSON schema plus proposal semantic validation.
- Fresh workspace/HOME per trial; no cross-trial cache.
- Monetary cost remains **unknown**, never zero (no price table from provider).

## Candidate frozen files

Candidate hashes at preparation time:
- `fixtures/reference-shop/artifacts/PRD.md`: `77d63f88a0a3217620285c331c0006c0f5a02d67ac4a4199dfb058962a3fbb1b`
- `fixtures/reference-shop/artifacts/openapi.yaml`: `a66aff9acc9699a20552324668c729f2fdb33fee9e1df23d36001baa33564881`
- `fixtures/reference-shop/oracle/index.js`: `c2923499f9f20653ab0be8ac296039fd2b3f8f21a7cfc05acf0a1d888499d531`
- `packages/application/src/ai/model.ts`: `8fa1514e32c92f36ddd7ece2afccbf1a37bd64034a986539522332cb6b495452`
- `packages/model-gateway/src/gateway.ts`: `7329a240d54a563f8d567f9a2e19659786af21b270cc85c28ca7e33676fc2b32`
- `packages/application/src/ai/requirements.ts`: `b767ac35931dc9b0e4f75e2a3ff631951bae9c5907f5d721274af0810056a077`
- `packages/application/src/ai/proposals.ts`: `f993f09a37964755151b995768893f78c702a92a8e54dccd8159284f348a83f4`
- `packages/application/src/ai/normalization.ts`: `f740d1656075d03e2a1433857ec9226953a1afbccac6529ae76ea3cb62d3896b`

Final freeze hashes will be verified and refreshed by the orchestrator upon final commit.

## Pipeline and independent scoring

1. Independent oracle checks run on separate fresh healthy and mutant instances. Verdicts never enter model input.
2. Initialize fresh local project, grant user consent with `--allow-unknown-cost`, and set project token budget to 12,000,000.
3. `source add` unchanged PRD.md and openapi.yaml; `discover --scope codebase`.
4. `requirement normalize` using bounded chunk extraction and cross-source reconciliation.
5. Rule-based reviewer verifies `originKind` in `{"explicit", "user_spec"}`, source-revision grounding, nonempty acceptance criteria, and no conflicts. Sort by text then ID; approve at most the first 12. Inferred and observed requirements remain rejected.
6. `plan generate --type backend` once per approved requirement. Accept all locally validated executable proposals unchanged.
7. For each accepted immutable revision, replay on fresh healthy instance and fresh mutant instance via `test run --mode replay --heal off --max-attempts 1 --wait` inside hardened Docker executor.
8. Retain commands, step results, events, and evidence in trial ledger. Missing runs directory with zero attempts reports `no_attempts`.

### Metrics

- **Primary:** Detected mutants / all 8 planned trials. Credit requires a same accepted immutable revision with healthy `outcome=passed` and `gate=passed`, mutant `outcome=failed`, a required assertion failure (`assertion_failed`), plus independent oracle healthy/defective confirmation.
- **Conditional:** Detected / oracle-confirmed non-infrastructure cohort.
- **Secondary:** Healthy false failure rate, proposal validity, token usage (measured input/output/reasoning, conservative charged), known/unknown cost, latency.

### Exclusions and stopping rules

- Conditional exclusions only: `oracle_error`, `oracle_mismatch`, `sandbox_unavailable`, `worker_lost`, `provider_transport`, `provider_timeout`, `budget_exhausted`, `wall_time_exhausted`, `missing_key`, `not_started`.
- Never excluded: `invalid_model_output`, `invalid_proposal`, `no_approved_requirements`, `no_accepted_tests`, `no_attempts`, `healthy_assertion_failure`, `generated_action_failure`, `policy_denial`, `unresolved_conflict`, `inconclusive_without_proven_infrastructure_cause`.
- Budget cap: 12,000,000 tokens, 7,200,000 ms wall time.
- Stop only after all 8 scheduled trials, budget/wall deadline, missing key, or unsafe condition. Never stop on good/bad scores.

## Statistics and experimental graduation

Two-sided Wilson 95% intervals (`z=1.96`). Single-family 8-trial pilot cannot meet graduation prerequisites (30 independent families, 100 cases, 3 trials/case, independent human labels). Capabilities remain **experimental**. No parity, human-benchmark, or unseen-family generalization claims.

## Execution commands

Offline verification check:
```sh
node tools/dist/evals/run.js --check evals/rounds/m2-round2/preregistration.json
```

Live evaluation (only after parent freeze commit and provider model restoration):
```sh
node tools/dist/evals/run.js --execute-preregistered <preregistration-commit-hash> --registration evals/rounds/m2-round2/preregistration.json
```
