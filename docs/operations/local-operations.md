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
testmaster worker drain      # stop claiming; in-flight attempts finish, however long they take
testmaster worker reconcile  # one reconciliation pass (expired leases, orphan staging/containers, outbox)
```

Once the worker is registered and claiming, `worker start` writes one line to stderr,
``worker <wrk_id> ready: claiming queued runs until interrupted or `testmaster worker stop` ``; a
supervisor (systemd, a background job, an agent) can wait for `ready` in that line. Stdout keeps
only the final JSON or text result printed when the worker stops.

The first interruption (SIGINT, SIGTERM or SIGHUP) drains the worker: it stops claiming and writes
`worker draining: attempts in flight finish first; interrupt again to stop them now` to stderr.
The drain has no deadline of its own. Each attempt in flight still ends under its own attempt and
run limits, and a model answer is never cut, so a stop can last as long as the longest attempt.
A second interruption is the forced stop: the worker aborts the attempts it still runs, and each
one ends under its fence. Its Run ends `inconclusive`, or `blocked` when no step had started, and
never `passed`. Under systemd the unit has `TimeoutStopSec=infinity`, and the forced stop is
`systemctl --user kill --kill-whom=main -s SIGINT testmaster-worker@<name>`.

Defaults (`specs/08-operations.md` §2.2): heartbeat 10 s, lease 30 s, reconciler every 30 s,
`maxAttempts` 2 (retries only for infrastructure failures before any effect or assertion). Each claim
increments the lease fence; a worker holding a stale fence cannot publish. A killed worker leaves its
attempt to the reconciler, which marks it `inconclusive` or retries it according to recorded effects —
never `passed`. Containers are labelled `io.testmaster.attempt|run|owner-pid` and orphans are removed by
the reconciler.

`testmaster server start` runs the same worker in the foreground together with the loopback API, and
drains it the same way on shutdown.

## Database

```bash
testmaster db status    # applied migrations and checksums
testmaster db migrate   # forward-only; a modified applied migration is refused
testmaster db upgrade  # read-only preview of pending (irreversible) migrations, blockers and rollback rule
testmaster db upgrade --apply --backup-out /backups/tm-before-upgrade   # drain, backup, migrate, readiness
testmaster image revoke sha256:<id> --reason "<why>"   # durable; see Upgrade and rollback
testmaster image revoked
```

PostgreSQL DDL is kept in `packages/persistence/migrations/postgres/` and conformance-tested; using it as
the runtime database is an M4 capability and is reported unavailable.

## Backup and restore

```bash
testmaster backup create --out /backups/tm-2026-10-05
testmaster backup restore /backups/tm-2026-10-05 --out /restore/tm   # isolated destination
testmaster backup restore /backups/tm-before-upgrade --out /restore/tm --keep-schema   # restore point for an older release
```

Backups use the SQLite online backup API and a manifest with hashes of the database and evidence index.
Restore verifies hashes, writes only to the isolated destination and leaves admission, leases, outbox
delivery and API tokens suspended: nothing restored is executed automatically. Secrets are not part of
backups; re-provision them with `testmaster secret set`. By default a restore migrates the restored
database forward to the running release; `--keep-schema` keeps the backup's schema version, which is
required when the restored directory will be opened by an older release (see rollback below).

## Storage pressure and retention

Disk use warns at 80 % and raises a critical alert at 90 %; neither suspends admission. A new Run is
refused (`QUOTA_EXCEEDED`, `storage_reserve_insufficient`) only when the free bytes cannot hold the
worst-case evidence (`attemptArtifactBytes × maxAttempts`) of every Run in progress plus the new one
and a 256 MiB metadata reserve. Queued Runs do not count: the worker repeats the check before it
starts each one and leaves it queued, with no deadline, until the free bytes hold it.
Worker maintenance expires eligible evidence through mark → tombstone → delete.
Expired evidence makes a bundle `partial` with an explicit reason; the Run's outcome, snapshot hashes and
audit history never change. Legal holds are described in `docs/development.md`.
Requested deletion status exposes a 24-hour active-data deadline separately from the latest
recorded backup expiry. Holds defer physical collection and appear explicitly with a reason;
worker restart resumes pending operations. Backups record 24-hour protection at creation,
including incomplete copies. Operators control separately retained backup files: expiration of
the protection does not promise erasure of those files. Restore merges current artifact tombstones
and secret revocations before admission can resume; it cannot resurrect access to deleted data.

### Full disk or upload storage outage

1. As admin, drain the worker and retain failed Run IDs/manifests/audit. Do not remove active
   bundles, WAL, secret data or legal-held objects. Stop if storage integrity cannot be checked.
2. Inspect free space on `TESTMASTER_DATA_DIR` with `df -h`. The 4 MiB preallocated
   `.control-plane.reserve` is released at pressure/SQLITE_FULL for DB/audit recovery writes;
   it is not capacity for continued execution. Clear unrelated operator-owned files or grow
   the volume; do not shorten evidence retention to hide the incident.
3. Uploads have 15-minute durable leases, at most eight pending objects and 100 MiB reserved
   bytes per workspace. Outages emit `storage.upload.failed`; expired leases stop admission
   backlog growth and stale writes fail. No upload is complete until hash/size confirmation.
4. Preview `testmaster artifact repair-references`, then explicitly use `--apply` after
   reviewing the recomputed live SQL references. This repairs counters, never deletes blobs.
5. Run `testmaster worker reconcile --dry-run`, inspect proposed recovery, then reconcile.
   Backups protect referenced artifacts for 24 hours, including failed/incomplete copies.
   `backup.failed` and `backup:last-warning` identify missing objects; do not call them complete.
6. Check `testmaster doctor` and readiness before restarting the foreground worker. Preserve
   the original assertion outcome and separate failed evidence gate. Stop on hash mismatch,
   unclear external effects or a repeated storage failure.

### Restore review and vault key lifecycle

Use the isolated restored data directory, never the active one:

```bash
TESTMASTER_DATA_DIR=/restore/tm testmaster backup review
TESTMASTER_DATA_DIR=/restore/tm testmaster backup review --apply --revocations-confirmed
TESTMASTER_DATA_DIR=/restore/tm testmaster backup resume-run RUN_ID
TESTMASTER_DATA_DIR=/restore/tm testmaster backup resume-run RUN_ID --apply
testmaster secret key-status
testmaster secret rewrap
testmaster secret retire-key OLD_KEY_ID
testmaster secret retire-key OLD_KEY_ID --apply
```

Review requires admin authority and an explicit assertion that current revocations/tombstones
were reconciled; incomplete evidence also requires `--accept-incomplete-evidence`. Old in-flight
jobs remain nondispatchable until their separate decision. A resumed job creates a fresh Attempt;
known uncertain mutation resources are refused. No restore command sends target traffic.
When the post-backup revocation ledger is unreadable or absent, the restore declares
`postBackupLedger: "unavailable"`, stays suspended, and review additionally requires
`--ledger-loss-accepted`.
Vault ciphertext envelopes carry authenticated encryption and a content-derived key ID.
Rewrap retains prior keys during atomic per-object updates; interruption can be retried. Retirement
refuses active keys or any still-referencing ciphertext and durably records a retired-key denylist
before deleting old key bytes. Preserve segregated vault/key recovery material; missing or retired
keys fail release, never create a replacement or resurrect a revoked secret.

## Check deliveries and dead letters

A check delivery retries with exponential equal-jitter backoff (1 s base, 300 s cap) after the in-request
retries, and becomes a queryable dead letter after 10 attempts or 24 hours. List them with
`testmaster ci deliveries [--state pending|delivered|dead_letter]`; reopen one with
`testmaster ci deliveries-requeue DELIVERY_ID` (write authority, audited; it never reruns the local
test), then publish again with `testmaster ci publish`. The maintenance outbox sweep marks outbox events
delivered without sending anything; the delivery state lives in the Delivery entity.

## Troubleshooting

| Symptom | Cause and action |
|---|---|
| `doctor` FAIL `runtime` (exit 9); runs exit 15 | Docker daemon unreachable or hardened start failed. Fix Docker; TestMaster never falls back to unsandboxed execution. |
| `doctor` FAIL `images` | `containers/images.lock.json` does not match local images or the seccomp profile hash. Run `node containers/build.mjs`. |
| Any command exits 6 with `unsupported_node` (embedding applications see `doctor` FAIL `node`) | Node.js is not a 24.x release (`engines` `>=24 <25`). Install Node 24; the CLI opens nothing before this check. |
| `doctor` FAIL `writablePaths` or admission refuses `storage_not_writable` | The data directory (`TESTMASTER_DATA_DIR`) is read-only or owned by another user. Fix permissions or the mount; no Run is admitted until it is writable. |
| `doctor` FAIL `database` | Pending migrations or a non-WAL journal. Run `testmaster db status` and `testmaster db upgrade`; never copy the `.db` file without its WAL. |
| `doctor` WARN `browserSandbox` / `timezone` / `network` | Recommendations only: browser tests are blocked while HTTP tests stay ready; set `environment.timezone` to an IANA name; review non-loopback environment network profiles. |
| Container fails at OCI init with a runc/libpathrs crash | Seccomp profile does not match the engine. The profile is generated from the engine's `moby/profiles` version (`containers/generate-seccomp.mjs`, `docs/adr/011-seccomp-profile.md`); regenerate after a Docker upgrade. |
| Chromium sandbox fails to start | The attempt is `blocked` with `security_precondition_failed`; `--no-sandbox` is never used. Check that unprivileged user namespaces are enabled on the host. |
| `secret set` refused | Neither `secret-tool` (D-Bus session) nor the vault key file is usable. Fix the keychain or create `~/.config/testmaster/vault.key` (0600), or use `--ephemeral` for the current process. |
| `secret set`, a run that stores a sensitive capture, or `secret rewrap` is refused with `PRECONDITION_FAILED` and `reasonCode: "lock_busy"`; `doctor` shows `secrets` `WARN` with the same reason code | Another TestMaster process holds `vault.lock` in `~/.config/testmaster` (server profile: the `secrets` directory of the evidence root), or the file does not hold a process id (an empty lock left by an older version). Retry when that process finishes; remove `vault.lock` only when no TestMaster process is running. |
| Model commands refuse before sending anything | Missing provider in the user profile, or provider not in `policy.json` `allowedModelProviders`. The allowlist is the only provider gate; there is no separate grant to make. |
| `test run` without `--wait` returns `PRECONDITION_FAILED` | No live worker. Start `testmaster worker start` or use `--wait`. |
| `suite run` returns `PRECONDITION_FAILED` "No live worker" | Start `testmaster worker start`; or pass `--wait` to run the BatchRun in this process and wait for it (prints the `test run --wait` batch shape, exit code is the batch result); or pass `--queue` to admit the BatchRun anyway, its Runs staying queued until a worker is live. Without `--wait`, follow each member with `run wait <runId>` (the receipt's `memberRuns`; `run wait` does not take the BatchRun id), then `report export <batchId> --format <format>`. |
| `backup restore` returns `PRECONDITION_FAILED` with `reasonCode: "backup_integrity"` | A backup file is missing, changed (size or SHA-256 differs from `manifest.json`), is not a regular file, the evidence index is malformed, or the database file (even with a matching hash) cannot be read or fails its integrity check. A destination this command created is removed; an existing `--out` is refused untouched. Do not edit the manifest: restore from another copy of the backup. |
| `backup restore` returns `PRECONDITION_FAILED` with `reasonCode: "backup_version_unsupported"` | The backup's schema is newer than this release's migrations. Run a release that has them. |
| Healing/compare/CI/schedules return exit 8 | `CAPABILITY_UNAVAILABLE`: feature belongs to M3+ (`testmaster capabilities`). |

## Local daemon, health and permissions

Run the controller as the workspace owner, never root:

```bash
testmaster server start --port 7331
testmaster worker status
testmaster config show
```

Startup opens and checks/migrates SQLite before publishing the listener. `/v1/health/live` only tests
the process; authenticated `/v1/health/ready` checks storage and available runner prerequisites without
contacting the target or a model. Missing runner images degrade readiness; it is not permission to
use an unsafe executor. Workers publish document schema, runner/action capabilities and pinned image
digests; incompatible queued work stays unexecuted. Scope R can read status/config; W authors, X
executes/cancels and A performs migration/backup/worker administration and revocation. A viewer must
never acquire administrative scope by editing a request.

This profile is a foreground loopback daemon on the approved hardened rootful Docker host. Compose,
reverse-proxy server deployment and a rootless socket procedure are not certified local interfaces;
they remain M4/reference-profile acceptance, not copy-paste deployment recipes. Do not publish this
listener on a wildcard address or mount Docker sockets into runners.

`config show` is read-only/offline and does not open SQLite, probe Docker or call models/targets.
Future normative defaults are explicitly `unavailable`, not enabled runtime capabilities. Private
operational logs reside beneath `.testmaster/logs/api/` and `.testmaster/logs/worker/`: UTC daily JSONL,
two 10 MiB files/day/component, default retention 14 days. `TESTMASTER_LOG_RETENTION_DAYS` accepts
1–365. A 256-record pending queue/full spool drops diagnostics with a count instead of blocking the
API/executor. Logs serialize IDs/status only; audit is separate. Correlate API `X-Correlation-ID`/
requestId with Run matrix correlationId, outbox payload and Artifact `testmaster:correlationId`.

## Upgrade and rollback (maintenance only, local single-user profile)

Scope: one controller on one host. Independent per-component rolling upgrades, release
signatures/license approval and distributed (M4+) rollback are not part of this procedure.

Every SQLite migration is forward-only and irreversible (no down migration exists; the list is in
[CHANGELOG](../../CHANGELOG.md)). Any application command that opens the database (including
`worker start`, `server start` and `db status`) migrates it forward, so run the upgrade below
**before** starting the new release.

1. Preserve the release commit, `containers/images.lock.json`, `testmaster db status`, redacted
   `testmaster config show`, existing policy, vault/key metadata and revocation/tombstone history.
   Keep private keys and plaintext tokens outside the backup/evidence archive.
2. Stop the foreground controller (SIGTERM) after `testmaster worker drain`; do not migrate under a
   serving old controller. Deploy the candidate with the data directory so the install is checked
   first: `make install DATA_DIR=/path/to/.testmaster`. It prints a pre-deploy warning naming every
   irreversible migration the candidate will apply, and refuses (changing nothing) if the database
   schema is newer than the candidate, an applied migration checksum differs, or the candidate pins a
   revoked image. Without `DATA_DIR` that check is skipped and a warning says so.
3. Preview with `testmaster db upgrade` (read-only: pending migrations, irreversibility, blockers
   such as a revoked image or newer schema). Then apply:
   `testmaster db upgrade --apply --backup-out /backups/tm-before-upgrade`. In order it runs the
   read-only preflight (compatibility, checksums, revoked images, free space for a second DB copy),
   **drain** (marks ready workers `draining` and waits up to `--drain-timeout`, default 60 s, for live
   workers, leased jobs and unfinished attempts; if work remains it stops with nothing backed up or
   migrated), **backup** (SQLite online backup of the old schema plus manifest and evidence index; a
   failed backup stops before migration; an incomplete evidence index is reported, not hidden),
   **migrate** (one exclusive transaction) and **readiness** (integrity and foreign-key checks, no
   pending migrations). The receipt names the backup, the irreversibility and the restore command, and
   `upgrade:last` in operational state records them. A second migrator is rejected while one runs;
   never delete a lock without investigating its owner or change an applied migration.
4. Start the controller (a fresh worker registers each time), verify authenticated readiness and
   worker capability/image digests, and perform an authorized healthy replay before resuming normal
   admission. Do not infer readiness from process liveness. Queued Runs stay queued and keep their IDs
   and results; no upgrade or rollback re-executes an old Run.
5. Application rollback is allowed only if the old release understands the current database. Check it
   by running `make install DATA_DIR=/path/to/.testmaster` from the old release's checkout: while the
   schema is unchanged (upgrade not yet applied) the install succeeds; after a migration it fails with
   `Database schema version N is newer than this release supports (M)` and changes neither the install
   nor the data. The only route back is a planned restore in maintenance: with the current release run
   `testmaster backup restore /backups/tm-before-upgrade --out /restore/tm --keep-schema` (without
   `--keep-schema` the restore migrates forward again and is not a rollback point), install the old
   release with `DATA_DIR=/restore/tm`, then run the restore review below. Reconcile
   revocations/tombstones and re-provision authorized secrets before choosing the restored
   workspace. Restore remains suspended and never executes queued effects automatically. Never
   overwrite the live directory or loosen current policy to make the old app boot.
6. Rollback never reinstalls a revoked image or reopens an older policy. `testmaster image revoke
   <sha256:id> --reason …` records a durable revocation: image-lock verification (worker start,
   readiness, Python discovery), `db upgrade` and `make install DATA_DIR=…` refuse that ID, and a
   restore merges the live revocations into the restored data directory. Install, upgrade and
   rollback never write `~/.config/testmaster` (policy, profiles, vault key), secrets or tombstones; a
   restored workspace keeps admission `suspended_restore` and drops server tokens until the explicit
   review. Approvals and grants revoked after the backup are not merged automatically; the
   review's `--revocations-confirmed` assertion is the operator's reconciliation step.

The single-user backup is manual. Evidence: `packages/persistence/src/upgrade.test.ts`,
`tools/src/distribution/release-lifecycle.test.ts`, `packages/application/src/release.test.ts` and
`validation/results/ops-038-local-upgrade-rollback-smoke.log` (real temp-prefix run between the two
consecutive commits that differ by migration 0008).

## Incident containment

Use a local fixture for tabletop exercises. Record UTC timeline, correlation/request/run/attempt IDs,
actor, method/reviewer, confirmed versus suspected impact and each stop condition. Preserve DB/WAL,
sealed manifests, images lock, redacted configuration, audit export and bounded logs before repair.
Do not edit SQLite manually, remove a failed assertion, discard a negative control, or export secret
payloads as evidence.

| Incident | Authorized implemented containment | Stop condition / preserved data |
|---|---|---|
| Suspected sandbox or egress bypass | A: `testmaster ops workers pause --reason "<why>"` stops every local and remote worker from claiming the workspace's Runs while running Attempts finish, then `worker drain`, `worker stop`; X: `run cancel <run>`, `testmaster tunnel stop <id> --endpoint <url>` closes a tunnel and its streams; stop controller, isolate host network as host operator | Do not restart until policy/image/seccomp and an independent boundary review pass. Keep labels, runtime facts, egress logs and original outcome. No rootless/multi-tenant certification inferred. |
| Secret/token exposure | A: revoke affected capability through authorized token service; `secret remove <id>` or rotate with `secret rotate <id> --from-env VAR`; X cancel affected runs, A drain/stop | Preserve secret-reference versions, release/auth denials and revocation audit, not values. Do not restore a backup without merging current revocations. Local token revocation is an application service, not a promised CLI command. |
| Compromised/unavailable model | A/W as required: remove the provider from `allowedModelProviders` in `~/.config/testmaster/policy.json` (read when the application starts; restart a running server or worker), drain affected exploration/agent work; run deterministic replay without provider | Do not resume generation until provider authorization and grounded outputs are reviewed. Keep ModelCall usage/errors and accepted revision hashes; never rewrite deterministic verdict. |
| Worker loss or uncertain external mutation | A: `worker reconcile --dry-run`, inspect run/resource evidence, then authorized `worker reconcile`; use explicit `resource cleanup` with resource-bound approval when applicable | Unknown effect is not a retry license. Preserve intent/created/uncertain handles, fences and cleanup results; stop if ownership proof is unavailable. |
| Disk pressure or artifact tampering | A drain/stop; `backup create` only when safe space is available; preserve intact committed bundles and the partial failure, restore into an isolated directory if needed | Never delete active bundles or metadata to manufacture completeness. Stop if hashes or provenance disagree; no direct database repair. |
| Migration/startup incompatibility | Stop controller/worker; preserve migration checksums/status and pre-upgrade backup; follow isolated rollback procedure above | Never downgrade schema in place or bypass compatibility refusal. |

Workspace claim pause (`testmaster ops workers pause --reason "<why>"`, resumed with
`testmaster ops workers resume --reason "<why>"`) and the remote tunnel kill
(`testmaster tunnel stop <id> --endpoint <url>`, refused to a viewer) are implemented; the `ops`
status, admission and claim commands also accept `--endpoint <url>`. There is no implemented
independent audit anchoring, S3 outage repair or webhook replay. Those incident rows remain
explicitly unavailable, not fictitious executable procedures. Local auth/secret/export denials are
audited with redacted refs and correlation IDs. Audit integrity verification detects changed exported
bytes; a locally recomputed hash is not independent tamper-proof anchoring.

Loopback failed-auth requests share an installation-wide burst of 20, replenished one per second;
changing token guesses or forwarded addresses cannot reset it. Exhaustion returns 429 and
`Retry-After: 1` temporarily even for valid credentials; `/v1/health/live` remains reachable. Expired,
wrong-audience/workspace and revoked tokens never authenticate. Sensitive operations record a
requested audit event before effects and refuse when the mandatory audit write fails.

```bash
testmaster --output json audit export --out audit.json
# Retain the returned data.sha256 outside the export directory, then verify the exact bytes:
testmaster --output json audit verify audit.json --sha256 INDEPENDENTLY_RETAINED_DIGEST
```

The admin export is exclusively created mode 0600 and validates ordered workspace events, contracts
and unique IDs. Preserve the digest independently: control of both export and digest permits
replacement and is not external cryptographic anchoring. CLI token secrets never belong in argv.

## Tabletop record

Review of the six rows of the incident table above, local fixtures only: nothing here touches a production
target and no row is reported as exercised without an automated test. Roles are the scope letters
of the daemon section (R reads, W authors, X executes/cancels, A administers and revokes).

### Exercised incidents

- Worker loss or uncertain external mutation: `validation/journeys/crash-recovery.docker.test.ts`,
  `validation/journeys/commit-retry.docker.test.ts` and `packages/application/src/runtime-control.test.ts`
  cover killed publication, duplicate reconcilers and run cancellation.
- Disk pressure or artifact tampering: `packages/application/src/upload-outage.test.ts` and
  `packages/persistence/src/disk-pressure.docker.test.ts`.
- Migration/startup incompatibility: `packages/persistence/src/migration-startup.test.ts`.
- Compromised/unavailable model: `packages/application/src/ai/core.test.ts` covers the provider allowlist refusal and
  a compromised endpoint that cannot redirect the controller.
- Worker drain/stop and the viewer refusal used by every row: `packages/application/src/governance-runtime.test.ts`.

### Unexercised incidents

- Suspected sandbox or egress bypass: `worker drain` and `worker stop` are exercised, but isolating the
  host network and the independent boundary review are host-operator actions with no executable drill.
- Secret/token exposure: single commands (`secret remove`, drain, cancel) are tested, but the whole
  containment sequence has not been run end to end, and local token revocation is an application
  service, not a CLI command.

### Resumption decider

- Suspected sandbox or egress bypass: A decides, only after the independent boundary review passes.
- Secret/token exposure: A decides, after current revocations are merged and affected secrets rotated.
- Compromised/unavailable model: A decides, after provider authorization is reviewed.
- Worker loss or uncertain external mutation: A decides, after `worker reconcile` leaves no uncertain handle.
- Disk pressure or artifact tampering: A decides, after hashes verify and the free bytes hold the admitted Runs' worst-case evidence.
- Migration/startup incompatibility: A decides, after the isolated restore review completes.

## JUnit consumer limitations

JUnit is a lossy interoperability export, not the canonical Run/evidence model. One testcase per Run
cannot fully represent individual steps/Attempts, dependency expansion, semantic judgments, all
artifact manifests, partial/stale evidence or approval history. `cancelled` becomes skipped;
blocked/inconclusive and business-pass/cleanup-failed become errors. Consumers that consider skipped
successful must also read canonical `outcome`, `gate`, `cleanupOutcome`, `passedOnRetry` and revision/
snapshot properties and enforce the independent CLI gate/exit code. Excluded members/reasons are
suite properties, never executed testcase totals; quarantine remains M3 unavailable.

`system-out` retains at most 1 MiB of source detail with `systemOutTruncated` explicit; XML characters
are escaped and aggregate output over 16 MiB is refused. Use JSON or split the selection instead of
silently losing the canonical result. Null monotonic durations omit XML time rather than invent zero.

## Governance and clean reproduction

After committing the full candidate, the orchestrator runs
`node validation/journeys/reproduce-clean-checkout.mjs .`, which writes the write-once record
`validation/results/clean-checkout/<commit>.json` (a failed reproduction gets its own
`<commit>.failed-<UTC>.json`; a `.json` second argument is refused).
It clones into a private temporary checkout, uses a populated local pnpm store with frozen offline
installation, clears key/token/secret environment variables, builds, runs unit tests and exercises
canonical CLI capabilities/scaffold/init. Failed commands are recorded; no-key/offline flags are not
a substitute for the separate real replay network-boundary tests. License publication remains
blocked until explicitly approved; release decisions come from the automated release evaluation
record ([ADR-012](../adr/012-automated-only-validation.md)), not a human sign-off.

Release traceability requires explicit positive/negative scenario labels and protected assertion
text/path controls. An uncovered item needs `blockedReason`, not a silent green `implemented` row.
Capability mappings include every announced advanced feature with its milestone gate and residuals.
Per-area targets/observations/intervals/n cannot compensate an open critical security/evidence finding;
waivers have owner/expiry/noncritical severity/requirement/public capability effect, never cover core
invariant violations. The orchestrator owns registry migration and the release evaluation record.

## Vault keys and isolated restore review

```bash
testmaster secret key-status
testmaster secret rewrap
testmaster secret retire-key OLD_KEY_ID          # preview only
testmaster secret retire-key OLD_KEY_ID --apply  # refuses any remaining old-key ciphertext
```

Vault ciphertext envelopes carry a key ID. Rewrap preserves old-key material until every owned
ciphertext has been replaced; retirement is explicit, admin-authorized and audited. Key files remain
outside database backups. A missing or retired key fails secret release, never creates replacement
plaintext or silently restores an older credential.

Open only the isolated restored data directory before review; never point these commands at the live
workspace. Inspect incomplete evidence and reconcile current revocations first:

```bash
TESTMASTER_DATA_DIR=/restore/tm testmaster backup review
TESTMASTER_DATA_DIR=/restore/tm testmaster backup review --apply --revocations-confirmed
TESTMASTER_DATA_DIR=/restore/tm testmaster backup resume-run RUN_ID          # preview
TESTMASTER_DATA_DIR=/restore/tm testmaster backup resume-run RUN_ID --apply
testmaster artifact repair-references                                    # preview
testmaster artifact repair-references --apply
```

Incomplete evidence additionally requires `--accept-incomplete-evidence`. Review opens admission only
after the explicit operator decision; resuming a restored nonterminal Run records a separate attempt
decision and refuses unsafe repeated effects. Reference repair recomputes available object references
transactionally; recent backup object holds prevent GC from deleting protected objects.

Pending uploads are bounded to eight leases and 100 MiB per workspace. Storage failures emit a durable
alert without marking the upload complete. Stop new uploads, preserve leased staging and audit state,
restore space, and let expired leases be reconciled; never bypass the backlog ceiling or fabricate an
upload hash. A nonsparse control-plane reserve supports recording the storage failure, not continued
target execution.

## M3 strict history and cause observations

Flake studies freeze source checkout/assessed SHA, revision, environment, runtime image/identity and
seed, and execute serial first attempts with healing off. Accumulation rejects changed identities in
`incompatible`, separately from the accepted cohort's classification and observation window. A
passing diagnostic rerun or infrastructure retry is not another strict-study sample.

`failureCauses` binds each observed cause to its persisted first Attempt and step (or Attempt-level
reason) with a content hash. A recorded HTTP transport failure is environment evidence, not a
business-assertion failure; infrastructure-only cause observations report `unstable_infrastructure`.
Assertion mismatches report `product_or_contract`, not a certain source-level defect. Unknown causes
stay unknown. Repetition counts never certify independent samples or confirm intermittent causes;
independent target/network fault confirmation remains separate evidence.

Blocked and inconclusive samples never reach a verdict, so they stay out of the failure estimate
(`counts.nBlocked`, `counts.nInconclusive`; the report limitations name their share). With no
failure observed, a study whose blocked or inconclusive samples are at least half of the terminal
ones reports `unstable_infrastructure` instead of `passing_observed`; a failure observed next to
blocked samples keeps its failure-based classification.

Run and batch comparisons discriminate revision origin, generation ModelCall ID and visual baseline
references, including frame-local assertions. Baseline-reference comparison does not enable M5
visual matching. Batch members match logical test/environment/matrix identity, not array order;
duplicate logical keys are explicitly incomparable rather than arbitrarily paired.
