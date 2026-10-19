# r7: failure classes and the round limit

r7 is the sixth counted development round (protocol version 5; r1 is void). All 120 of 120
sessions ran. A host reboot interrupted 12 sessions; the round was resumed with the same
preregistration, and those sessions were rerun from the start (`.interrupted-*` directories). Its
single change since r6 is `env get` showing the active revision, which every arm can reach. Skill
2.3.0 and the protocol are unchanged. Verdict: A3 is not non-inferior for either model.

- gemini: Ttotal (0.859) and stepsToGreen (1.567) fail. invalidRate (Δ −5.9 pp, upper −3.4 pp),
  fabrications (Δ −0.40, upper −0.133), completion (100% on every target) and the
  non-compensatory criterion pass.
- muse: Ttotal (0.809) and fabrications (Δ 0.27, upper 0.600) fail. invalidRate (Δ −2.6 pp,
  upper 0.9 pp), stepsToGreen (0.926), completion (searxng 80% against 60%, weknora 80% against
  60%, dokploy 40% against 40%) and the non-compensatory criterion pass.

No arm reached the abandonment signal (point invalidRate Δ −5.9 pp gemini, −2.6 pp muse). Every
completed fidelity replay was consistent: 0 false positives in every arm.

## Effect of the r6 fix (`env get` shows the active revision)

| Measure | r6 | r7 |
|---|---:|---:|
| fabricated `env revision get` calls, all arms | 6 | 0 |
| gemini A3 fabricated calls | 6 | 0 |
| `env revisions` calls, all arms | 21 | 0 |
| `env get` calls, all arms | 66 | 59 |

Agents now read the environment's target from `env get` and no longer look for a revision command.

## Classes (mechanical mapping, report.mjs)

| Model | Arm | contrato mal preenchido | flag inexistente | ordem de pipeline errada | versão stale | ID inventado |
|---|---|---:|---:|---:|---:|---:|
| gemini | A0 | 45 | 6 | 0 | 1 | 0 |
| gemini | A1 | 46 | 1 | 0 | 1 | 0 |
| gemini | A2 | 43 | 2 | 0 | 0 | 0 |
| gemini | A3 | 16 | 0 | 0 | 0 | 0 |
| muse | A0 | 52 | 0 | 0 | 2 | 0 |
| muse | A1 | 39 | 0 | 0 | 4 | 1 |
| muse | A2 | 13 | 0 | 2 | 1 | 0 |
| muse | A3 | 23 | 3 | 0 | 1 | 1 |

No class is new. r4, r5, r6 and r7 are four consecutive rounds without a new class, but the
thresholds do not hold for either model, so the holdout does not run (protocol step 7).

muse A3 has 4 fabricated calls in 3 sessions: `provider list` twice and `capability list`, which
are commands that do not exist, and one `requirement normalize` that names a source id the agent
had not seen. gemini A3 has none.

## Round limit reached

r7 is the sixth counted round. The stopping rule (PLAN.md §10, Critérios de parada) says that
reaching 6 rounds without convergence rejects the migration. No fix follows r7, and no r8 opens. The
decision is recorded in `evals/surface/rounds/decision.md`.

## Other observations

- secretInLog: 5 sessions, all in the control arms (gemini A0 twice, gemini A1 once, muse A1
  twice) and none in A2 or A3.
- Weakening candidates: 10 revisions in 4 sessions, reviewed in `review.json`, none weakened.
  Four are status or consolidation changes that keep every checked property. Six are probe
  revisions of a scratch test that gemini archived before it delivered a separate test, which keeps
  the refresh, access-token and `/auth/me` assertions.
