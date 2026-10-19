# r3: failure classes and the fix for r4

r3 is the second counted development round (protocol version 3). All 120 of 120 sessions ran, and no
session was stopped by its provider or by the harness. Its single change since r2 is skill 2.1.0,
which reaches A2 and A3 only. Verdict: A3 is not non-inferior for either model.

- gemini: Ttotal (1.126), fabrications (upper 0.733), stepsToGreen (1.791) and the
  non-compensatory criterion fail.
- muse: Ttotal (1.561), invalidRate (upper 3.6 pp), fabrications (upper 0.600), stepsToGreen (1.692)
  and the non-compensatory criterion fail.

Completion of A3 is at least A0's on every target for both models. The muse A3 completion is
weknora 100% against A0's 40%, and dokploy 80% against 40%. No arm reached the abandonment signal.
Every completed fidelity replay was consistent: 0 false positives in every arm.

## Effect of the r2 fix (flag inexistente)

The orientation guesses that skill 2.1.0 targets (`status`, `state`, `project status`) fell from 17
calls in A2/A3 in r2 to 0 in r3. Flag-inexistente calls in A3 fell from 14 to 8 (gemini) and from 10
to 5 (muse). The fabricated calls that remain are scattered, and no command repeats more than three
times: `model list` (3), `contract list`, `image list`, `provider list` (2 each), `conflict list` and
`requirement conflicts` (3 in A2), and single guesses.

## Classes (mechanical mapping, report.mjs)

| Model | Arm | contrato mal preenchido | flag inexistente | ordem de pipeline errada | versão stale | ID inventado |
|---|---|---:|---:|---:|---:|---:|
| gemini | A0 | 32 | 6 | 4 | 0 | 0 |
| gemini | A1 | 35 | 8 | 1 | 0 | 0 |
| gemini | A2 | 23 | 10 | 0 | 0 | 0 |
| gemini | A3 | 50 | 8 | 3 | 1 | 0 |
| muse | A0 | 22 | 4 | 0 | 0 | 1 |
| muse | A1 | 38 | 4 | 1 | 0 | 0 |
| muse | A2 | 24 | 1 | 0 | 3 | 0 |
| muse | A3 | 52 | 5 | 2 | 8 | 1 |

"ID inventado" is new in r3: one `test run` with an id the session never saw, in muse A0 and in muse
A3.

"Contrato mal preenchido" is the class where A3 most exceeds A0 for both models. Its A2/A3 calls are
spread over several causes:

- `test lint` refusals of hand-written plans: 39 in A3, 18 in A2, 8 in A0. They come from many rules,
  and no single rule dominates (A2 and A3 issues): predicate not valid for its input or runner 24,
  missing `expectation` fields 10, step id pattern 9, a literal authentication header 8.
- `source add docs/swagger.json` refused as `invalid_openapi`: 15. The WeKnora specification declares
  three deprecated operations with an empty `responses`. This is a target defect, and every arm meets
  it.
- `auth-profile create` refused as `Invalid AuthFormConfig`: 9. The agents guessed `tokenPath`,
  `tokenField`, `tokenNames`, `bodyToken`, `headerName` and `scheme` for a JSON-token login. The
  contract has `success.tokenPointer` and `tokenScheme`, but the skill's form example shows only
  `cookieNames`.
- `plan generate` refused: 13, eleven of them "Provider returned invalid output after two repairs".
  This is output quality of the internal model gpt-6-luna, and every arm meets it.

## The cause of the slow sessions: doctor sends agents to ephemeral secrets

The largest single cause of the extra steps in A3 is not an invalid call. It is a run that ends
`inconclusive`. A run ended `inconclusive` with the runner evidence protocol error "Secure secret
storage is unavailable; explicit ephemeral mode is required" in these sessions:

| Round | A0 | A1 | A2 | A3 |
|---|---:|---:|---:|---:|
| r2 | 3 (gemini 2, muse 1) | 4 (gemini 3, muse 1) | 3 (gemini) | 6 (gemini) |
| r3 | 4 (gemini) | 3 (gemini) | 4 (gemini) | 10 (gemini 9, muse 1) |

Every one of them set a secret with `secret set --ephemeral`, and every session that used
`--ephemeral` (16 in r2, 22 in r3) ran `doctor` first, with no failed `secret set` before. `doctor`
told them: `"secrets": {"status": "WARN", "backend": "unavailable"}`, "No writable secure secret
backend; secrets need explicit ephemeral mode." That was false, because a plain `secret set` in the
same session stores the value in the encrypted vault (provider `vault`). An ephemeral secret lives
only in the CLI process that set it, so the next `test run` or `auth-profile test-login` cannot read
it. The agents then spent many steps on secret and auth reconfiguration (`secret key-status`,
`secret rewrap`, `doctor` again, new secrets, new profiles).

Reproduced outside the harness with the harness's user environment (no D-Bus keychain): `doctor`
reports `unavailable`, and `secret set` succeeds with provider `vault`. The defect is in the probe:
`vaultHealth` (packages/application/src/secrets.ts) writes its canary under the workspace `doctor`.
The vault envelope check accepts only `ws_` ids, so the read-back always fails, and the canary file
stays in the vault directory. A host with a working `secret-tool` never reaches that path, which is
why it went unnoticed.

## Fix for r4 (one class: contrato mal preenchido, the secret-backend diagnosis)

`vaultHealth` probes with the reserved id `ws_00000000-0000-4000-8000-000000000000`, the one the
server profile already used. It removes the canary whether or not it read back. `doctor` now reports
`{"backend":"vault","writable":true}` and recommends nothing about secrets. A regression test in
`secrets.test.ts` runs the encrypted fallback without a keychain. It checks the probe result and that
no probe file remains. The test fails on the unfixed source with `backend: "unavailable"`. The fix is
shared: it reaches every arm that calls `doctor` (any arm can, through the CLI). The A0 control
re-runs in r4 and measures it.

## Other observations (no fix in r4)

- Credential exposure (secretInLog): 6 sessions. Four printed the environment (`env | grep`,
  `env | sort`, `printenv`) and one used `curl -v` with the `x-api-key` header. One (weknora
  wk-kb-delete A3 muse) registered the password as a secret allowed for a local echo server it
  started itself (`--allowed-origin http://127.0.0.1:20999`), to see what a form login sends, and
  then printed the echo log. TestMaster sent the value only to the origin the agent authorized. No
  value appears in any TestMaster output. secretInArgv: 0 in every arm.
- rootEscape: 0 in every arm.
- Weakening candidates: 8, all reviewed in `review.json`. One is weakened: searxng
  sx-preferences-persist A2 gemini `rev_…ad1`. It replaced five assertions with one check that an h1
  is visible, and it ran green. The agent restored the checks in its next two revisions. A3 has no
  weakened revision.
- `secret set --ephemeral` in the CLI keeps the value in a process that exits at once. A later
  command that needs it fails with the same "storage is unavailable" message, which names the wrong
  cause. Candidate for a later round if agents keep choosing it after the doctor fix.
- Form login with a JSON token (`success.tokenPointer`) is not in the skill (see above). Candidate
  for a later round.
- Conflict listing is still missing: 3 guessed calls in A2 (`conflict list`, `requirement
  conflicts`).
- `contract schema` calls: 173 in A3 against 49 in A2. Three gemini sessions wrote every contract to
  files while looking for the form-login token field (one session made 42 such calls).
