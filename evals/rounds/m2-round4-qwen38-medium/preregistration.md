# Round 4: Qwen medium experimental M2 evaluation

Registration: `m2-round4-qwen38-medium-reference-shop-2026-10-06`.

## Configuration and frozen execution

QuantForge `https://api.quantforge.com.br/v1`, `qwen3.8-flash`, credential only from
`QUANTFORGE_API_KEY`. Effective `reasoning_effort: medium`; JSON object response format.
Sampling, output ceilings, seed, penalties, enable_thinking and tools are omitted.
The 8192 output-token capability is local reservation metadata, not a remote output limit.
Per-model deadline: 180000 ms. Evaluator command deadline: 600000 ms plus 15000 ms kill grace,
bounded by the remaining registered wall deadline.

The JSON registration is authoritative for final-byte SHA-256 inputs, fixed splits, rubric,
thresholds and accounting. Freeze the registration in a conventional commit before any live
call. Execute exactly once with `--execute-preregistered <commit> --registration
 evals/rounds/m2-round4-qwen38-medium/preregistration.json` (on one command line).
No historical registration is rewritten or rerun against current implementation.

## Sample and procedure

Eight cases, one trial each, one reference-shop family. Development order: shop-defect-004,
001, 002, 006, 007, 008; holdout order: shop-defect-003, 005. The mutant holdout was previously
observed and is not fresh holdout or family-generalization evidence.

Import unchanged full PRD and OpenAPI, discover authorized sources, normalize all bounded
batches and reconcile, independently rule-review grounded explicit/user_spec requirements,
leave unresolved conflicts unapproved, sort by text/id and select at most 12. Generate one
backend proposal command per selected requirement, accept all valid executable proposals
without edits, replay the same immutable revision against fresh healthy and mutant instances.
Concurrency 1, maxAttempts 1, healing off. Independent oracle labels never enter model input.
Detection requires oracle-confirmed ground truth, healthy outcome+gate passed and mutant
required assertion_failed for the same revision; action errors/timeouts do not count.

## Budget, stopping and publication

Unchanged local quota: 12000000 tokens; wall: 7200000 ms. Normalization admission estimate
4544064; plan admission estimate 649152. Estimates are not remote output/spend guarantees:
wire output ceilings are omitted and measured use can exceed reservations. Unknown usage
retains its reservation; known use settles honestly. No refill or outcome-driven rerun.
Remote snapshot/tariff unavailable; money remains unknown. Every error/unstarted case stays
in the eight-trial primary denominator. Publish stage-separated completion, ledgers,
Wilson 95% intervals, conditional empty-denominator nulls, exclusions and strata.

## Supplemental acceptance, separate from scoring

Execute each file once, serially, with medium and 100000 local tokens per isolated project:

- `validation/journeys/m2-discovery.live.test.ts`: 600000 ms.
- `validation/journeys/m2-proposals.live.test.ts`: 600000 ms.
- `validation/journeys/m2-agent.live.test.ts`: 300000 ms.

Total local supplemental quotas: 300000, not provider billing guarantees. Failed and unknown
usage is captured before workspace cleanup. Do not run broad test:live, change providers,
omit effort, pad proposals or rerun until green. Agent draft is fixture-authored; it proves
exploration/candidate verification/promotion/replay, not full PRD-to-browser generation.

## Prior observations and acceptance limits

Round 1: 0/8 with truncation/origin filter problems; historical ledgers retained.
Round 2: designated DeepSeek model unavailable; unexecuted registration retained.
Round 3: Qwen full normalization returned HTTP 500 twice around 127 seconds, unknown usage
retained 9088128 tokens and remaining trials were stopped. Round 4 changes provider-owned
sampling/output defaults and reasoning effort: score differences are confounded and cannot
be attributed solely to medium. Short Money smoke is not full-pipeline quality evidence.

Capabilities remain experimental regardless of score. Graduation still requires >=30
independent families, >=100 independent cases, >=3 trials/case, primary/holdout Wilson lower
>=0.8, healthy false-failure Wilson upper <=0.05, independent human labels and no critical
safety failure. Two-reviewer adjudication, representative family holdout, security sign-off
and publication license cannot be fabricated. No public release or M3 authorization.
