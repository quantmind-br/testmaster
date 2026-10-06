# Round 5: Qwen medium with evidence-handle citations

Registration: `m2-round5-qwen38-evidence-handles-reference-shop-2026-10-06`.

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
 evals/rounds/m2-round5-qwen38-evidence-handles/preregistration.json` (on one command line).
No historical registration is rewritten or rerun against current implementation.

## Change from Round 4

Round 4 rejected all eight full-source normalizations for ungrounded evidence. A replay of
trial-02 inputs showed the model copying evidence objects with fabricated locator fields.
Commit `661477a1a45f6092213c0846861bc386598772f2` makes models cite opaque per-request
handles (`E1`, `E2`, …) that the application resolves to the exact supplied refs; unknown
handles still reject the whole output. Normalization instructions also exclude headings and
ask for one requirement per source statement. This fix was designed after observing Round 4
on the same corpus, so Round 5 is not an independent replication.

## Sample and procedure

Unchanged from Round 4: eight cases, one trial each, one reference-shop family. Development
order: shop-defect-004, 001, 002, 006, 007, 008; holdout order: shop-defect-003, 005. The mutant
holdout was previously observed and is not fresh holdout or family-generalization evidence.

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
4544064; plan admission estimate 649152. Estimates are not remote output/spend guarantees.
Unknown usage retains its reservation; known use settles honestly. No refill or
outcome-driven rerun. Remote snapshot/tariff unavailable; money remains unknown. Every
error/unstarted case stays in the eight-trial primary denominator. Publish stage-separated
completion, ledgers, Wilson 95% intervals, conditional empty-denominator nulls, exclusions
and strata.

## Supplemental acceptance

Not part of this round. Post-fix live journeys already ran at the fix commit before this
registration; their evidence is under `validation/results/m2-evidence-handles/`.

## Acceptance limits

Capabilities remain experimental regardless of score. Graduation still requires >=30
independent families, >=100 independent cases, >=3 trials/case, primary/holdout Wilson lower
>=0.8, healthy false-failure Wilson upper <=0.05, independent human labels and no critical
safety failure. Two-reviewer adjudication, representative family holdout, security sign-off
and publication license cannot be fabricated. No public release.
