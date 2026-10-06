# Experimental M2 model evaluation

Round: m2-round3-qwen38-reference-shop-2026-10-06-2026-10-06T09-28-54-148Z. Preregistration commit: e3c6380fb328a9a6e725b006143ed62348c62d0a.

- Primary, all planned trials: 0/8 = 0.0%; Wilson 95% [0.0%, 32.4%]
- Conditional oracle-confirmed non-infrastructure cohort: insufficientData (n=0)
- Healthy false failures: insufficientData (n=0)
- Returned proposal validity: insufficientData (n=0)
- Healthy unavailable replays: 0
- Excluded trials (conditional only): 8; errors: 11
- Conservative/settled token charge: 9088128/12000000; measured tokens: {"inputTokens":null,"outputTokens":null,"reasoningTokens":null}
- Cost: "unknown"; unknown-price calls: 2
- Wall duration: 261933 ms; stop: budget_exhausted

## Case outcomes

| Case | Split | Detected | Exclusions |
|---|---|---|---|
| shop-defect-004 | development | false | provider_transport |
| shop-defect-001 | development | false | provider_transport |
| shop-defect-002 | development | false | budget_exhausted |
| shop-defect-006 | development | false | budget_exhausted |
| shop-defect-007 | development | false | budget_exhausted |
| shop-defect-008 | development | false | budget_exhausted |
| shop-defect-003 | holdout | false | budget_exhausted |
| shop-defect-005 | holdout | false | budget_exhausted |

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

- trial-01, normalize, provider_transport: Provider rejected request (conditional exclusion: provider_transport)
- trial-01, evidence, no_attempts: No test runs executed; runs evidence directory was not created (conditional exclusion: none)
- trial-02, normalize, provider_transport: Provider rejected request (conditional exclusion: provider_transport)
- trial-02, evidence, no_attempts: No test runs executed; runs evidence directory was not created (conditional exclusion: none)
- trial-03, normalize, budget_exhausted: Insufficient conservative token reservation (conditional exclusion: budget_exhausted)
- trial-03, evidence, no_attempts: No test runs executed; runs evidence directory was not created (conditional exclusion: none)
- trial-04, scheduling, budget_exhausted: Insufficient conservative token reservation (conditional exclusion: budget_exhausted)
- trial-05, scheduling, budget_exhausted: Insufficient conservative token reservation (conditional exclusion: budget_exhausted)
- trial-06, scheduling, budget_exhausted: Insufficient conservative token reservation (conditional exclusion: budget_exhausted)
- trial-07, scheduling, budget_exhausted: Insufficient conservative token reservation (conditional exclusion: budget_exhausted)
- trial-08, scheduling, budget_exhausted: Insufficient conservative token reservation (conditional exclusion: budget_exhausted)

## Limits and decision

- Single application family; mutant-level holdout only; correlated trials
- Pending independent human labels and conflict adjudication
- External rule-based review, not independent human semantic intent review
- Descriptive Wilson intervals; insufficient n for parity or graduation
- Provider snapshot and monetary tariff unavailable

Capabilities remain **experimental**. No parity, human-adjudicated benchmark eligibility, unseen-family generalization or rare-event claim.
Invalid generation and all infrastructure exclusions remain misses in the planned end-to-end denominator. Retries/repairs are calls, not independent trials.
Ledger: evals/results/m2-round3-qwen38-reference-shop-2026-10-06-2026-10-06T09-28-54-148Z; per-trial commands, exit codes, Run/revision IDs, oracle verdicts, usage calls and evidence are retained.
