# r4: failure classes and the fix for r5

r4 is the third counted development round (protocol version 3). All 120 of 120 sessions ran, and no
session was stopped by its provider or by the harness. Its single change since r3 is the doctor
vault-probe fix, which every arm shares. Verdict: A3 is not non-inferior for either model.

- gemini: Ttotal (0.923), fabrications (upper 0.533) and stepsToGreen (1.529) fail. invalidRate
  passes (Δ −3.5 pp, upper −1.3 pp), and so does the non-compensatory criterion.
- muse: Ttotal (0.937), invalidRate (upper 11.3 pp), fabrications (upper 0.600), stepsToGreen
  (1.932) and completion fail. Completion is dokploy 20% against A0's 40%; searxng is 100% against
  80%, and weknora is 20% against 20%.

No arm reached the abandonment signal. The point invalidRate Δ is 3.6 pp for muse and −3.5 pp for
gemini. Every completed fidelity replay was consistent: 0 false positives in every arm.

## Effect of the r3 fix (doctor vault probe)

| Measure | r3 | r4 |
|---|---:|---:|
| Sessions that set a secret with `--ephemeral` | 22 | 0 |
| Sessions with a run inconclusive on "secure secret storage is unavailable" | 21 | 0 |
| gemini A3 mean calls | 93.9 | 60.5 |
| gemini A3 Ttotal ratio | 1.126 | 0.923 |
| gemini A3 stepsToGreen ratio | 1.791 | 1.529 |
| muse A3 mean calls | 59.7 | 34.8 |

The A0 control moved little: gemini 53.1 to 46.1 mean calls, muse 30.5 to 28.1.

## Classes (mechanical mapping, report.mjs)

| Model | Arm | contrato mal preenchido | flag inexistente | ordem de pipeline errada | versão stale |
|---|---|---:|---:|---:|---:|
| gemini | A0 | 41 | 3 | 0 | 0 |
| gemini | A1 | 31 | 5 | 0 | 0 |
| gemini | A2 | 45 | 5 | 0 | 0 |
| gemini | A3 | 18 | 6 | 1 | 0 |
| muse | A0 | 20 | 2 | 0 | 0 |
| muse | A1 | 20 | 4 | 0 | 0 |
| muse | A2 | 20 | 4 | 0 | 6 |
| muse | A3 | 54 | 5 | 0 | 14 |

No class is new: every class in r4 occurred in r2 or r3. "ID inventado", new in r3, does not recur.

## The largest cause: a form login that returns a JSON token

One session holds 54 of the 73 invalid calls of muse A3: weknora wk-kb-tags-total, with 54 invalid
calls out of 114. WeKnora's login answers with the token in its JSON body (`/token`) and sets no
cookie. The agent created a form profile and then sent 56 `auth-profile update` calls, 50 of them
refused. It guessed a field for the token in `config.http` or `config.http.success` each time:
`tokenNames`, `tokenJsonPath`, `tokenHeader`, `authHeader`, `tokenType`, `sessionToken`, `header`,
`headerName`, `scheme`, `credentialHeader`, `applyTo`, `sendAs`, `target`, `token`, `tokens`,
`tokenField`, `__probe`. 36 refusals were `Invalid AuthFormConfig` (additionalProperties), 2 were a
missing `--expected-version` and an unknown `kind` field, and 12 were `REVISION_CONFLICT`, because
the agent reused a stale `--expected-version`. Those 12 are 12 of the 14 muse A3 "versão stale"
calls.

The contract has the field: `success.tokenPointer` (a JSON pointer into the login response) and
`tokenScheme` (default `Bearer`). The managed token is then sent as `Authorization: Bearer TOKEN` on
every request with `"auth":"profile"`. The skill does not say so: the form example in
`references/auth-secrets.md` shows only `cookieNames`. Almost every weknora A2/A3 session reads that
file. The same gap showed in r3: 9 `Invalid AuthFormConfig` refusals with guessed token fields in
A2/A3, and three gemini sessions that wrote every contract schema to files while looking for the
field (`contract schema` 173 calls in A3). In r4, weknora wk-token-refresh A3 muse also ended while
it was still working out how to send a captured token as `Authorization: Bearer`.

Checked against WeKnora with the built CLI and no keychain, using the shipped vault. A form profile
with `"success":{"statusIn":[200],"tokenPointer":"/token"}` gives `test-login` outcome
`authenticated` with credential role `token`. A plan `GET /api/v1/auth/me` with `"auth":"profile"`
passes (`assertions_satisfied`). The same plan without `"auth":"profile"` fails
(`assertion_mismatch`).

## Fix for r5 (one class: contrato mal preenchido, the JSON-token login)

Skill 2.2.0 (`AGENT_SKILL_VERSION`) adds a JSON-token form profile to `references/auth-secrets.md`.
It also lists the four `success` fields, and says how the token is sent and that `"auth":"profile"`
sends it. `SKILL.md` changes only its version. A0 and A1 keep skill 1.0.0, so the fix reaches only
A2 and A3. Protocol version 4 names skill 2.2.0 from r5 in the A2 arm text.

## Other observations (no fix in r5)

- Credential exposure (secretInLog): 1 session (gemini A0). secretInArgv: 0 in every arm.
- rootEscape: 0 in every arm.
- Weakening candidates: 2, both reviewed in `review.json`, neither weakened. One is the RSS-root
  literal relaxed to allow namespace attributes, as in r3. The other is a generated code candidate.
- muse sessions end with exit 0 while work remains. The last message announces a next step
  ("Schema understood — setting up auth and writing the requirement.") and no tool call follows. This
  happens in every arm: muse A0 completion is 46.7% in r3 and in r4. It is a model behavior, and it
  makes the muse per-target completion gate noisy. One session changes a target's rate by 20 pp.
- Conflict listing is still missing. `secret set --ephemeral` is still undocumented in the CLI help.
  No session chose it in r4.
