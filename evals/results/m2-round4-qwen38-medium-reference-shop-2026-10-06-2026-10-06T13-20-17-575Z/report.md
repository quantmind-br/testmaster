# Experimental M2 model evaluation

Round: m2-round4-qwen38-medium-reference-shop-2026-10-06-2026-10-06T13-20-17-575Z. Preregistration commit: 116f682e197727e867f2b4937caacbbb0be37fc8.

- Settings: provider quantforge; model qwen3.8-flash; reasoning effort medium
- Primary, all planned trials: 0/8 = 0.0%; Wilson 95% [0.0%, 32.4%]
- Conditional oracle-confirmed non-infrastructure cohort: 0/8 = 0.0%; Wilson 95% [0.0%, 32.4%]
- Healthy false failures: insufficientData (n=0)
- Returned proposal validity: insufficientData (n=0)
- Healthy unavailable replays: 0
- Excluded trials (conditional only): 0; errors: 16
- Conservative/settled token charge: 183006/12000000; measured tokens: {"inputTokens":115986,"outputTokens":67020,"reasoningTokens":32537}
- Cost: "unknown"; unknown-price calls: 25
- Wall duration: 1116375 ms; stop: planned_trials_recorded

## Case outcomes

| Case | Split | Detected | Exclusions |
|---|---|---|---|
| shop-defect-004 | development | false | none |
| shop-defect-001 | development | false | none |
| shop-defect-002 | development | false | none |
| shop-defect-006 | development | false | none |
| shop-defect-007 | development | false | none |
| shop-defect-008 | development | false | none |
| shop-defect-003 | holdout | false | none |
| shop-defect-005 | holdout | false | none |

## Strata

- development: 0/6 = 0.0%; Wilson 95% [0.0%, 39.0%]
- business-calculation: 0/1 = 0.0%; Wilson 95% [0.0%, 79.3%]
- authentication: 0/1 = 0.0%; Wilson 95% [0.0%, 79.3%]
- persistence: 0/1 = 0.0%; Wilson 95% [0.0%, 79.3%]
- contract: 0/1 = 0.0%; Wilson 95% [0.0%, 79.3%]
- pagination: 0/1 = 0.0%; Wilson 95% [0.0%, 79.3%]
- idempotency: 0/1 = 0.0%; Wilson 95% [0.0%, 79.3%]
- holdout: 0/2 = 0.0%; Wilson 95% [0.0%, 65.8%]
- health: 0/1 = 0.0%; Wilson 95% [0.0%, 79.3%]
- authorization: 0/1 = 0.0%; Wilson 95% [0.0%, 79.3%]

## Exclusions and errors

- trial-01, normalize, INVALID_ARGUMENT: Conflict evidence is not grounded (conditional exclusion: none)
- trial-01, evidence, no_attempts: No test runs executed; runs evidence directory was not created (conditional exclusion: none)
- trial-02, normalize, INVALID_ARGUMENT: Requirement references evidence outside supplied sources (conditional exclusion: none)
- trial-02, evidence, no_attempts: No test runs executed; runs evidence directory was not created (conditional exclusion: none)
- trial-03, normalize, INVALID_ARGUMENT: Requirement references evidence outside supplied sources (conditional exclusion: none)
- trial-03, evidence, no_attempts: No test runs executed; runs evidence directory was not created (conditional exclusion: none)
- trial-04, normalize, INVALID_ARGUMENT: Requirement references evidence outside supplied sources (conditional exclusion: none)
- trial-04, evidence, no_attempts: No test runs executed; runs evidence directory was not created (conditional exclusion: none)
- trial-05, normalize, INVALID_ARGUMENT: Requirement references evidence outside supplied sources (conditional exclusion: none)
- trial-05, evidence, no_attempts: No test runs executed; runs evidence directory was not created (conditional exclusion: none)
- trial-06, normalize, INVALID_ARGUMENT: Requirement references evidence outside supplied sources (conditional exclusion: none)
- trial-06, evidence, no_attempts: No test runs executed; runs evidence directory was not created (conditional exclusion: none)
- trial-07, normalize, INVALID_ARGUMENT: Requirement references evidence outside supplied sources (conditional exclusion: none)
- trial-07, evidence, no_attempts: No test runs executed; runs evidence directory was not created (conditional exclusion: none)
- trial-08, normalize, INVALID_ARGUMENT: Requirement references evidence outside supplied sources (conditional exclusion: none)
- trial-08, evidence, no_attempts: No test runs executed; runs evidence directory was not created (conditional exclusion: none)

## Limits and decision

- Single application family; mutant-level holdout only; correlated trials
- Pending independent human labels and conflict adjudication
- External rule-based review, not independent human semantic intent review
- Descriptive Wilson intervals; insufficient n for parity or graduation
- Provider snapshot and monetary tariff unavailable

Capabilities remain **experimental**. No parity, human-adjudicated benchmark eligibility, unseen-family generalization or rare-event claim.
Invalid generation and all infrastructure exclusions remain misses in the planned end-to-end denominator. Retries/repairs are calls, not independent trials.
Ledger: evals/results/m2-round4-qwen38-medium-reference-shop-2026-10-06-2026-10-06T13-20-17-575Z; per-trial commands, exit codes, Run/revision IDs, oracle verdicts, usage calls and evidence are retained.
