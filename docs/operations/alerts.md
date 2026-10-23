# Alerts and runbooks (server profile, M4)

A controller evaluates every rule per workspace. An alert is unique per `(workspace, rule, subject)`:
while one is open the rule does not create a second one. When a rule fires it inserts the alert, an
outbox event `alert.fired` (delivered to configured notification channels) and an audit event. States
are `firing`, `acknowledged` and `resolved`; a rule resolves its alert when the condition has cleared.

```text
GET  /v1/alert-rules     rules, severity, owner, runbook link and thresholds
GET  /v1/alerts          alerts of the workspace
GET  /v1/operations/status   admin status: admission, isolation, backup, retention
testmaster ops alerts list | ack <id> | evaluate      testmaster ops alert-rules
```

The alert controller runs in the server process (`server start --mode server`) every 60 s. The
single-user local profile runs no alert loop, so nothing is evaluated there on its own;
`testmaster ops alerts evaluate` (administrator scope) evaluates every rule once for the workspace
and prints `{fired, resolved, errors}`. The same dedupe applies: a condition that already has an
open alert fires nothing new. Firing alerts exit 0; a rule that cannot be evaluated is listed in
`errors`, leaves its open alerts as they are and makes the command exit 10 (platform unavailable).

Each alert carries `owner` and `runbook` (`docs/operations/alerts.md#<rule id>`). Roles:

