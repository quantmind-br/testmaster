# r2: failure classes and the fix for r3

r2 is the first counted development round (protocol version 2). All 120 of 120 sessions ran, and no
session was stopped by its provider or by the harness. Verdict: A3 is not non-inferior for either
model. For gemini, Ttotal, fabrications and stepsToGreen fail. For muse, Ttotal (0.711 against 0.70),
invalidRate, fabrications, stepsToGreen and completion fail. No arm of either model reached the
abandonment signal. Every completed fidelity replay was consistent: 0 false positives in every arm.

## Classes (mechanical mapping, report.mjs)

| Model | Arm | contrato mal preenchido | flag inexistente | ordem de pipeline errada | versão stale |
|---|---|---:|---:|---:|---:|
| gemini | A0 | 29 | 2 | 2 | 0 |
| gemini | A1 | 29 | 5 | 3 | 0 |
| gemini | A2 | 37 | 8 | 1 | 0 |
| gemini | A3 | 52 | 14 | 3 | 0 |
| muse | A0 | 29 | 9 | 2 | 0 |
| muse | A1 | 10 | 3 | 0 | 0 |
| muse | A2 | 12 | 8 | 0 | 5 |
| muse | A3 | 22 | 10 | 0 | 0 |

"Flag inexistente" is the class where A3 exceeds A0 for both models. It is also the class the
fabrications criterion counts: gemini A3 − A0 = 0.80 [0.40, 1.27] per session.

## Fabricated calls (all arms, both models)

| Arm | Count | Call |
|---|---:|---|
| A3 | 10 | `status` |
| A3 | 3 | `contract list` |
| A3 | 2 | `state` |
| A3 | 2 | `requirement conflicts` |
| A3 | 1 | `requirement conflict list` |
| A3 | 1 | `conflict list` |
| A3 | 1 | `artifact list` |
| A3 | 1 | `auth-profile remove` |
| A3 | 1 | `env revision get` |
| A3 | 1 | `run list` (unknown option) |
| A3 | 1 | `secret rotate` (unknown option) |
| A2 | 3 | `project status` |
| A2 | 2 | `status` |
| A2 | 2 | `environment list` |
| A2 | 2 | `test revisions ID` |
| A2 | 1 each | `contract list`, `evidence get`, `requirement conflict list`, `requirement snapshot`, `source show`, `worker list`, `requirement list` (unknown option) |
| A1 | 3 | `environment list` |
| A1 | 3 | `test revisions ID` |
| A1 | 1 each | `contract list`, `plan-batch list` |
| A0 | 6 | `test run ID` (unknown option) |
| A0 | 3 | `environment list` |
| A0 | 1 each | `artifact list`, `model list` |

The CLI-route agents (A2, A3) open a session by guessing an orientation command: `status`, `state`,
`project status`. That accounts for 17 of their 40 fabricated calls. Each guess is followed by
`--help` or by a real list command. The real commands that read state are `project list`, `env list`,
`source list`, `requirement list`, `plan list`, `test list`, `test revision list TEST_ID` and
`run list`, and skill 2.0.0 names none of them.

## Other observations (no fix in r3)

- Credential exposure (secretInLog): 7 sessions across A0–A3, all agent shell behavior. Five
  printed their environment (`env | grep WEKNORA`, `env | grep DOKPLOY`); two printed a verbose HTTP
  request (`curl -v`, a Node request dump) with the `x-api-key` header. None went through TestMaster.
  secretInArgv: 0 in every arm.
- rootEscape: 0 in every arm.
- Weakening candidates: 5, all reviewed in `review.json`, none weakened. Two are generated code
  candidates, which have no plan steps. Three replace or fix assertions while keeping the checked
  behavior.
- Conflicts: there is no command that lists requirement conflicts after `requirement normalize`. They
  are only in that receipt (`data.conflicts[]`) and in the review receipt (`unresolvedConflictIds`).
  Five calls guessed one. This is a product gap, left for a later round.

## Fix for r3 (one class: flag inexistente)

Skill 2.1.0 (`AGENT_SKILL_VERSION`) adds one line to `SKILL.md`: there is no `status` command, a list
of the commands that read state, and `GROUP --help`. To stay within 2.5 KB, the description loses a
sentence the Authority paragraph repeats, and the reference index becomes one line. Every cited
command was run against the built CLI. A0 and A1 keep their frozen skill 1.0.0, so the fix reaches
only A2 and A3.
