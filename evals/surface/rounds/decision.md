# Surface experiment: decision (PLAN.md Phase 4)

Date: 2026-10-19. Decision: **Phase 5b, keep the post-Phase-1 MCP as a supported surface.** The CLI
stays the default route where it is non-inferior. The migration to CLI + skill only (A3) is
rejected by the preregistered round limit.

## Inputs (PLAN.md §8, Fase 4)

| Input | Answer | Source |
|---|---|---|
| A3 non-inferior to A0 on the development targets and the holdout | **no**, in none of the 6 counted rounds, for neither model | rounds r2-r7 below |
| A client without a shell on the roadmap | no | operator, §13 question 1 |
| The remote pipeline is a requirement | no | operator, §13 question 2 |

Phase 4 table row "não | qualquer": keep the MCP post-Phase 1 (Phase 5b). The answers to questions
1 and 2 do not change the outcome of that row.

## Rounds

Agent models: `gemini-3.8-flash-high` and `muse-spark-1.3-contributor`, driven by omp (§13
question 3). Development targets: searxng, weknora and dokploy. 120 sessions per round, 15 seeds
per arm and model. Criteria are applied per model with no correction. r1 is void: secret storage
was refused inside the harness namespace (`evals/surface/rounds/r1/`). c0-reference-shop is the
calibration round.

A3 against A0, per model (g = gemini, m = muse; failed criteria in bold):

| Round | Commit | Ttotal ratio ≤ 0.70 (g / m) | invalidRate Δ upper ≤ 3 pp | fabrications Δ upper ≤ 0 | stepsToGreen ratio ≤ 1.15 | completion ≥ control | non-compensatory |
|---|---|---|---|---|---|---|---|
| r2 | `55738b5` | **1.548** / **0.711** | 2.5 / **3.7** | **1.267** / **0.733** | **1.837** / **1.456** | yes / **no** | **secretInLog 2** / yes |
| r3 | `2ee3b27` | **1.126** / **1.561** | 0.9 / **3.6** | **0.733** / **0.600** | **1.791** / **1.692** | yes / yes | **secretInLog 1** / **secretInLog 2** |
| r4 | `4495fd2` | **0.923** / **0.937** | −1.3 / **11.3** | **0.533** / **0.600** | **1.529** / **1.932** | yes / **no** | yes / yes |
| r5 | `50fa933` | **0.895** / **0.982** | 1.6 / 2.6 | **0.467** / **0.600** | **1.581** / **1.311** | yes / yes | yes / yes |
| r6 | `2763f00` | **0.866** / **1.070** | −0.3 / 2.3 | **0.200** / **0.333** | **1.277** / **1.267** | yes / yes | **secretInLog 1** / yes |
| r7 | `a3c551d` | **0.859** / **0.809** | −3.4 / 0.9 | −0.133 / **0.600** | **1.567** / 0.926 | yes / yes | yes / yes |

Every round passes the T1 surface, false-positive and skill-reread criteria for both models. No
round reached the abandonment signal (point invalidRate Δ above 10 pp).

One fix per round, aimed at the class the previous round showed (each round's
`classification.md`):

| Measured in | Fix | Commit |
|---|---|---|
| r3 | skill 2.1.0 names the commands that read state | `2ee3b27` |
| r4 | `doctor` probes the encrypted vault with a valid workspace id | `4495fd2` |
| r5 | skill 2.2.0 documents the JSON-token form login profile | `50fa933` |
| r6 | `requirement snapshot`; skill 2.3.0 | `2763f00` |
| r7 | `env get` shows the active revision | `a3c551d` |

Each fix removed the class it targeted (for example, muse A3 auth-profile refusals 51 → 1 after
r4's fix, and fabricated `env revision get` calls 6 → 0 after r6's). No new failure class appeared
in r4, r5, r6 or r7.

## Why the migration is rejected

- **Round limit.** PLAN.md §10 (Critérios de parada) sets a limit of 6 rounds; reaching it without
  convergence rejects the migration. r2-r7 are the 6 counted rounds, and none met every threshold
  for both models.
- **Ttotal never reached the threshold.** Over the last four rounds A3 cost between 0.81 and 1.07 of
  A0's total tokens, against a required 0.70. A3's fixed surface is about 22 tokens against
  roughly 2,400-2,600 for A0 (T1 surface), so the remaining cost is per call: A3 sessions make more
  calls (median 53 against 30 for gemini in r7).
- **stepsToGreen or fabrications** failed for at least one model in every round.

The fixes made the CLI route measurably better for every arm, since they are product changes the
MCP arms also reach. They did not make A3 non-inferior on cost.

## Holdout

The Vikunja holdout (`evals/surface/apps/vikunja/`) is frozen and was never run. Protocol step 7
runs it only after a development round in which the thresholds hold, and none did. This follows the
protocol; it is not a deviation.

## Deviations to note

- The TestMaster internal model (used for normalization, generation and analysis inside each
  session) is `gpt-6-luna` in every counted round. Calibration started on `qwen3.8-flash`, which ran
  out of quota (`047d7c0`), then `gpt-6.1-sol` (`1d7c5e9`), which QuantForge withdrew before r2.
  `gpt-6-luna` was chosen without asking the operator; it is committed in the internal profile and
  in each preregistration.
- r7 was interrupted by a host reboot and resumed under the same preregistration; the 12 partial
  sessions were rerun from the start.

## Consequences

Phase 5b: nothing is removed. The catalog size lock in `apps/mcp/src/surface.test.ts` keeps the
post-Phase-1 wire size from regressing. ADR-028 records the decision.
