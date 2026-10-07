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
Vault ciphertext envelopes carry authenticated encryption and a content-derived key ID.
Rewrap retains prior keys during atomic per-object updates; interruption can be retried. Retirement
refuses active keys or any still-referencing ciphertext and durably records a retired-key denylist
before deleting old key bytes. Preserve segregated vault/key recovery material; missing or retired
keys fail release, never create a replacement or resurrect a revoked secret.

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

## Upgrade and rollback (maintenance only)

1. Preserve the release commit, `containers/images.lock.json`, `testmaster db status`, redacted
   `testmaster config show`, existing policy, vault/key metadata and revocation/tombstone history.
   Keep private keys and plaintext tokens outside the backup/evidence archive.
2. As A, run `testmaster worker drain`, inspect `testmaster worker status`, and wait for accepted
   attempts to finish. Stop the foreground controller with SIGTERM; do not migrate under a serving
   old controller. If draining exceeds its bound, preserve attempt logs and reconcile, never mark
   attempts passed.
3. `testmaster backup create --out /backups/tm-before-upgrade` using the currently compatible app.
   Preserve its manifest and old application/image lock. Check free space for a second DB/evidence
   copy plus migration table-rebuild workspace; SQLite migration may lock the whole local DB.
4. Install the reviewed candidate, verify `testmaster doctor`, then `testmaster db migrate`.
   Migration files are forward-only/checksummed. An exclusive in-progress migration rejects a
   second migrator. Stop on checksum, unsupported DB/controller version, lock or space refusal;
   never delete a lock without investigating its owner or change an applied migration.
5. Start the controller, verify authenticated readiness and worker capability/image digests, and
   perform an authorized healthy replay before resuming normal admission. Do not infer readiness
   from process liveness.
6. Application rollback is allowed only if the old binary understands the current DB migrations,
   document schemas, current policy and approved images. Otherwise stop service and
   `testmaster backup restore /backups/tm-before-upgrade --out /restore/tm` to an isolated directory.
   Reconcile revocations/tombstones and re-provision authorized secrets before choosing the restored
   workspace. Restore remains suspended and never executes queued effects automatically. Never
   overwrite the live directory, resurrect a revoked image/token or loosen current policy to make
   the old app boot.

The single-user backup is manual. Independent component rolling upgrades, release signatures/license
approval and distributed rollback remain later/release gates; this procedure does not certify them.

## Incident containment

Use a local fixture for tabletop exercises. Record UTC timeline, correlation/request/run/attempt IDs,
actor, method/reviewer, confirmed versus suspected impact and each stop condition. Preserve DB/WAL,
sealed manifests, images lock, redacted configuration, audit export and bounded logs before repair.
Do not edit SQLite manually, remove a failed assertion, discard a negative control, or export secret
payloads as evidence.

| Incident | Authorized implemented containment | Stop condition / preserved data |
|---|---|---|
| Suspected sandbox or egress bypass | A: `worker drain`, `worker stop`; X: `run cancel <run>`; stop controller, isolate host network as host operator | Do not restart until policy/image/seccomp and an independent boundary review pass. Keep labels, runtime facts, egress logs and original outcome. No rootless/multi-tenant certification inferred. |
| Secret/token exposure | A: revoke affected capability through authorized token service; `secret remove <id>` or rotate with `secret rotate <id> --from-env VAR`; X cancel affected runs, A drain/stop | Preserve secret-reference versions, release/auth denials and revocation audit, not values. Do not restore a backup without merging current revocations. Local token revocation is an application service, not a promised CLI command. |
| Compromised/unavailable model | A/W as required: `consent revoke --provider <id>` for project, drain affected exploration/agent work; run deterministic replay without provider | Do not resume generation until provider authorization, consent, budgets and grounded outputs are reviewed. Keep ModelCall usage/errors and accepted revision hashes; never rewrite deterministic verdict. |
| Worker loss or uncertain external mutation | A: `worker reconcile --dry-run`, inspect run/resource evidence, then authorized `worker reconcile`; use explicit `resource cleanup` with resource-bound approval when applicable | Unknown effect is not a retry license. Preserve intent/created/uncertain handles, fences and cleanup results; stop if ownership proof is unavailable. |
| Disk pressure or artifact tampering | A drain/stop; `backup create` only when safe space is available; preserve intact committed bundles and the partial failure, restore into an isolated directory if needed | Never delete active bundles or metadata to manufacture completeness. Stop if hashes or provenance disagree; no direct database repair. |
| Migration/startup incompatibility | Stop controller/worker; preserve migration checksums/status and pre-upgrade backup; follow isolated rollback procedure above | Never downgrade schema in place or bypass compatibility refusal. |

There is no implemented global tenant pause, independent audit anchoring, remote tunnel kill, S3
outage repair, webhook replay or multi-user grant editor in M0–M2. Those incident rows remain explicitly
unavailable, not fictitious executable procedures. Local auth/secret/export denials are audited with
redacted refs and correlation IDs. Audit integrity verification detects changed exported bytes; a
locally recomputed hash is not independent tamper-proof anchoring.

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
`node validation/journeys/reproduce-clean-checkout.mjs . validation/results/clean-checkout-no-key.json`.
It clones into a private temporary checkout, uses a populated local pnpm store with frozen offline
installation, clears key/token/secret environment variables, builds, runs unit tests and exercises
canonical CLI capabilities/scaffold/init. Failed commands are recorded; no-key/offline flags are not
a substitute for the separate real replay network-boundary tests. License publication and independent
release sign-off remain blocked until explicitly approved.

Release traceability requires explicit positive/negative scenario labels and protected assertion
text/path controls. An uncovered item needs `blockedReason`, not a silent green `implemented` row.
Capability mappings include every announced advanced feature with its milestone gate and residuals.
Per-area targets/observations/intervals/n cannot compensate an open critical security/evidence finding;
waivers have owner/expiry/noncritical severity/requirement/public capability effect, never cover core
invariant violations. The orchestrator owns registry migration and release sign-off.

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

Run and batch comparisons discriminate revision origin, generation ModelCall ID and visual baseline
references, including frame-local assertions. Baseline-reference comparison does not enable M5
visual matching. Batch members match logical test/environment/matrix identity, not array order;
duplicate logical keys are explicitly incomparable rather than arbitrarily paired.
