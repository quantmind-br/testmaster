# Server backups and restore (PostgreSQL profile, M4)

Scope: the multi-user server profile (PostgreSQL + filesystem evidence). The single-user SQLite
backup is described in [local-operations.md](local-operations.md). S3-compatible storage is an M5
capability and is refused at startup; nothing here covers S3 objects. Encryption rationale:
[ADR-019](../adr/019-at-rest-encryption.md). Recovery checklists: [disaster-recovery.md](disaster-recovery.md).

## Configuration

```json
{
  "security": {
    "masterKeyFile": "/etc/testmaster/master.key",
    "backupKeyFile": "/etc/testmaster-backup/backup.key",
    "atRestEncryption": { "database": "operator-volume", "evidence": "operator-volume" }
  },
  "backup": {
    "destination": "/mnt/offhost/testmaster-backups",
    "schedule": "daily",
    "retention": { "daily": 7, "weekly": 4, "monthly": 3 },
    "pgDump": ["pg_dump"],
    "pgRestore": ["pg_restore"]
  }
}
```

| Field | Meaning |
|---|---|
| `backup.destination` | Absolute directory; should be an off-host or separately credentialed mount. |
| `backup.schedule` | `daily` (default when `backup` is set) or `disabled` (on-demand only). |
| `backup.retention` | Backups to keep per bucket, integers 0–3650; default 7 daily, 4 weekly, 3 monthly. |
| `backup.pgDump`, `backup.pgRestore` | argv prefix of the PostgreSQL client tools, for example a container wrapper. |
| `backup.allowSharedAccess` | Operator accepts that one OS identity holds the backup key and the destination together with the server. Leave unset in production. |
| `security.backupKeyFile` | 32 random bytes, regular file, mode 0600, one hard link, owned by the reading user, not a symlink. Create with `testmaster server keygen --out <path>`; it prints the key id. |

`security.atRestEncryption` is an operator attestation: TestMaster encrypts backups itself but does
not verify encryption of the PostgreSQL or evidence volumes.

## Layout

```text
<backup.destination>/
  20261013T020000Z-<backupId>/        # <compact UTC time>-<backupId>, created by rename when finished
    manifest.json                     # plaintext, HMAC-authenticated
    database.dump.enc                 # pg_dump custom format, --serializable-deferrable
    evidence-index.json.enc           # artifact refs, missing objects, completeness
    evidence/<storage key>.enc        # artifact objects and run manifest.json/meta.json files
  .partial-<backupId>/                # unfinished or failed copy; never listed as a backup
```

* The database dump uses `--serializable-deferrable`, so it is one consistent snapshot taken while
  Runs execute. Evidence objects are then copied and hashed against the recorded artifact hash and
  size; an object that is missing, changed or has the wrong size is listed in
  `manifest.missingObjects` and the backup is marked **incomplete**, never green. A failed backup
  removes its `.partial-*` directory, records `backup:last-failure` and raises `backup_failing`.
* `manifest.json` records schema and database versions, engine, key id, chunk size, a config digest
  and the list of files with ciphertext size and SHA-256. It never contains secret values
  (`secretIncluded: false`).
* **Manifests are plaintext.** File names under `evidence/` are storage keys that contain workspace,
  Run and Attempt IDs. Restrict read access to the destination to the backup user and recovery
  operators.
* Backups hold the artifacts they captured against physical deletion for 48 hours after creation,
  and mark fixture inputs the same way, so a concurrent GC cannot remove an object mid-copy. Backups
  already written are not erased by workspace deletion requests; they leave with backup retention.

Not in a backup: secret values and the secret ciphertext files, `security.masterKeyFile`,
`security.backupKeyFile`, the server configuration file, TLS material and container images. See
[disaster-recovery.md](disaster-recovery.md) for how to protect them separately.

## Encryption and keys

* AES-256-GCM over a chunked stream: 64 KiB chunks, a random 8-byte nonce prefix plus a 4-byte chunk
  counter (no repeated nonce within a stream), and additional authenticated data that binds the header,
  the file's path inside the backup, the chunk counter and a final-chunk flag. Reordered, dropped,
  truncated or relocated chunks fail authentication.