* **platform-operator**: runs the host, PostgreSQL, storage, workers and the backup agent.
* **security-owner**: owns isolation, tenancy, egress and secrets decisions.
* **workspace-admin**: owns workspace integrations and queue policy.

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
| [`cancellation_stuck`](#cancellation_stuck) | high | platform-operator |
| [`tenant_violation`](#tenant_violation) | critical | security-owner |
| [`egress_denied`](#egress_denied) | high | security-owner |
| [`scheduler_leaderless`](#scheduler_leaderless) | critical | platform-operator |
| [`controllers_below_expected`](#controllers_below_expected) | high | platform-operator |
| [`remote_worker_heartbeat_lost`](#remote_worker_heartbeat_lost) | high | platform-operator |
| [`artifact_gateway_errors`](#artifact_gateway_errors) | high | platform-operator |
| [`object_store_publish_failing`](#object_store_publish_failing) | critical | platform-operator |

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
  3. While the cause is unknown, `testmaster ops pause --reason "<why>"` to stop new admissions and
     `testmaster ops workers pause --reason "<why>"` to stop workers claiming queued Runs; Attempts
     already running finish.
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
  1. `testmaster ops status`: admission state, worker-claim state, queued jobs, active Runs. Admission
     pause or drain stops new admissions only; `ops workers pause` stops local and remote workers from
     claiming, so a workspace with `claims.paused` keeps its queue by design.
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
* **Impact:** none yet; admission is gated by free bytes, not by this share.
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
* **Impact:** admission still runs while the free bytes hold the worst-case evidence of the Runs in
  progress plus a 256 MiB metadata reserve; once they do not, new Runs are refused with
  `storage_reserve_insufficient` and queued Runs wait in the queue until space returns. Evidence
  publication can fail and the database and audit trail are at risk of full-disk failure if growth
  continues.
* **First actions:**
  1. `testmaster ops drain --reason "storage critical"` if it is not already suspended, and
     let in-flight Attempts finish.
  2. Free space with operator-owned files first; grow the volume. Never delete active bundles, WAL,
     secret data, legal-held objects or `.partial` staging that is still referenced.
  3. `testmaster artifact repair-references` (preview, then `--apply` after review) fixes counters only.
  4. `testmaster ops reconcile preview` before applying; then check readiness.
* **Verification:** use below 90 % (ideally below 80 %), `/v1/health/ready` reports storage healthy,
  a healthy replay is admitted and passes, the alert resolves.
* **Escalation:** open an incident (`artifact_loss` if any artifact was lost, otherwise `outage`,
  high or critical). Stop and call the platform-operator lead if hashes disagree or the database
  cannot be checked.

## backup_failing

* **Owner:** platform-operator
* **Severity:** high
* **Trigger:** backups are configured and not `disabled`, the newest backup failure is newer than the
  newest success, and no backup has succeeded in the last 26 h (`backupStaleHours`; 24 h plus two
  hours of grace). The `backup_freshness` indicator keeps its proposed 24 h target.
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
  1. `testmaster ops pause --reason "audit unavailable"` where it still works.
  2. Check PostgreSQL health, disk (`storage_critical`) and permissions of the application role.
  3. Preserve the database, logs and the time of the first failure. Do not edit audit rows.
  4. After repair, export and verify the audit trail (`testmaster audit export`, `audit verify` with an
     independently retained digest).
* **Verification:** audit writes succeed, a sensitive test operation records its audit event, the
  export verifies, the alert resolves.
* **Escalation:** immediately open an incident (`other` or `isolation_loss`, critical); the window
  without audit is declared unknown, never "no data affected" without evidence.

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
  the allow-list, private or metadata address, or a direct connection attempt). The rule counts
  distinct Runs, in the last 15 minutes, whose `run.completed` or `run.execution_error` event carries
  the reason `egress_denied`; the worker records the Run's final reason on `run.completed`.
* **Impact:** the connection was blocked; a Run may fail or be `blocked` with the denial reason. A
  repeated or direct attempt may indicate a sandbox bypass attempt.
* **First actions:**
  1. Identify the Run, Attempt, destination and the rule that denied it (bounded logs and audit,
     redacted).
  2. If the destination is legitimate, fix the project's environment network profile; never widen the
     allow-list to private ranges or the metadata endpoint.
  3. If it looks like a bypass: `testmaster run cancel <run>`, `testmaster ops pause --reason "<why>"`,
     `testmaster worker drain`, and keep labels, runtime facts and the denial logs.
* **Verification:** the Run is terminal or re-run with a correct profile without denials; independent
  review of the boundary for the suspicious case; the alert resolves.
* **Escalation:** suspected bypass: incident `isolation_loss`, critical; do not restart workers until
  policy, image and seccomp profile have an independent review.

## scheduler_leaderless

* **Owner:** platform-operator
* **Severity:** critical
* **Trigger:** at least one controller is live but none has held the `scheduler` lease for more than
  60 s (twice its 30 s term). With no lease row at all the clock starts when the oldest live controller
  started. A single failover is shorter than that: a crashed holder's lease lapses after 30 s and a
  survivor takes it on its next 10 s look.
* **Impact:** no Schedule fires, and no firing is recovered, until a controller leads again. Runs that
  already started are not affected.
* **First actions:**
  1. `testmaster ops slo`: `scheduler_leader_gap` shows how long the lease has lapsed;
     `controller_availability` shows how many controllers are live.
  2. Read the logs of every controller for `scheduler` tick errors, such as a database error, and fix
     the cause there.
  3. Check that the controllers reach the shared database. Lease expiry and controller liveness are
     judged on the PostgreSQL server's clock, so a controller whose own clock is wrong cannot take a
     live lease; still keep every host's clock synchronised, because Schedule firing instants and
     report timestamps use the host clock.
  4. Restart the controller whose tick fails; never edit `controller_leases` by hand.
* **Verification:** `scheduler_leader_gap` is 0 and the next due Schedule fires once; the alert resolves.
* **Escalation:** unresolved after 15 minutes: incident (`outage`, high).

## controllers_below_expected

* **Owner:** platform-operator
* **Severity:** high
* **Trigger:** the deployment configures how many controllers it runs (`controller.expectedControllers`)
  and fewer have a heartbeat newer than 30 s. The rule is off while no count is configured.
* **Impact:** less headroom: the loops that are elected (alerts, retention, tracker sync, scheduler)
  survive on one controller, but API capacity and failover margin are reduced.
* **First actions:**
  1. `testmaster ops slo`: `controller_availability` lists the live count over the expected count.
  2. Find the silent controller on its host: process, container, disk and memory, network path to
     PostgreSQL.
  3. A controller that stopped on purpose (scale down) is removed by lowering `expectedControllers`;
     a stopped controller is never counted as live.
* **Verification:** the live count reaches the expected count and the alert resolves.
* **Escalation:** two controllers lost together, or the last one: treat as an outage.

## remote_worker_heartbeat_lost

* **Owner:** platform-operator
* **Severity:** high
* **Trigger:** a remote worker (one that enrolled with a public key) was marked `offline` by the
  heartbeat sweep in the last 15 minutes and is still offline. One alert per worker.
* **Impact:** the worker's leases expire after 30 s and its Attempts end `inconclusive` or are retried
  by recorded effects; the host's capacity is gone until it heartbeats again.
* **First actions:**
  1. `testmaster worker status`: which worker, when it last heartbeated, and what it was running.
  2. On the worker host: process and container runtime, disk, and the path to the controllers' public
     origin (a TLS or tunnel failure looks the same as a crash).
  3. If the host is lost for good, revoke the worker so its remaining leases are fenced.
* **Verification:** the worker heartbeats again (state `ready`) or is revoked; the alert resolves.
* **Escalation:** every remote worker lost at once points at the controllers or the network: see
  `controllers_below_expected`.

## artifact_gateway_errors

* **Owner:** platform-operator
* **Severity:** high
* **Trigger:** at least 20 artifact downloads in the current and previous hour (summed over the live
  controllers) and more than 5 % of them answered 5xx. A 4xx answer (expired link, revoked artifact)
  never counts.
* **Impact:** reports, trace viewers and CI links that stream evidence fail; the evidence itself is
  not lost.
* **First actions:**
  1. `testmaster ops slo`: `artifact_gateway_availability`.
  2. Check the object store: reachability from every controller, credentials, bucket policy, and
     latency. A missing object answers 404 and is not counted here.
  3. Check `object_store_publish_failing`: the same cause usually breaks writes first.
* **Verification:** downloads succeed and the 5xx share falls below the threshold; the alert resolves
  once the failing hour has passed out of the two-hour window or successes dilute it.
* **Escalation:** the object store is down: incident (`outage`, high).

## object_store_publish_failing

* **Owner:** platform-operator
* **Severity:** critical
* **Trigger:** in the last 15 minutes at least one Run's `run.completed` or `run.execution_error`
  event carries the reason `storage_unavailable`: the object store refused or lost the evidence write
  and the Run ended `inconclusive` rather than pass without its evidence.
* **Impact:** affected Runs have no complete evidence bundle and no passing verdict; every new Run is
  affected while the store stays unavailable.
* **First actions:**
  1. Check the object store endpoint, credentials, bucket and quota from a controller host.
  2. `testmaster ops pause --reason "<why>"` if the store will stay unavailable, so no new Run is
     admitted into a failing publish.
  3. After the store is back, re-run the affected Runs; never mark them `passed` by hand.
* **Verification:** a new Run publishes its bundle and ends with a verdict; the alert resolves.
* **Escalation:** unavailable for more than 15 minutes: incident (`outage`, critical).

## Related

SLO definitions: [slo.md](slo.md). Incident process: [incidents.md](incidents.md). Backup commands:
[backups.md](backups.md).
