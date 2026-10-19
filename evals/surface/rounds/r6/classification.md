# r6: failure classes and the fix for r7

r6 is the fifth counted development round (protocol version 5). All 120 of 120 sessions ran, and no
session was stopped by its provider or by the harness. Its single change since r5 is the
`requirement snapshot` command, which every arm can reach, plus skill 2.3.0, which names it, for A2
and A3. Verdict: A3 is not non-inferior for either model.

- gemini: Ttotal (0.866), fabrications (Δ −0.13, upper 0.200), stepsToGreen (1.277) and the
  non-compensatory criterion (one secretInLog session) fail. invalidRate passes (Δ −1.9 pp, upper
  −0.3 pp), and so does completion (100% on every target).
- muse: Ttotal (1.070), fabrications (Δ 0.13, upper 0.333) and stepsToGreen (1.267) fail.
  invalidRate (Δ −0.7 pp, upper 2.3 pp), completion (searxng 100% against 60%, weknora 60% against
  60%, dokploy 60% against 40%) and the non-compensatory criterion pass.

No arm reached the abandonment signal (point invalidRate Δ −1.9 pp gemini, −0.7 pp muse). Every
completed fidelity replay was consistent: 0 false positives in every arm.

## Effect of the r5 fix (`requirement snapshot`, skill 2.3.0)

| Measure | r5 | r6 |
|---|---:|---:|
| gemini A3 fabricated `requirement conflict(s)` calls | 4 | 0 |
| `requirement snapshot` calls, gemini A2 / A3 | — | 62 / 55 |
| `requirement snapshot` calls, muse A2 / A3 | — | 18 / 23 |
| muse A2 `REVISION_CONFLICT` on requirement commands | 8 | 2 |
| muse A3 `REVISION_CONFLICT` on requirement commands | 3 | 1 |

A0 and A1 keep skill 1.0.0, yet gemini A0 and A1 also called `requirement snapshot` (5 and 8 calls);
muse A0 and A1 did not.

## Classes (mechanical mapping, report.mjs)

| Model | Arm | contrato mal preenchido | flag inexistente | ordem de pipeline errada | versão stale | ID inventado |
|---|---|---:|---:|---:|---:|---:|
| gemini | A0 | 37 | 8 | 0 | 1 | 0 |
| gemini | A1 | 43 | 6 | 0 | 2 | 0 |
| gemini | A2 | 30 | 1 | 1 | 0 | 0 |
| gemini | A3 | 35 | 6 | 0 | 0 | 0 |
| muse | A0 | 23 | 1 | 0 | 1 | 0 |
| muse | A1 | 27 | 0 | 0 | 5 | 0 |
| muse | A2 | 55 | 1 | 2 | 3 | 0 |
| muse | A3 | 16 | 0 | 1 | 1 | 3 |

No class is new. r4, r5 and r6 are three consecutive rounds without a new class, but the
thresholds do not hold, so the holdout does not run after r6 (protocol step 7).

## The fix class: flag inexistente, the environment's active revision

gemini A3 made 6 fabricated calls, and 5 of them are `env revision get EVR_ID`, each in a different
session (dokploy dk-application-idle, dokploy dk-project-update, searxng sx-config-engines, weknora
wk-kb-delete, weknora wk-register-validation). In four of them the agent had just run
`env get local`, got `activeRevisionId`, and asked for that revision to read what the environment
targets. `env get` prints the environment entity only: name, version, `activeRevisionId`. The
target origins, network profile and auth profiles live in the revision, which only
`env revisions NAME` lists, newest first, without saying which one is active. The MCP route shows
the active revision with each environment at `testmaster://projects/{id}/environments`
(`activeRevision`). After the refusal, all five agents ran `env --help` and then
`env revisions local`.

## Fix for r7 (one class: flag inexistente, `env get` shows the active revision)

`testmaster env get` adds `activeRevision`, the revision `env revisions` lists under
`activeRevisionId`, without `variables`. It is a product change that every arm reaches. The skill
does not change: skill 2.3.0 already tells agents to read an environment with `env get NAME`. The
protocol does not change either.

r7 is the sixth counted round, the last one the round limit allows (r1 is void).

## Other observations (no fix in r7)

- secretInLog: 3 sessions (gemini A1 and A3 weknora wk-token-refresh, muse A2 dokploy
  dk-project-update). In all three the agent printed its own environment (`env | grep WEKNORA`,
  `env`), which shows the seeded password and API key it was given. No TestMaster output carried a
  credential. This is agent behavior and occurs in A1, A2 and A3.
- `test lint` refusals are still the largest "contrato mal preenchido" group, gemini A3 24 and
  gemini A2 15. Agents lint drafts as the skill tells them, so each finding is an invalid call.
- `auth-profile test-login --environment local` still fails with `NOT_FOUND` when the agent gives
  the environment name instead of its id (1 call each in gemini A0, gemini A1 and muse A0 in r6).
- muse A3 "ID inventado" (3): two `env update` calls name an environment or auth profile of another
  project, and one `test run` names a test the agent had not created.
- Plan generation still declines the WeKnora token-refresh plans, because a plan cannot build
  `Authorization: Bearer <captured token>`.
- Weakening candidates: 1 (searxng sx-rss-media-type A1 muse), reviewed in `review.json`: the RSS
  root literal relaxed to allow namespace attributes, as in r3 and r4. Not weakened.
