# Disaster recovery (server profile, M4)

This page is the checklist for host loss, database loss and key loss on the PostgreSQL + filesystem
evidence profile. Procedures use the commands of [backups.md](backups.md). Numbers on this page are
**proposed objectives or measured rehearsal results, never both mixed**: measured values live only in
`validation/results/m4-dr-rehearsal.json` and are quoted from there. A rehearsal that was not run stays
"not measured".

Out of scope here: S3-compatible storage and the S3 loss rehearsal (deferred to M5), distributed
deployments and distributed SLOs (M5), Windows and macOS hosts (M6). The server profile refuses an S3
storage configuration; there is no S3 recovery procedure to follow.

## Objectives

| Item | Proposed objective (`specs/08-operations.md` §8.1) | Measured |
|---|---|---|
| RPO, server profile with daily backup | 24 h (the backup interval) | `rpoSeconds` of `validation/results/m4-dr-rehearsal.json`: 2.6 s between the end of `backup create` and the loss (the rehearsal takes the backup right before the loss, so this number says nothing about a daily cadence) |
| RTO, reference installation | 4 h | `rtoSeconds`: 8.9 s from the loss to a restored, compared and access-checked database (provision 2.1 s, `backup restore` 1.8 s, verification 4.9 s) on a 400 KB backup with two evidence objects |
| Point-in-time recovery | none claimed | not applicable |

The rehearsal ran on one Linux x64 host with PostgreSQL in a local container: a backup of five files
(two evidence objects) and 31 compared database rows. The record also holds the hash comparison, the access checks and
every step duration. Measured values do not extend to larger datasets or to a network volume: the
capacity benchmark in [capacity.md](capacity.md) covers load, not restore time. Anything the file does
not record is not measured. Copy none of these numbers into other documents without the file path and
commit.

## What is and is not recoverable

| Asset | Recoverable from | Notes |
|---|---|---|
| Database rows (workspaces, Runs, verdicts, audit, alerts, incidents) | Latest verified backup | Anything written after that backup is lost (data loss window up to the RPO). |
| Evidence objects | Backup, when not listed in `missingObjects` | Objects written after the backup, expired objects and objects missing at backup time are lost; the Run keeps its verdict and the artifact is marked missing or partial. |
| Secret values | Not in backups | Needs `masterKeyFile` plus a separate copy of the secret ciphertext directory under the evidence root, or re-provisioning with `testmaster secret set`. |
| Master key (`security.masterKeyFile`) | Operator's offline copy only | Without it every stored secret ciphertext is permanently unreadable. |
| Backup key (`security.backupKeyFile`) | Operator's offline copy only | Without it every backup made with it is permanently unreadable. |
| Tokens, sessions, signing keys | Not recoverable by design | Dropped by restore; clients re-authenticate. |
| Queued and in-flight jobs | Rows restored but not dispatchable | Reconcile or resume per Run after review; uncertain external mutations are never resumed. |
| Server configuration, TLS material, release artifacts | Operator's configuration management | Not in backups. |
| Revocations and tombstones made after the backup | Replayed only when the previous database was reachable | Otherwise declared unavailable and review needs `--ledger-loss-accepted`. |

Restore never resurrects access to deleted or revoked data and never changes a Run's verdict.

## Preconditions to check every quarter

* Backups exist off-host and the destination is not writable by the server user (see the separation
  table in backups.md). The last backup is younger than 24 h (`backup_freshness`, no `backup_failing`).
* The backup key and the master key each have an offline copy in a place that does not share failure or
  access with the live key or the destination. Verify the copy's SHA-256 equals the key id printed by
  `testmaster server keygen`.
* A restore into a scratch stack succeeded within the last quarter and before the last database or
  storage upgrade; its record is in `validation/results/m4-dr-rehearsal.json` or the successor named in
  the release notes.
* Release artifacts and the deployment recipe (`deploy/`) can be fetched without the lost host.

## Host loss

The database and evidence volumes survive, the host is gone or untrusted.

1. Declare an incident (`testmaster ops incident create`, category `outage`; `isolation_loss` if the host
   may be compromised). Do not restart services on the old host.
2. Provision a replacement host from the deployment recipe and the same release. Attach or restore the
   configuration, TLS material and both key files with the same ownership model as before (server user
   and backup user separate).
3. Volumes intact: start PostgreSQL on the volume and run `testmaster server readiness --config`. If the
   volumes cannot be proven consistent, treat it as database loss below.
4. Start the server. Run `testmaster ops reconcile preview`, review it, then `testmaster ops reconcile apply`: expired leases and orphaned attempts are closed `inconclusive`, never
   `passed`.
5. If the old host could have been compromised, rotate secrets, revoke tokens and treat every integration
   as exposed before enabling anything.

## Database loss

Database destroyed or corrupted, evidence volume intact or lost.

1. Stop server, workers and agent. Preserve what remains.
2. Pick the newest backup that verifies (`POST /v1/operations/restores`, or the agent on the recovery
   host). If the damaged database is still readable, keep it reachable: the restore replays its
   post-backup revocations and tombstones.
3. Restore into a fresh database and evidence root with `testmaster backup restore --mode server`.
4. Review and release isolation (backups.md). Reconcile what changed after the backup: Runs queued or
   finished since then are absent; ask users to resubmit; do not fabricate their results.
5. Record durations and the measured data-loss window for the next rehearsal file.

Evidence volume lost but database intact: restore the evidence objects from the latest backup into the
evidence root or accept missing artifacts; either way run `testmaster artifact repair-references`
preview before applying, and treat artifacts that cannot be recovered as `missing`. Do not edit rows to
make artifacts look available.

## Key loss

| Lost | Effect | Recovery |
|---|---|---|
| `masterKeyFile` | Stored secret ciphertexts unreadable; secret references remain. | Restore the key from the offline copy. If none exists, create a new key, mark every dependent secret reference revoked, re-provision each secret and treat the incident as `secret_exposure` only if the key may also have leaked. Credentials of external targets stay valid until you rotate them at the target. |
| `backupKeyFile` | Existing backups unreadable. | Restore from the offline copy. Otherwise create a new key (`server keygen`), take a fresh backup immediately and treat the old backups as lost: the RPO is now the time since that fresh backup. |
| Either key, possibly leaked | Anyone with the key and the files can read secrets or backups. | Rotate: new key, re-wrap secrets (`secret rewrap`, `secret retire-key`), new backups; delete or re-encrypt old backups according to your retention decision; open a `secret_exposure` incident. |

A key whose hash does not match the manifest key id is refused before any restore step
(`backup_key_mismatch`); never try to "fix" a manifest.

## Rehearsal record

`validation/results/m4-dr-rehearsal.json` is produced by `deploy/compose/dr-rehearsal.sh`, which loses
the source stack, restores into a fresh database and evidence root with only the backup directory and
the two key files, and compares content hashes. It states: backup id and manifest, the loss definition,
timestamps of every step, the restored database and evidence hash comparison, the access checks of the
restored owner and of a stale operator token, the isolation checks (isolated after restore, release
refused before the review, isolation surviving a server start, release after `backup review --mode
server`), `rpoSeconds` and `rtoSeconds`. Use those two fields as the only source of observed numbers.
The S3 loss case is recorded as `deferred` to M5. A missing file means the rehearsal did not happen and
no recovery SLA is offered.
