# Pool workers

The server profile runs executors in two ways. A pool worker (`worker start --mode server`) runs on
the controller's host and claims jobs directly from PostgreSQL (ADR-016). A remote worker
(`worker start --mode remote`) runs on any host, holds no database credential and talks to the API
server over HTTPS only (ADR-030).

## Enrolling a worker

1. An admin creates an enrollment: `POST /v1/workers` with `{name, labels?, expiresInSeconds?}`. The
   response contains the worker (`enrolling`) and a one-use `tm_wrk_` token, shown once.
2. Store the token in a file readable only by the operator (mode 0600) and start the worker:
   `testmaster worker start --mode server --config <server.json> --enroll-token-file <file>`.
3. The worker registers its labels, slot count and heartbeat and becomes `ready`; stderr then shows
   `worker <wrk_id> ready: …` after the `enrolled` (or `resumed`) line.

A token enrolls exactly one identity. On first use the token becomes that worker's credential: its
expiry is extended to 30 days and it authorizes only `POST /v1/workers/{id}/heartbeat` for that
worker (it is never accepted as a user or API token). Presenting it again resumes the same worker
(a restarted process keeps its row) until the worker is revoked; an unknown, expired or revoked
token is refused with `UNAUTHENTICATED`. Revoking the worker revokes the credential.

## Heartbeat

`POST /v1/workers/{id}/heartbeat` with `Authorization: Bearer <worker credential>` and
`{leaseId, state, version}` renews the lease the worker holds, records liveness and answers the
Worker document. It is refused with `UNAUTHENTICATED` for any other caller, `REVISION_CONFLICT`
when `version` is stale and `PRECONDITION_FAILED` with `reasonCode: "lease_lost"` when the worker
no longer holds the lease (including an expired one): the worker must stop that job, not retry.
A worker that reports `ready` while an administrator has drained it stays `draining`.

## States

`enrolling → ready → draining | revoked | offline`.

- **drain** (`POST /v1/workers/{id}/drain`): the worker finishes current work and claims nothing new.
- **revoke** (`POST /v1/workers/{id}/revoke`): the worker's lease claims are refused at once, its
  leased jobs are fenced (`reconciliation_required`, attempt `inconclusive`, reason `worker_lost`)
  and the maintenance reconcile path handles them; a late write from the worker fails its fence.
- **offline**: a ready worker whose heartbeat is older than 30 s is marked offline by the liveness
  controller, which announces `worker.offline` once.

Claim SQL requires `workers.state = 'ready'`.

## Remote workers (ADR-030)

1. Enroll the worker:
   - a private worker for one workspace: an admin calls `POST /v1/workers` as above;
   - a shared pool worker for every workspace: the server operator runs
     `testmaster server worker-enrollment --config <server.json> --name <name> [--label k=v]
     --out <file>`. The token is written to `<file>` with mode 0600 and never printed.
2. On the worker host, with Docker and the pinned runner images:
   `testmaster worker start --mode remote --controller https://<api origin>
   --enroll-token-file <file> [--ca-file <pem>] [--slots <n>] [--data-dir <dir>]`.
   The worker verifies its own image lock, enrolls, and prints one JSON line per lifecycle fact on
   stderr (`worker.ready`, `attempt.claimed`, `attempt.settled`, `attempt.lease_expired`,
   `attempt.lease_lost`, `worker.draining`, `worker.stopped`).
3. The worker claims through `POST /v1/workers/{id}/claims`, downloads the Attempt's inputs, runs
   the sandbox on its own Docker daemon and sends every event, secret release, capture, upload and
   the final result back over HTTPS. The API process applies each call under the lease fence.

A remote worker renews its lease every 10 s. When it cannot (a network partition) it stops the
Attempt at the expiry of the last lease it saw, so its sandbox and egress end before another
worker can reclaim the job; when it reaches the server again its upload and result are refused
with `PRECONDITION_FAILED`, `reasonCode: "lease_lost"`. The API server's `lease-reconciler`
controller expires leases every 5 s: a Run whose Attempt left no uncertain external effect is
retried under a new fence, any other completes with `retry_unsafe_external_effect` and its planned
resources become `uncertain`. Keep worker and server clocks synchronised (NTP).

Remote calls must reach the API process that answered the claim: behind several API replicas, route
`/v1/workers/{id}/…` with affinity on the worker id. A restarted API process loses its remote
sessions; their Attempts are recovered by lease expiry.

## Placement: labels and selectors

Enrollment labels (`labels` in `POST /v1/workers`, `--label` on `server worker-enrollment`) are the
operator's. An environment may set `workerSelector` (`environment create|update --worker-label
k=v`, `--clear-worker-selector`): its Runs are claimed only by workers whose labels contain every
selector pair, local and remote alike. Without a selector any worker may claim.

## Fair share and queue limits (OPS-033)

- At most 1 000 queued local jobs per tenant; the next admission answers `429 RATE_LIMITED` with
  `details.reason = "queue_overflow"` and `Retry-After`.
- While another tenant has claimable work, a tenant may hold at most `ceil(slots / active tenants)`
  leased jobs, plus one extra slot per 60 s it has waited (bounded by the slot count). With no
  competing demand the cap is lifted so the pool never idles because of fairness.
- Per-actor (20 burst, 1/s) and per-tenant (200 burst, 20/s) request budgets protect the API.
- A run receipt carries a `queue` hint (reason, own-tenant position, queued count, oldest age); it
  never exposes another tenant.

A shared pool worker serves every workspace and counts its slots once: it claims for the workspace
whose oldest claimable job has waited longest and is still under its cap, so one workspace's flood
cannot hold every slot while another workspace waits.

`slots` in the cap is the sum over every ready worker, on whatever host or Docker daemon it runs: two
remote workers on different daemons with one slot each form a pool of two, and a flooding workspace
may hold one of them while another workspace waits.