* The backup key id is the SHA-256 of the key file and is stored in the manifest. Verification and
  restore refuse a different key (`backup_key_mismatch`). The manifest MAC is an HMAC over the canonical
  manifest, keyed with a subkey derived from the backup key; a backup whose MAC does not verify is
  listed as unauthentic and is never deleted automatically.
* There is no key rotation for existing backups. To change the key, create a new key, take a new
  backup with it and keep the old key until the last backup made with it has left retention.
* Losing `backupKeyFile` makes every backup made with it unreadable. Keep an offline copy of the key in
  a different place and under different access than the destination.

## Separate backup agent

The server process never reads `backupKeyFile`. Backups run in a second process under a different OS
user:

```bash
testmaster backup agent --config /etc/testmaster/server.json
```

| Identity | Reads | Writes |
|---|---|---|
| Server and worker user | master key, PostgreSQL, evidence root | PostgreSQL, evidence root |
| Backup agent user | backup key, PostgreSQL (via the configured credentials), evidence root (read-only is enough) | `backup.destination` |

At startup the server refuses to run when it can read the backup key or write the destination, unless
`backup.allowSharedAccess` is set. A compromised server therefore cannot read or delete past backups.
The agent:

* fulfils on-demand requests created with `POST /v1/operations/backups` (admin scope, `reason`
  required; the request is an audited operation record the agent completes);
* runs the daily schedule unless `schedule` is `disabled`;
* applies retention after each backup;
* fulfils restore **verification** requests (below).

If the agent is stopped, requests stay `requested`, and `backup_failing` fires once the last
successful backup is older than 24 hours.

## Retention of backups

The default is 7 daily, 4 weekly and 3 monthly backups. For each bucket type the newest backup of each
of the most recent N UTC days, ISO weeks and months that have a backup is kept; a backup kept by any
bucket is kept. Everything else that is authentic is removed from the destination. Unauthentic entries
(MAC mismatch, unreadable manifest) are reported and never removed automatically. Backup retention is
independent of [run and audit retention](retention.md).

## Verification

Verification is non-destructive and is the check that a backup is usable:

```bash
curl -X POST "$TM/v1/operations/restores" -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"backupId":"<backupId>","reason":"quarterly restore check"}'
curl "$TM/v1/operations/<operation id>" -H "authorization: Bearer $ADMIN_TOKEN"
```

The agent checks the manifest MAC and key id, every file's ciphertext hash, decrypts and authenticates
every file, compares each evidence object with the hash in the evidence index and lists the dump table
of contents with `pg_restore --list`. The result reports `filesChecked`, `evidenceObjects`,
`archiveEntries`, `keyId` and `complete`. Verification never touches the live database. It does not
replace a restore rehearsal: run one at least quarterly and before a database or storage upgrade
(OPS-026) and record the measured numbers in `validation/results/m4-dr-rehearsal.json`.

## Restore procedure

Destructive restore is **operator-only**: there is no HTTP route for it. Run it on the host, as the
backup user, against a **fresh** target.

Prerequisites: an empty PostgreSQL database reachable with the configured TLS settings (a restore
refuses a populated schema other than its own interrupted attempt), an empty evidence root, a server
configuration whose `security.backupKeyFile` is the key the backup was made with, and a release whose
migrations are at least as new as the backup's database version (`backup_version_unsupported`
otherwise). The restore migrates forward to the running release.

1. Stop the server, workers and agent that use the target. Preserve the failed database and evidence
   root; do not delete them before the review ends.
2. Choose a backup (`manifest.json` `createdAt`) and verify it as above, or run the restore on a copy
   first.
