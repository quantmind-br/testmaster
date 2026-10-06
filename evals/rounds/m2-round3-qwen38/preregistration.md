# Preregistered experimental M2 evaluation — Round 3

Model: `qwen3.8-flash` at `https://api.quantforge.com.br/v1`; credential from `QUANTFORGE_API_KEY` only. Operator explicitly authorized this selection. Authenticated model inventory returned HTTP 200 and included the exact model on 2026-10-06.

Round 1 observations and the unexecuted Round 2 registration remain unchanged. Round 3 preserves Round 2's corrected normalization pipeline, temperature 0, 8192 output-token ceiling, eight cases, token/wall budgets, thresholds and stopping rules. The evaluator now reads provider selection from the committed registration rather than a hardcoded model. No other model substitution is allowed.

`preregistration.json` is authoritative. Commit it before execution and supply that exact commit to `--execute-preregistered`. Frozen implementation, corpus and oracle hashes must pass offline checking first. All eight trials remain in the primary denominator, including errors and unstarted trials.

This is a single-family feasibility pilot with previously observed mutant strata, not unseen holdout validation. Independent human labels, family diversity and public-release approval remain unavailable; generation remains experimental regardless of scores. Monetary cost remains unknown without a tariff.
