# r5: failure classes and the fix for r6

r5 is the fourth counted development round (protocol version 4). All 120 of 120 sessions ran. Two
model requests of muse-spark-1.3-contributor were refused with HTTP 404 at 11:16 UTC (weknora
wk-token-refresh A3, dokploy dk-project-update A1), which stopped the weknora and dokploy processes
as the harness requires. A probe a minute later got HTTP 200 from both models, so the provider was
not down for the round. The two sessions were set aside as `provider-failed` and the round resumed;
they ran again from the start. Its single change since r4 is skill 2.2.0, which reaches A2 and A3
only. Verdict: A3 is not non-inferior for either model.

- gemini: Ttotal (0.895), fabrications (upper 0.467) and stepsToGreen (1.581) fail. invalidRate
  passes (Δ −0.5 pp, upper 1.6 pp), and so do completion (100% on every target) and the
  non-compensatory criterion.
- muse: Ttotal (0.982), fabrications (upper 0.600) and stepsToGreen (1.311) fail. invalidRate
  (Δ −0.9 pp, upper 2.6 pp) and completion pass: weknora 80% against A0's 20%, dokploy 80% against
  80%, searxng 100% against 100%.

No arm reached the abandonment signal (point invalidRate Δ −0.5 pp gemini, −0.9 pp muse). Every
completed fidelity replay was consistent: 0 false positives in every arm.

## Effect of the r4 fix (skill 2.2.0, the JSON-token form login)

| Measure | r4 | r5 |
|---|---:|---:|
| muse A3 refused `auth-profile` calls | 51 | 1 |
| muse A3 invalid calls | 73 | 27 |
| muse A3 invalidRate Δ against A0 (upper) | 11.3 pp | 2.6 pp |
| muse A3 weknora completion | 20% | 80% |
| gemini A3 refused `auth-profile` calls | 1 | 0 |

A0 and A1 run skill 1.0.0, which the fix does not reach: muse A1 had 3 refused `auth-profile` calls
in r4 and 14 in r5.

## Classes (mechanical mapping, report.mjs)

| Model | Arm | contrato mal preenchido | flag inexistente | ordem de pipeline errada | versão stale | ID inventado |
|---|---|---:|---:|---:|---:|---:|
| gemini | A0 | 22 | 4 | 0 | 0 | 0 |
| gemini | A1 | 47 | 4 | 0 | 0 | 0 |
| gemini | A2 | 17 | 6 | 0 | 0 | 0 |
| gemini | A3 | 31 | 6 | 1 | 0 | 0 |
| muse | A0 | 20 | 0 | 0 | 0 | 0 |
| muse | A1 | 39 | 1 | 0 | 1 | 1 |
| muse | A2 | 38 | 1 | 1 | 12 | 0 |
| muse | A3 | 18 | 3 | 3 | 3 | 1 |

No class is new: "ID inventado" occurred in r3. r4 and r5 are two consecutive rounds without a new
class, but the thresholds do not hold, so the holdout does not run yet (protocol step 7).

## The fix class: flag inexistente, the missing requirement snapshot read

The fabrications criterion fails for both models: A3 may not fabricate more than A0. gemini A3 made
6 fabricated calls and 4 of them name a command that reads requirement conflicts:
`requirement conflict list` (3, in dokploy dk-project-update, dokploy dk-session-identity and
searxng sx-config-engines) and `requirement conflicts` (1, searxng sx-hash-answer). In each session
the agent had normalized requirements, met a conflict (`requirement approve` refused with
`requirement_conflict_unresolved`, or the normalize receipt listed one), and looked for a way to
read it again before `requirement adjudicate`.

The CLI has no such read. `requirement list` prints the requirements only: no status, no conflicts,
and no snapshot version. Conflicts and the snapshot version appear only in the receipts of
`requirement normalize` and `requirement review`. Yet `requirement adjudicate --expected-version` and
the `expectedVersion` of a review file are that snapshot version. The MCP route serves the whole
snapshot at `testmaster://requirements/{projectId}`, and `specs/05-cli-mcp.md` §2 says that the CLI
requirement commands show conflicts ("source refs e conflitos visíveis"). The CLI route therefore
lacks a read the specification promises.

The same gap shows in "versão stale": 8 of muse A2's 12 and 3 of muse A3's 3 are `REVISION_CONFLICT`
on requirement commands. An agent that edited a requirement (which moves the snapshot version)
then reviewed with the version from an earlier receipt, and had no command to re-read the current
one. `references/pipeline.md` also named `data.sourceSnapshotId` as a field of `requirement
normalize`, which prints `fingerprint` instead.

## Fix for r6 (one class: flag inexistente, the requirement snapshot read)

- `testmaster requirement snapshot` prints `{version, sourceSnapshotId, requirements, conflicts,
  openQuestions}`, each requirement with its derived `status` and each conflict with its
  `resolution`. It is the CLI counterpart of `testmaster://requirements/{projectId}`. It is a
  product change that every arm can reach through `requirement --help`.
- Skill 2.3.0 lists `requirement snapshot` among the commands that read state, in place of
  `requirement list`. `references/pipeline.md` names it as the source of the review and adjudicate
  version, and corrects the normalize field name. A0 and A1 keep skill 1.0.0.
- Protocol version 5 names skill 2.3.0 from r6 in the A2 arm text.

## Other observations (no fix in r6)

- `test lint` refusals are the largest "contrato mal preenchido" group in every arm (gemini A3 17,
  muse A3 9, muse A2 14). Agents use lint as intended, to validate a draft, so each refusal counts as
  an invalid call. The refusals repeat: a top-level `description` on a plan (5), `textNotContains` in
  a browser plan (5; the message names the replacement), a literal `Cookie` or `x-api-key` header (5),
  `jsonPointer` on a text assertion (3). One gemini A3 session (weknora wk-token-refresh) linted 8
  probe plans to find which operations each runner accepts.
- Plan generation declines to write the WeKnora token-refresh plans in every arm. The reason given
  is that a plan cannot build `Authorization: Bearer <captured access_token>`: a header value is a
  literal, a `secretRef` or a `variableRef`, and nothing joins a scheme to a captured token. Agents
  then write a terminal-runner script that calls curl or Python. That is the longest seed for
  A2/A3 muse (205 and 126 calls). This is a plan-contract gap, not a surface property.
- WeKnora's OpenAPI document has three deprecated operations with empty `responses`, so `source add`
  refuses it (12 calls, gemini A2/A3). This is a target defect.
- `auth-profile test-login --environment local` is `NOT_FOUND` in 7 A2/A3 sessions: the option takes
  the environment id, while `test run --env` takes the name.
- The `test revisions TEST_ID` fabrication recurs in every gemini arm (5 calls), although skill 2.1.0
  and later name `test revision list TEST_ID`.
- Weakening candidates: 13, all reviewed in `review.json`. One is weakened, in the control arm:
  searxng sx-preferences-persist A0 muse (`rev_01a153c9-…`) dropped `[selected]` from both option
  locators, so the green test no longer checks that the preference persisted.
- muse still ends some sessions with exit 0 while work remains, in every arm.
