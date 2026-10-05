# Local operations (single-user profile, M0–M2)

## Storage layout

| Path | Content |
|---|---|
| `<repo>/.testmaster/testmaster.db` | SQLite (WAL, foreign keys, `BEGIN IMMEDIATE` writes); override root with `TESTMASTER_DATA_DIR` |
| `<repo>/.testmaster/runs/<workspace>/<run>/<attempt>/` | committed evidence bundles; `meta.json` is written last, `.partial` marks incomplete staging |
| `<repo>/.testmaster/agent-backups/` | backups taken before agent skill files are modified |
| `~/.config/testmaster/profiles.json` | user profiles and model providers |
| `~/.config/testmaster/policy.json` | operator ceilings and grants (`allowedModelProviders`, unsafe-local opt-in) |
| `~/.config/testmaster/vault.key`, `~/.local/share/testmaster/` | AES-256-GCM vault fallback when `secret-tool` is unavailable; never inside the DB or backups |

## Worker

```bash
testmaster worker start      # foreground supervisor; claims leases, heartbeats, reconciles
testmaster worker status
testmaster worker drain      # stop claiming; in-flight attempts finish within the drain window
testmaster worker reconcile  # one reconciliation pass (expired leases, orphan staging/containers, outbox)
```

Defaults (`specs/08-operations.md` §2.2): heartbeat 10 s, lease 30 s, drain 60 s, reconciler every 30 s,
`maxAttempts` 2 (retries only for infrastructure failures before any effect or assertion). Each claim
increments the lease fence; a worker holding a stale fence cannot publish. A killed worker leaves its
attempt to the reconciler, which marks it `inconclusive` or retries it according to recorded effects —
never `passed`. Containers are labelled `io.testmaster.attempt|run|owner-pid` and orphans are removed by
the reconciler.

`testmaster server start` runs the same worker in the foreground together with the loopback API.

## Database

```bash
testmaster db status    # applied migrations and checksums
testmaster db migrate   # forward-only; a modified applied migration is refused
```

PostgreSQL DDL is kept in `packages/persistence/migrations/postgres/` and conformance-tested; using it as
the runtime database is an M4 capability and is reported unavailable.

## Backup and restore

```bash
testmaster backup create --out /backups/tm-2026-10-05
testmaster backup restore /backups/tm-2026-10-05 --out /restore/tm   # isolated destination
```

Backups use the SQLite online backup API and a manifest with hashes of the database and evidence index.
Restore verifies hashes, writes only to the isolated destination and leaves admission, leases, outbox
delivery and API tokens suspended: nothing restored is executed automatically. Secrets are not part of
backups; re-provision them with `testmaster secret set`.

## Storage pressure and retention

Admission warns at 80 % disk use and suspends new admission at 90 %; only the pressure-owned suspension
recovers automatically. Worker maintenance expires eligible evidence through mark → tombstone → delete.
Expired evidence makes a bundle `partial` with an explicit reason; the Run's outcome, snapshot hashes and
audit history never change. Legal holds are described in `docs/development.md`.

## Troubleshooting

| Symptom | Cause and action |
|---|---|
| `doctor` FAIL `runtime`, runs exit 9 | Docker daemon unreachable or hardened start failed. Fix Docker; TestMaster never falls back to unsandboxed execution. |
| `doctor` FAIL `images` | `containers/images.lock.json` does not match local images or the seccomp profile hash. Run `node containers/build.mjs`. |
| Container fails at OCI init with a runc/libpathrs crash | Seccomp profile does not match the engine. The profile is generated from the engine's `moby/profiles` version (`containers/generate-seccomp.mjs`, `docs/adr/011-seccomp-profile.md`); regenerate after a Docker upgrade. |
| Chromium sandbox fails to start | The attempt is `blocked` with `security_precondition_failed`; `--no-sandbox` is never used. Check that unprivileged user namespaces are enabled on the host. |
| `secret set` refused | Neither `secret-tool` (D-Bus session) nor the vault key file is usable. Fix the keychain or create `~/.config/testmaster/vault.key` (0600), or use `--ephemeral` for the current process. |
| Model commands refuse before sending anything | Missing provider in the user profile, provider not in `policy.json` `allowedModelProviders`, or no consent: `testmaster consent grant --provider <id> --data-class ...`. |
| `test run` without `--wait` returns `PRECONDITION_FAILED` | No live worker. Start `testmaster worker start` or use `--wait`. |
| Healing/compare/CI/schedules return exit 8 | `CAPABILITY_UNAVAILABLE`: feature belongs to M3+ (`testmaster capabilities`). |
