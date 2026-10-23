# ADR-035: Distributed profile

- Status: accepted
- Date: 2026-10-23
- Scope: ROADMAP M5 distributed profile (ARCH controllers, OPS-001, OPS-026, OPS-028, OPS-037, SEC-030, VAL-045) of [specs/08-operations.md](../../specs/08-operations.md); builds on [ADR-016](016-server-profile.md), [ADR-030](030-remote-workers.md) and [ADR-031](031-tunnels-and-worker-proof-of-possession.md).

## Context

The server profile runs one API process against one PostgreSQL database and a filesystem evidence root. The distributed profile asks for several stateless API controllers behind one address, an elected scheduler, shared object storage and a backup that survives the loss of that storage. The earlier slices left four places where one process was assumed: the lease fence of the scheduler lived in a table only one process wrote, a remote worker's `AttemptSession` and a tunnel's relay lived in the memory of the controller that accepted them, proof-of-possession nonces were remembered per process, and evidence, vault keys and uploads were files on one disk.

## Decision

### Mode and refusals

`server start --mode distributed --config <file>` is a third mode next to `single-user` and `server`. The configuration must name PostgreSQL, S3-compatible evidence storage and the controller's own `internalOrigin`; it may also name `expectedControllers`. The mode never degrades: SQLite is refused with `POLICY_DENIED` `distributed_requires_postgres`, filesystem storage with `distributed_requires_shared_storage`, and `--mode` must equal the file's mode. The master key file may be shared by every controller; a vault secret that is `ephemeral` is never shared. The `distributed` capability is enabled; the single-host `server` profile is unchanged.

### Shared state

- **Evidence.** Evidence goes through an `ObjectStore` port (`@testmaster/evidence`). The S3 implementation writes with a conditional put (`If-None-Match: *`), so two publishers of one Attempt cannot both win, and writes `meta.json` last. A `pending/<workspace>/<run>/<attempt>` marker names a bundle in progress and a sweep removes an unreferenced one after a grace. Controllers keep only a local staging directory. The vault stores its ciphertext, its active key record and a deployment-wide lock under `vault/` in the same bucket. An unreachable or refusing bucket is the typed error `storage_unavailable`; there is no filesystem fallback (OPS-037).
- **Controller registry and leases.** A controller registers in `controller_instances` and renews its heartbeat; one whose heartbeat is older than 30 s is not live. Every elected loop (the scheduler, alerts, retention, the lease reconciler, the GitHub reconciler, issue-link sync, notification retention and housekeeping) holds a named row in `controller_leases` with a fence. Expiry and liveness are judged with the database clock, never a controller's own, so a controller whose clock runs ahead cannot take a live lease and one far behind cannot hold an expired one. A lease lasts 30 s and its holder renews it every 10 s; a takeover raises the fence, a released lease is taken at once and a fence is never reused. The scheduler's firing transaction and each write of a remote Attempt check the fence, and a running elected tick aborts when the lease is lost. A leaderless period is bounded by two lease terms (60 s).
- **Proof nonces.** A signed worker or tunnel call is accepted once deployment-wide: the nonce is a row in `worker_proof_nonces`, so a proof replayed to another controller is refused. A bad signature or a stale proof does not spend a nonce.
- **Metrics and cancellation.** Each controller flushes its counters into `controller_metrics` and the SLO report sums the live controllers. A cancel of an exploration job is a column the running controller polls.

### Routing instead of taking over

An Attempt's session stays in memory on the controller that claimed it; `remote_attempts` records which one. A tunnel session stays on the relay controller recorded in `tunnels.relay_id`. A call that reaches another controller is relayed to the holder over the private backend network. The relay is a plain byte stream with a hop header (`x-testmaster-forwarded`): a request that carries the header is never relayed again, and the header grants nothing. The holder authenticates the request itself, so the worker's own Ed25519 proof, its `tm_wrk_` credential and the lease fence are verified by the controller that acts, not by the one that forwarded. The plan for this ADR was a controller-signed forwarding envelope; end-to-end proof was chosen instead because it adds no second signing authority and no key to distribute among controllers. When the holder is gone the worker gets the ordinary `lease_lost` (Attempt calls) or `tunnel_lost` (streams): nothing is retried against a dead holder, and the lease reconciler reclaims the Attempt. Revoking a tunnel through any controller reaches the relay that owns the streams and closes them within the existing five-second bound.

A forwarded request keeps its `X-Forwarded-Proto`, and the holder checks HTTPS again, so every controller's `trustedProxies` must include the other controllers' internal addresses.

### Backups

The backup agent runs on its own host with its own identity, as in ADR-016. Its destination is a separate bucket created with Object Lock and a default COMPLIANCE retention. The bucket credential held by the controllers can read, write and delete evidence only; it can do nothing in the backup bucket, and the backup credential is read only by the agent and by the bootstrap job that creates the buckets. A restore rebuilds an empty database and an empty evidence bucket from the backup alone (OPS-026, VAL-045).

### Reference deployment

`deploy/compose/compose.distributed.yaml` is a standalone file (not an override of `compose.yaml`, because Compose cannot remove an inherited volume): PostgreSQL 17 with TLS, MinIO with TLS and Object Lock, a one-shot bootstrap that creates the two buckets and two identities limited to one bucket each, two controllers and Caddy balancing both. Only Caddy is published on a non-loopback address. Every image is pinned by digest; the controllers' credentials are files. The journey `validation/journeys/m5-distributed.docker.test.ts` runs this stack on the default rootful daemon.

## Consequences

- Capability `distributed` is enabled. The `remote-workers` and `tunnels` capabilities keep their meaning.
- Migration `0029_distributed` adds `controller_instances`, `controller_leases` (replacing `scheduler_leases`), `remote_attempts`, `worker_proof_nonces`, `controller_metrics` and `discovery_jobs.cancel_requested_at`.
- The controller link is plain HTTP on the compose backend network. Anyone on that network can read or delay a relayed body, though not forge or replay a call. mTLS between controllers is not implemented; an operator who needs it terminates TLS between the controllers with their own mesh.
- Only the pinned MinIO was exercised. AWS S3 and other implementations are expected to work through the same conditional-put and Object Lock calls but were not run. The digest `minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e` (release 2025-09-07) is the one image used; Docker Hub no longer serves that repository, so the image existed only in a local image store when the journey ran; an operator pins an image they can obtain and re-runs the journey against it.
- MinIO needs `s3:DeleteObject` even for a versioned delete, so the backup credential can hide a backup behind a delete marker; the locked version stays and a restore reads it. COMPLIANCE retention is at least one day, so what happens to a backup after its lock expires was not exercised.
- Both controllers, PostgreSQL, MinIO, Caddy and the journey's workers share one physical host and one Docker daemon. Failure of a host, clock skew between hosts and a partition between controllers are covered by the database-clock unit tests and the fault matrix, not by a multi-host run.
- Caddy balances round-robin and retries only a failed connection, so a request that failed after it reached a controller is the client's to repeat.
- The API of a restarted controller is a new `controller_instances` row; the dead one stays until its heartbeat ages out of the live set.
