# Experimental M2 model evaluation

Round: m2-round6-qwen38-typed-generation-reference-shop-2026-10-06-2026-10-06T18-07-09-532Z. Preregistration commit: 3aee30968b9d33f302c26e37b19349e3b3718464.

- Settings: provider quantforge; model qwen3.8-flash; reasoning effort medium
- Primary, all planned trials: 0/8 = 0.0%; Wilson 95% [0.0%, 32.4%]
- Conditional oracle-confirmed non-infrastructure cohort: 0/1 = 0.0%; Wilson 95% [0.0%, 79.3%]
- Healthy false failures: 1/1 = 100.0%; Wilson 95% [20.7%, 100.0%]
- Returned proposal validity: 12/12 = 100.0%; Wilson 95% [75.7%, 100.0%]
- Healthy unavailable replays: 11
- Excluded trials (conditional only): 7; errors: 36
- Conservative/settled token charge: 5154987/12000000; measured tokens: {"inputTokens":null,"outputTokens":null,"reasoningTokens":null}
- Cost: "unknown"; unknown-price calls: 92
- Wall duration: 4510549 ms; stop: planned_trials_recorded

## Case outcomes

| Case | Split | Detected | Exclusions |
|---|---|---|---|
| shop-defect-004 | development | false | provider_transport |
| shop-defect-001 | development | false | provider_timeout |
| shop-defect-002 | development | false | provider_timeout |
| shop-defect-006 | development | false | provider_transport |
| shop-defect-007 | development | false | provider_transport |
| shop-defect-008 | development | false | provider_transport |
| shop-defect-003 | holdout | false | provider_transport |
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

- trial-01, replay-healthy, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-01, replay-mutant, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-01, plan, provider_transport: Provider rejected request (conditional exclusion: provider_transport)
- trial-02, replay-healthy, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-02, replay-mutant, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-02, plan, provider_timeout: Model request deadline exceeded (conditional exclusion: provider_timeout)
- trial-03, plan, provider_timeout: Model request deadline exceeded (conditional exclusion: provider_timeout)
- trial-03, evidence, no_attempts: No test runs executed; runs evidence directory was not created (conditional exclusion: none)
- trial-04, plan, provider_transport: Provider rejected request (conditional exclusion: provider_transport)
- trial-04, evidence, no_attempts: No test runs executed; runs evidence directory was not created (conditional exclusion: none)
- trial-05, replay-healthy, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-05, replay-mutant, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-05, replay-healthy, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-05, replay-mutant, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-05, replay-healthy, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-05, replay-mutant, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-05, replay-healthy, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-05, replay-mutant, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-05, plan, PAYLOAD_TOO_LARGE: Model context exceeds admitted byte/token limits (conditional exclusion: none)
- trial-05, plan, provider_transport: Provider rejected request (conditional exclusion: provider_transport)
- trial-06, replay-healthy, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-06, replay-mutant, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-06, replay-healthy, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-06, replay-mutant, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-06, plan, provider_transport: Provider rejected request (conditional exclusion: provider_transport)
- trial-07, replay-healthy, assertion_mismatch: HTTP statusIn expectation was not satisfied (conditional exclusion: none)
- trial-07, replay-mutant, assertion_mismatch: HTTP statusIn expectation was not satisfied (conditional exclusion: none)
- trial-07, replay-healthy, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-07, replay-mutant, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-07, replay-healthy, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-07, replay-mutant, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-07, replay-healthy, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-07, replay-mutant, replay_unavailable: Replay did not produce a business outcome (conditional exclusion: none)
- trial-07, plan, provider_transport: Provider rejected request (conditional exclusion: provider_transport)
- trial-08, review, no_approved_requirements: No requirements passed fixed review policy (conditional exclusion: none)
- trial-08, evidence, no_attempts: No test runs executed; runs evidence directory was not created (conditional exclusion: none)

## Limits and decision

- Single application family; mutant-level holdout only; correlated trials
- Pending independent human labels and conflict adjudication
- External rule-based review, not independent human semantic intent review
- Descriptive Wilson intervals; insufficient n for parity or graduation
- Provider snapshot and monetary tariff unavailable

Capabilities remain **experimental**. No parity, human-adjudicated benchmark eligibility, unseen-family generalization or rare-event claim.
Invalid generation and all infrastructure exclusions remain misses in the planned end-to-end denominator. Retries/repairs are calls, not independent trials.
Ledger: evals/results/m2-round6-qwen38-typed-generation-reference-shop-2026-10-06-2026-10-06T18-07-09-532Z; per-trial commands, exit codes, Run/revision IDs, oracle verdicts, usage calls and evidence are retained.
