# Retention and purge (server profile, M4)

Four retention policies are independent of each other:

| Data | Policy | Described in |
|---|---|---|
| Metadata of terminal Runs | purged after **90 days** (this page) | below |
| Audit events | purged after **365 days** (this page) | below |
| Evidence objects (artifacts) | mark → tombstone → delete by expiry or deletion request; physical removal within 24 h in a healthy service | [local-operations.md](local-operations.md), `docs/development.md` |
| Backups | 7 daily, 4 weekly, 3 monthly | [backups.md](backups.md) |

The windows of the first two rows are fixed in this release: they are reported by
`testmaster ops status` (`retention.metadataWindowDays`, `retention.auditWindowDays`) and are not
configuration options. Shortening an evidence or metadata window to free disk space during an incident
is not an accepted remedy (see [alerts.md](alerts.md#storage_critical)).

## What is purged

A purge cycle of the retention controller, per workspace:

* **Run metadata.** Terminal Runs (`completed`) whose end is older than 90 days: the Run's metadata
  rows are removed. Evidence objects follow their own policy and are not removed by this step.
* **Idempotency receipts** whose expiry is older than 90 days (the metadata window), about 97 days
  after the key was first used because a receipt expires 7 days after it is stored: the stored
  replay result of an idempotency key. A key whose receipt is purged is treated as new.
* **Audit events** older than 365 days are removed after a signed summary has been written (below).

## What is never purged

* Runs that are not terminal (queued, running, cancelling) and anything an active Attempt references.
* Anything under a **legal hold** (below), including the Runs and audit events it covers (verify the hold on a preview before the first purge).
* Runs and objects that an in-progress or unexpired backup holds (a backup holds the objects it
  captured for 48 hours after it starts).
* The signed purge summaries themselves.
* Backups already written: purging live data does not alter them; they leave through backup
  retention. Restoring an old backup replays tombstones and revocations recorded since, so purged or
  deleted data is not brought back into use.

## Legal hold

A hold is a key in the operational state of the workspace; any value except `released` holds:

| Key | Holds |
|---|---|
| `retention:legal-hold:<workspaceId>` | everything in the workspace |
| `retention:legal-hold:<workspaceId>:<runId>` | one Run and its evidence |
| `retention:legal-hold:<workspaceId>:<artifactId>` | one artifact |

The database administrator sets and releases holds directly in `operational_state`, in a transaction,
and records the reason, requester and time in an incident or change record: TestMaster provides no
API or CLI for it in this release. Check holds before enabling or changing a purge
and keep the list of active holds in your records. A hold protects only while it exists: a restore
from a backup older than the hold does not contain it, so re-create holds after a restore, before
releasing isolation.

## Signed audit summary

Before audit events are deleted, the controller writes a summary row to `audit_purge_summaries`:
a record of what was purged (counts and digests), signed with
HMAC-SHA256 under a subkey derived (HKDF) from `security.masterKeyFile`. Each summary includes the
digest of the previous one, forming a chain: a missing, reordered or edited summary breaks every later
digest. The summaries prove what was purged and in which order. They do not keep the purged event
contents, and they cannot be verified without the master key; keep the master key offline copy as
described in [disaster-recovery.md](disaster-recovery.md). If the master key is lost, past summaries can
no longer be verified, and purging should be paused until a new key and a documented chain restart exist.

## Preview and run

```bash
testmaster ops retention preview   # dry run: counts of Runs and audit events that would be purged
testmaster ops retention run       # apply a cycle now (admin; audited)
testmaster ops status              # retention.lastRunAt, runsPurged, auditEventsPurged, auditSummaries
```

Preview deletes nothing and writes no summary. The controller runs the same cycle on its own
schedule; `ops retention run` is for catching up after downtime or before a planned storage review.
Run a preview, compare the counts with the expected age distribution and the active holds, and then
run. Each applied cycle updates the counters in `ops status`, and a cycle that fails part-way can be
repeated.

## Operator checklist

1. Before the first purge in a new installation: confirm the master key backup, list legal holds, and
   take and verify a backup.
2. Review `ops retention preview` counts weekly; investigate unexpected large numbers.
3. After restoring a backup, re-create legal holds and expect the next cycle to re-purge what the
   restored data holds past the windows.
4. Keep `auditSummaries` growing in step with purge runs; a gap with purged events is an
   `audit_unavailable`-class finding (open an incident).
