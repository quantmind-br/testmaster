# Alerts and runbooks (server profile, M4)

A controller evaluates every rule per workspace. An alert is unique per `(workspace, rule, subject)`:
while one is open the rule does not create a second one. When a rule fires it inserts the alert, an
outbox event `alert.fired` (delivered to configured notification channels) and an audit event. States
are `firing`, `acknowledged` and `resolved`; a rule resolves its alert when the condition has cleared.

```text
GET  /v1/alert-rules     rules, severity, owner, runbook link and thresholds
GET  /v1/alerts          alerts of the workspace
GET  /v1/operations/status   admin status: admission, isolation, backup, retention
testmaster ops alerts list | ack <id>      testmaster ops alert-rules
```

Each alert carries `owner` and `runbook` (`docs/operations/alerts.md#<rule id>`). Roles:

* **platform-operator**: runs the host, PostgreSQL, storage, workers and the backup agent.
* **security-owner**: owns isolation, tenancy, egress and secrets decisions.
* **workspace-admin**: owns workspace budgets, integrations and queue policy.

Severity means urgency: **critical** act immediately and open an incident; **high** act within the
working day and open an incident when impact is confirmed; **medium** act within the week. Stop
conditions that apply to every runbook: never edit the database by hand, never delete active evidence,
never change a Run's verdict to make a dashboard green, and never export secret values as evidence.

