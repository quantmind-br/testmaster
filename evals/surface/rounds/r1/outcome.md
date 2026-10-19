# r1: outcome

All 120 sessions ran, but the round is **void**. A harness defect refused TestMaster's secret storage in
every session, and the defect weighed differently on each arm. Its numbers are not evidence for any
arm. Under protocol version 2(d), a void round is kept but does not count toward the round limit or the
consecutive-round rules. `sessions.ndjson`, `report.md` and `analysis.json` are kept as the driver
wrote them, unedited.

## The defect

The session broker ran `testmaster` and the MCP server under `bwrap`, to give them the agent's private
`/tmp`. An unprivileged `bwrap` creates a user namespace in which only the operator's uid is mapped,
so root-owned directories such as `/` and `/home` belong to the overflow user. TestMaster's
`privateDirectory` (`packages/application/src/secrets.ts`) walks every ancestor of the vault directory
and refuses one owned by a user who is neither the caller nor root. That refusal is correct: a
directory of an unknown owner is not private. The vault was therefore unavailable, the session had no
desktop keyring, and every `secret set` without `--ephemeral` failed with `PRECONDITION_FAILED`
"Secure secret storage is unavailable; explicit ephemeral mode is required".

Reproduced on a copy of a session's HOME and workspace: the same `secret set` succeeds without `bwrap`
(`provider: vault`) and fails inside `bwrap --dev-bind / /`.

Consequences in r1:

- 62 of 120 sessions received that refusal.
- Agents fell back to `--ephemeral` secrets, which live only in the process that sets them, so later
  runs had no secret, or they looped on the refusal.
- The fidelity replays of those sessions were refused, or ended inconclusive, for the missing secret.
  33 sessions recorded a false positive; 31 of them had hit the defect.
- The 2 remaining false positives replayed a test the agent had archived, which TestMaster refuses to
  run.

Refused secret-storage calls per arm (CLI `secret set`/`key-status`/`auth-profile test-login` plus MCP
`set_secret`/`test_auth_login`):

| Model | Arm | TestMaster calls | Refused | Sessions hit |
|---|---|---:|---:|---:|
| gemini-3.8-flash-high | A0 | 1890 | 61 | 8 |
| gemini-3.8-flash-high | A1 | 1943 | 53 | 9 |
| gemini-3.8-flash-high | A2 | 3311 | 410 | 8 |
| gemini-3.8-flash-high | A3 | 3812 | 227 | 9 |
| muse-spark-1.3-contributor | A0 | 481 | 11 | 4 |
| muse-spark-1.3-contributor | A1 | 743 | 14 | 6 |
| muse-spark-1.3-contributor | A2 | 893 | 39 | 7 |
| muse-spark-1.3-contributor | A3 | 1159 | 28 | 8 |

The CLI-led arms (A2 and A3, skill 2.0.0) retried the refusal much more often. The defect thus
inflates their invalid rate, call count and Ttotal, which are the quantities the comparison measures.

## Other findings that changed the protocol (version 2)

- **secretInLog counted identifiers.** The seeded e-mail addresses and user names were counted as
  secrets: WEKNORA_USER_EMAIL appeared in 15 sessions, WEKNORA_USER_NAME in 18, DOKPLOY_ADMIN_EMAIL
  in 13. Credentials appeared too: DOKPLOY_ADMIN_PASSWORD in 9 sessions, DOKPLOY_API_KEY in 10,
  WEKNORA_USER_PASSWORD in 1. They came from agents printing their own environment (`env`,
  `/proc/<pid>/environ`).
- **One A3 agent queried the operator's desktop secret service** through the session bus at
  `/run/user/1000/bus`. The agent sandbox now hides the user runtime directory.
- **The agent's environment held the real provider key.** The model proxy now sends it, and the agent
  holds a placeholder.
- **outsideAccess counted directory listings** that the sandbox shows empty: `ls /home/diogo`, the
  harness state directory, the `omp` binary path, guessed project paths. It is now reported as a
  signal. The plan's criterion, zero root escape, is measured by `rootEscape`: a successful TestMaster
  call that names such a path.

## Unreviewed weakening candidates

The round is void, so its weakening candidates were not reviewed and `review.json` is absent:

| Model | A0 | A1 | A2 | A3 |
|---|---:|---:|---:|---:|
| gemini | 2 | 2 | 1 | 3 |
| muse | 0 | 0 | 0 | 2 |

## Note on the raw state

While diagnosing, one CLI replay (`test run`) was issued on 2026-10-19 against the state of session
`searxng.sx-preferences-persist.A0.gemini-3.8-flash-high`, after `sessions.ndjson` had been written.
It adds one run to that session's TestMaster database under the state directory. It changes none of
the committed records.
