# Pool workers

The M4 server profile runs executors in a local, segregated worker pool on one host (ADR-016).
Workers claim jobs directly from PostgreSQL. Remote workers over HTTP, outbound enrollment over the
network and distributed fairness are M5.

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

## Fair share and queue limits (OPS-033)

- At most 1 000 queued local jobs per tenant; the next admission answers `429 RATE_LIMITED` with
  `details.reason = "queue_overflow"` and `Retry-After`.
- While another tenant has claimable work, a tenant may hold at most `ceil(slots / active tenants)`
  leased jobs, plus one extra slot per 60 s it has waited (bounded by the slot count). With no
  competing demand the cap is lifted so the pool never idles because of fairness.
- Per-actor (20 burst, 1/s) and per-tenant (200 burst, 20/s) request budgets protect the API.
- A run receipt carries a `queue` hint (reason, own-tenant position, queued count, oldest age); it
  never exposes another tenant.

Limits of this model: fair share is computed on one host from the ready workers' slots; distributed
scale and fairness across hosts belong to M5.