| Rule id | Severity | Owner |
|---|---|---|
| [`lease_expirations_abnormal`](#lease_expirations_abnormal) | high | platform-operator |
| [`queue_age_high`](#queue_age_high) | high | platform-operator |
| [`storage_warning`](#storage_warning) | medium | platform-operator |
| [`storage_critical`](#storage_critical) | critical | platform-operator |
| [`backup_failing`](#backup_failing) | high | platform-operator |
| [`dlq_not_empty`](#dlq_not_empty) | medium | workspace-admin |
| [`audit_unavailable`](#audit_unavailable) | critical | security-owner |
| [`budget_exhausted`](#budget_exhausted) | medium | workspace-admin |
| [`cancellation_stuck`](#cancellation_stuck) | high | platform-operator |
| [`tenant_violation`](#tenant_violation) | critical | security-owner |
| [`egress_denied`](#egress_denied) | high | security-owner |

## lease_expirations_abnormal

* **Owner:** platform-operator
* **Severity:** high
* **Trigger:** the number of lease expirations (`attempt.lease_expired`) in the evaluation window is above
  the rule's `threshold` (shown by `GET /v1/alert-rules`). A few expirations after a deliberate worker
  stop are normal.
* **Impact:** affected Attempts end `inconclusive` or are retried according to recorded effects, never
  `passed`; `run_platform_success` loses budget.
* **First actions:**
  1. `testmaster worker status`: are workers heartbeating (10 s) and healthy? Check host CPU, memory,
     OOM kills, Docker daemon and PostgreSQL latency; a worker that cannot reach the database cannot
     renew its 30 s lease.
  2. `testmaster ops reconcile preview` and review the proposed recovery, then `ops reconcile apply`.
  3. While the cause is unknown, `testmaster ops admission pause --reason "<why>"` to stop new work.
* **Verification:** no new `attempt.lease_expired` for one full evaluation window, workers heartbeating,
  the alert resolves, and a healthy replay finishes `passed`.
* **Escalation:** persists after a restart or affects several workers: open an incident (`outage`, high).
  Suspected host or network compromise: `isolation_loss`, critical, and notify the security-owner.

## queue_age_high

* **Owner:** platform-operator
* **Severity:** high
* **Trigger:** the oldest queued, dispatchable job is older than 300 s while live workers exist.
* **Impact:** Runs start late; `queue_wait_p95` rises. Admission still accepts work.
* **First actions:**
  1. `testmaster ops status`: admission state, queued jobs, active Runs. A paused or draining workspace
     stops claiming by design.
  2. `testmaster worker status`: free slots, required runner images and capabilities. A worker without
     the required image or with no free slot (memory, CPU, PIDs) does not claim.
  3. Look for one tenant or project filling the queue (tenant caps and fair share apply) and for
     stuck Attempts holding slots (`cancellation_stuck`).
  4. Add worker capacity only within the host's reserved headroom.
* **Verification:** the oldest queued job drops below 300 s, the alert resolves, `queue_wait_p95`
  recovers in the next window.
* **Escalation:** unresolved after one hour, or caused by saturation of the host: platform-operator
  decides capacity; open an incident (`outage`, medium or high) if Runs miss customer deadlines.

## storage_warning

* **Owner:** platform-operator
* **Severity:** medium
* **Trigger:** disk use of the evidence or database volume is at least 80 %.
* **Impact:** none yet; admission is suspended at 90 % (`storage_critical`).
* **First actions:**
  1. `df -h` on the evidence root and the PostgreSQL volume; find the growth source (evidence of
     recent Runs, WAL, backup destination if shared).
  2. `testmaster ops retention preview` to see what retention would release; let retention and GC run;
     do not shorten retention windows to hide the problem.
  3. Grow the volume or move the backup destination off the same disk.
* **Verification:** use drops below 80 % and the alert resolves; the next evaluation shows a stable
  trend.
* **Escalation:** use reaches 90 %: [`storage_critical`](#storage_critical) fires. Growth faster than
  one week of headroom: platform-operator plans capacity.

## storage_critical

* **Owner:** platform-operator
* **Severity:** critical
* **Trigger:** disk use is at least 90 %.
* **Impact:** new admission is suspended by the storage-pressure guard (the suspension recovers by
  itself when use falls; only that automatic suspension does); evidence publication can fail; the
  database and audit trail are at risk of full-disk failure.
* **First actions:**
  1. `testmaster ops admission drain --reason "storage critical"` if it is not already suspended, and
     let in-flight Attempts finish.
  2. Free space with operator-owned files first; grow the volume. Never delete active bundles, WAL,
     secret data, legal-held objects or `.partial` staging that is still referenced.
  3. `testmaster artifact repair-references` (preview, then `--apply` after review) fixes counters only.
  4. `testmaster ops reconcile preview` before applying; then check readiness.
* **Verification:** use below 90 % (ideally below 80 %), `/v1/health/ready` reports storage healthy,
  admission returns to enabled, a healthy replay passes, the alert resolves.
* **Escalation:** open an incident (`artifact_loss` if any artifact was lost, otherwise `outage`,
  high or critical). Stop and call the platform-operator lead if hashes disagree or the database
  cannot be checked.

## backup_failing

* **Owner:** platform-operator
* **Severity:** high
* **Trigger:** the newest backup failure is newer than the newest success, or no successful backup
  exists within 24 h while the schedule is `daily`, or the newest backup is incomplete
  (`missingObjects` not empty).
* **Impact:** the proposed 24 h RPO is not met; a restore would lose more data or miss artifacts.
* **First actions:**
  1. `testmaster ops status`: last success and last failure times; check the failure reason code
     (`key_file_unavailable`, `key_file_invalid`, `backup_integrity`, `storage_unwritable`,
     tool errors).
  2. Is `testmaster backup agent` running as the backup user? Is the destination mounted, writable by
     that user and not full? Is `backupKeyFile` still 32 bytes, mode 0600, owned by that user?
  3. For an incomplete backup, list `missingObjects` in the manifest and decide whether the artifacts
     are recoverable; do not call it complete.
  4. Request a fresh backup: `POST /v1/operations/backups` with a `reason`.
* **Verification:** the new backup completes with `complete: true`, `POST /v1/operations/restores`
  verification passes for it, the alert resolves.
* **Escalation:** two consecutive scheduled failures or no good backup for 48 h: incident (`outage`,
  high). If tampering is suspected (`backup_manifest_mac`), involve the security-owner.

## dlq_not_empty

* **Owner:** workspace-admin
* **Severity:** medium
* **Trigger:** at least one dead-lettered delivery or auxiliary job exists.
* **Impact:** a notification, webhook, check publication or follow-up job was given up after its
  retries. Run verdicts are unaffected.
* **First actions:**
  1. `testmaster ops dlq list`: source, subject, attempts, last error.
  2. Fix the cause (endpoint down, revoked credential, policy denial, egress allow-list).
  3. `testmaster ops dlq requeue --source <source> --id <id>` for each entry that is safe to retry.
     A requeue never reruns a test and is audited. Do not requeue entries whose external effect may
     already have happened and is not idempotent.
* **Verification:** the entry leaves the dead-letter list, the delivery succeeds or becomes a new
  documented failure, the alert resolves when the list is empty.
* **Escalation:** the same entries dead-letter again: open an incident (`other`, medium) and involve
  the integration owner; a revoked integration stays revoked.

## audit_unavailable

* **Owner:** security-owner
* **Severity:** critical
* **Trigger:** audit events cannot be written or read back (database error, full disk, permission
  failure or a failed integrity check of the audit table).
* **Impact:** sensitive operations refuse to run because the mandatory audit write fails; the trail
  of actions is incomplete or untrusted from the first failure onward.
* **First actions:**
  1. `testmaster ops admission pause --reason "audit unavailable"` where it still works.
  2. Check PostgreSQL health, disk (`storage_critical`) and permissions of the application role.
  3. Preserve the database, logs and the time of the first failure. Do not edit audit rows.
  4. After repair, export and verify the audit trail (`testmaster audit export`, `audit verify` with an
     independently retained digest).
* **Verification:** audit writes succeed, a sensitive test operation records its audit event, the
  export verifies, the alert resolves.
* **Escalation:** immediately open an incident (`other` or `isolation_loss`, critical); the window
  without audit is declared unknown, never "no data affected" without evidence.

## budget_exhausted

* **Owner:** workspace-admin
* **Severity:** medium
* **Trigger:** a model token or currency budget of a workspace or project is used up.
* **Impact:** generation, analysis and healing stop with an explicit reason; deterministic Runs already
  admitted continue and keep their verdict.
* **First actions:**
  1. Review the usage ledger (known and unknown cost shown separately) and the model calls that
     consumed it.
  2. Decide to wait for the budget period, raise the limit with a recorded decision, or leave AI
     disabled. Do not work around the budget by switching models without a price table.
* **Verification:** the next generation request is admitted under the new limit, or is refused with
  the same explicit reason; the alert resolves when budget is available.
* **Escalation:** an unexpected spike (cost not explained by planned work): incident
  (`ai_degradation`, medium) and review of the provider and consents.

## cancellation_stuck

* **Owner:** platform-operator
* **Severity:** high
* **Trigger:** a cancellation was requested and an Attempt is still running past the cancel grace
  period while its worker is alive.
* **Impact:** a slot and sandbox resources stay occupied; the Run does not reach a terminal state; the
  target may keep receiving traffic.
* **First actions:**
  1. `testmaster run cancel <run>` once more (cancellation is idempotent); read the Attempt state.
  2. `testmaster worker status`; find the container by its `io.testmaster.attempt` label and check
     whether it is stuck.
  3. `testmaster ops reconcile preview`, then `ops reconcile apply`; if the worker is unresponsive,
     `testmaster worker drain` and restart it. The reconciler records the Attempt as `inconclusive`,
     never `passed`.
* **Verification:** the Attempt and container are gone, the Run is terminal, the slot is free, the alert
  resolves.
* **Escalation:** stuck containers survive a worker restart or keep sending traffic: treat as possible
  sandbox escape or egress bypass (`isolation_loss`, critical) and notify the security-owner.

## tenant_violation

* **Owner:** security-owner
* **Severity:** critical
* **Trigger:** an audit event with action `tenant.violation.denied` is recorded: a request tried to
  reach a resource of another workspace and was denied.
* **Impact:** the attempt was refused, so no cross-tenant data is known to be exposed; it signals a
  client bug or an attack, and any bypass elsewhere would be a critical isolation loss.
* **First actions:**
  1. Read the audit event: actor, token, workspace, resource type and correlation id. Do not export
     secret values.
  2. Decide bug versus abuse. For abuse: revoke the token or session and pause the actor.
  3. Check that tenant isolation is intact: `/v1/health/ready` reports no `rls_role_bypass` or
     `rls_unprotected_tables`.
  4. Search the audit trail for allowed access by the same actor to the other workspace.
* **Verification:** isolation checks are green, no allowed cross-workspace access is found, the actor
  is fixed or revoked, the alert is resolved by the owner with a note.
* **Escalation:** any allowed cross-workspace access, failed isolation check or unexplained actor:
  incident `tenant_exposure`, critical; notify affected workspace owners privately before any public
  disclosure (see [incidents.md](incidents.md)).

## egress_denied

* **Owner:** security-owner
* **Severity:** high
* **Trigger:** the egress proxy or network boundary denied a sandbox connection (destination outside
  the allow-list, private or metadata address, or a direct connection attempt).
* **Impact:** the connection was blocked; a Run may fail or be `blocked` with the denial reason. A
  repeated or direct attempt may indicate a sandbox bypass attempt.
* **First actions:**
  1. Identify the Run, Attempt, destination and the rule that denied it (bounded logs and audit,
     redacted).
  2. If the destination is legitimate, fix the project's environment network profile; never widen the
     allow-list to private ranges or the metadata endpoint.
  3. If it looks like a bypass: `testmaster run cancel <run>`, `testmaster ops admission pause`,
     `testmaster worker drain`, and keep labels, runtime facts and the denial logs.
* **Verification:** the Run is terminal or re-run with a correct profile without denials; independent
  review of the boundary for the suspicious case; the alert resolves.
* **Escalation:** suspected bypass: incident `isolation_loss`, critical; do not restart workers until
  policy, image and seccomp profile have an independent review.

## Related

SLO definitions: [slo.md](slo.md). Incident process: [incidents.md](incidents.md). Backup commands:
[backups.md](backups.md).