3. Restore:

   ```bash
   testmaster backup restore --mode server --config /etc/testmaster/server.json \
     /mnt/offhost/testmaster-backups/<compact time>-<backupId>
   ```

   The command verifies the manifest and every file before touching the target, restores evidence
   objects (each re-hashed), loads the dump with `pg_restore`, migrates, applies the isolation
   described below and prints `evidenceComplete`, `evidenceRestored` and `postBackupLedger`
   (`replayed` when the previous database was still reachable and its revocations and tombstones were
   replayed, `unavailable` otherwise). It is crash-safe: while it is unfinished the database refuses to
   open, and running it again wipes the half-restored target and produces the same result.
4. Start the server. It comes up **isolated**.
5. Review (below), then release isolation.

### What the restore preserves and what it tightens

IDs, Run verdicts, snapshots, history and the audit trail are preserved. The restore only tightens
access: workers are offline; leases are not dispatchable and in-flight jobs are marked
`reconciliation_required`; outbox delivery is off; all server tokens, sessions and cursor signing keys
are dropped or revoked (clients must log in or be issued tokens again); integrations are paused;
schedules are paused; admission is `suspended_restore`; `operational_state['restore:isolated']='true'`.
Revocations and tombstones that were recorded after the backup are replayed when the old ledger was
readable. Nothing restored executes automatically and no request is sent to a target.

### Review and release

```bash
testmaster backup review                      # dry run: active Runs, missing artifacts, ledger state
testmaster backup review --apply --revocations-confirmed \
  [--accept-incomplete-evidence] [--ledger-loss-accepted]
testmaster backup resume-run <run-id> [--apply]   # per Run, after review; creates a fresh Attempt
testmaster ops isolation release --reason "<why>"
```

(Add `--mode server --config <path>` as for the restore, and `--workspace <id>` on a multi-workspace server: review and release apply to one workspace.) `--revocations-confirmed` asserts that
you reconciled consents, approvals, tokens and secret revocations made after the backup.
`--accept-incomplete-evidence` is required when the backup was incomplete or artifacts are
`missing`/`partial`; `--ledger-loss-accepted` is required when `postBackupLedger` is `unavailable`,
because exclusions and revocations after the snapshot cannot then be guaranteed. `ops isolation release`
fails with `restore_review_pending` until the review is applied and with `not_isolated` when the
workspace is not isolated. Releasing isolation does **not** re-enable integrations or schedules:
enable each one deliberately. Re-provision secrets (`testmaster secret set`) that were not copied by
other means before resuming any Run that needs them. Uncertain external mutations are never resumed
(`POLICY_DENIED`); use a new reviewed Run.

After release: check `GET /v1/health/ready`, run a healthy replay and confirm `/v1/alerts` is empty or
understood before announcing recovery.

## pg_basebackup and WAL archiving (operator option)

Operators who already run `pg_basebackup` plus WAL archiving may keep doing so beside TestMaster
backups. TestMaster does not create, verify, monitor or restore them, and **no point-in-time recovery
(PITR) is claimed**: the proposed RPO of the server profile is the backup interval, 24 hours with the
daily schedule, and no shorter RPO has been measured or promised. A database recovered by WAL replay
does not pass through the restore tightening above (tokens, leases, outbox, integrations and
schedules are not reset) and WAL does not cover the evidence root, which needs its own snapshot of the
same instant. Keep the server stopped, treat the state as unreviewed, and prefer restoring a TestMaster
backup unless the WAL path has been rehearsed by you.

## Failure and alert map

| Symptom | Reason code / alert | Action |
|---|---|---|
| Key file unreadable or wrong mode | `key_file_unavailable`, `key_file_invalid` | Fix owner, mode 0600 and size 32 bytes. |
| Manifest or file mismatch | `backup_manifest_mac`, `backup_integrity`, `backup_key_mismatch` | Treat the backup as unusable; use the next older one; investigate tampering. |
| Missing evidence objects | incomplete backup, `backup_failing` | See [alerts.md](alerts.md#backup_failing). |
| Restore target populated | `restore_target_not_empty` | Provision a fresh database and evidence root. |
| Backup newer schema than release | `backup_version_unsupported` | Run a release that has the migrations. |
