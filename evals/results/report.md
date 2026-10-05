# Experimental M2 model evaluation

Round: m2-reference-shop-2026-10-05-2026-10-05T23-14-51-858Z. Preregistration commit: f37c3604399446e34a97c763dd0a507b4349660f.

- Primary, all planned trials: 0/8 = 0.0%; Wilson 95% [0.0%, 32.4%]
- Conditional oracle-confirmed non-infrastructure cohort: 0/8 = 0.0%; Wilson 95% [0.0%, 32.4%]
- Healthy false failures: insufficientData (n=0)
- Returned proposal validity: insufficientData (n=0)
- Healthy unavailable replays: 0
- Excluded trials (conditional only): 0; errors: 16
- Conservative/settled token charge: 542771/12000000; measured tokens: {"inputTokens":356423,"outputTokens":186348,"reasoningTokens":138426}
- Cost: "unknown"; unknown-price calls: 23
- Wall duration: 957731 ms; stop: planned_trials_recorded

## Observed pipeline completion and interpretation

- All eight independent healthy/mutant oracle pairs confirmed ground truth. All eight real CLI source/discovery/normalization pipelines were attempted.
- Seven pipelines failed normalization after two repairs. There were 23 model calls: 22 invalid and one successful; 15 repair calls and zero transport retries. All 22 invalid calls consumed the configured 8192 output tokens. This is consistent with output-budget pressure, but raw completions/finish reasons are not retained here, so truncation causality is **unproven**.
- Trial 03 returned 17 normalized requirements, all with the contract-valid `originKind: explicit`. The frozen preregistration and harness require `originKind: user_spec`, rejecting all 17 before approval. This is a restrictive evaluator/contract mismatch, **not a proven product defect**. It remains an end-to-end miss under the committed rule, not a post-result exclusion. No origin mapping or rerun was performed.
- **Zero plan-generation, acceptance or generated-test replay commands ran. Zero TestMaster Run IDs, generated revisions or Docker Attempts exist for this round.** The independent oracle used real local HTTP and SQLite, not the product Docker runner. `runner: real-cli-docker` in the automatic report denotes the intended execution design, not observed Docker coverage.
- The detection score is an end-to-end pipeline-yield result, **not an estimate of defect sensitivity of generated tests**: none were generated. Healthy false failures and returned proposal validity are insufficientData, not zero failure/perfect validity. `healthyUnavailable: 0` means no healthy replay was scheduled, not successful execution.
- Eight additional `evidence_copy_unavailable` errors arose because no Run created `.testmaster/runs`. They are collector errors retained in the ledger, not evidence loss from executed Attempts. All per-trial commands, source/discovery output, oracle verdicts and usage calls are retained; replay evidence is absent because replay was never reached.

No product or preregistration files were modified during or after this round. Any revised origin policy, output budget, prompt or pipeline would require a separately preregistered evaluation; this round is not replaced.

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

- trial-01, normalize, INVALID_ARGUMENT: Provider returned invalid output after two repairs (conditional exclusion: none)
- trial-01, evidence, evidence_copy_unavailable: Error: ENOENT: no such file or directory, lstat '/tmp/tm-eval-rRxNVI/repo/.testmaster/runs' (conditional exclusion: none)
- trial-02, normalize, INVALID_ARGUMENT: Provider returned invalid output after two repairs (conditional exclusion: none)
- trial-02, evidence, evidence_copy_unavailable: Error: ENOENT: no such file or directory, lstat '/tmp/tm-eval-PvRMiP/repo/.testmaster/runs' (conditional exclusion: none)
- trial-03, review, no_approved_requirements: No requirements passed fixed review policy (conditional exclusion: none)
- trial-03, evidence, evidence_copy_unavailable: Error: ENOENT: no such file or directory, lstat '/tmp/tm-eval-oU5jr5/repo/.testmaster/runs' (conditional exclusion: none)
- trial-04, normalize, INVALID_ARGUMENT: Provider returned invalid output after two repairs (conditional exclusion: none)
- trial-04, evidence, evidence_copy_unavailable: Error: ENOENT: no such file or directory, lstat '/tmp/tm-eval-kcTIwE/repo/.testmaster/runs' (conditional exclusion: none)
- trial-05, normalize, INVALID_ARGUMENT: Provider returned invalid output after two repairs (conditional exclusion: none)
- trial-05, evidence, evidence_copy_unavailable: Error: ENOENT: no such file or directory, lstat '/tmp/tm-eval-RWZ8jD/repo/.testmaster/runs' (conditional exclusion: none)
- trial-06, normalize, INVALID_ARGUMENT: Provider returned invalid output after two repairs (conditional exclusion: none)
- trial-06, evidence, evidence_copy_unavailable: Error: ENOENT: no such file or directory, lstat '/tmp/tm-eval-cEUHn2/repo/.testmaster/runs' (conditional exclusion: none)
- trial-07, normalize, INVALID_ARGUMENT: Provider returned invalid output after two repairs (conditional exclusion: none)
- trial-07, evidence, evidence_copy_unavailable: Error: ENOENT: no such file or directory, lstat '/tmp/tm-eval-7sXmUo/repo/.testmaster/runs' (conditional exclusion: none)
- trial-08, normalize, INVALID_ARGUMENT: Provider returned invalid output after two repairs (conditional exclusion: none)
- trial-08, evidence, evidence_copy_unavailable: Error: ENOENT: no such file or directory, lstat '/tmp/tm-eval-RAhmXB/repo/.testmaster/runs' (conditional exclusion: none)

## Limits and decision

- Single application family; mutant-level holdout only; correlated trials
- Pending independent human labels and conflict adjudication
- External rule-based review, not independent human semantic intent review
- Descriptive Wilson intervals; insufficient n for parity or graduation
- Provider snapshot and monetary tariff unavailable

Capabilities remain **experimental**. No parity, human-adjudicated benchmark eligibility, unseen-family generalization or rare-event claim.
Invalid generation and all infrastructure exclusions remain misses in the planned end-to-end denominator. Retries/repairs are calls, not independent trials.
Ledger: evals/results/m2-reference-shop-2026-10-05-2026-10-05T23-14-51-858Z; per-trial commands, exit codes, Run/revision IDs, oracle verdicts, usage calls and evidence are retained.
