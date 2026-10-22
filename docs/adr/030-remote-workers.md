# ADR-030: Remote workers over HTTPS

- Status: accepted
- Date: 2026-10-21
- Scope: ROADMAP M5-01 (distributed workers): outbound enrollment, pools and labels, fair share, leases and fencing for workers in another process or host, and the split between the controller and the executor. Extends [ADR-016](016-server-profile.md), whose server profile had no remote workers. Relay and tunnels (M5-02) and mTLS service identities are out of scope.

## Context

Before this decision every worker was a process with database credentials: `worker start --mode local` (SQLite) or `--mode server` (PostgreSQL). `AttemptSession` (`packages/application/src/attempt-session.ts`) already held every write an Attempt makes (snapshot sealing, runner events, secret releases, capture protection, publication) under the lease fence, and the worker only ran the sandbox. REQ-038 asks for private runners that do not need an inbound port, and `specs/08-operations.md:11` places remote workers, leases and fencing in M5.

The operator fixed four choices for this milestone:

- transport: HTTPS initiated by the worker; the worker never holds a database credential;
- identity: the existing `tm_wrk_` bearer credential over TLS (mTLS is deferred); superseded by [ADR-031](031-tunnels-and-worker-proof-of-possession.md), which binds an Ed25519 key at enrollment and signs every later call;
- placement: operator labels on the worker and a label selector on the environment;
- fair share: per workspace (tenant), on a pool the operator shares between workspaces.

## Decision

- **Controller and executor are separate processes.** A remote worker runs `testmaster worker start --mode remote --controller <https origin> --enroll-token-file <file> [--ca-file <pem>] [--slots <n>] [--data-dir <dir>]`. It opens no database and holds no server secret. It claims over HTTPS, receives the dispatch (an `AttemptDispatch` with its input files), runs the sandbox with its own Docker daemon, image lock and seccomp profile, and calls back for every effect. The API server (`server start`) hosts the controller side: one `AttemptSession` per remotely claimed Attempt, kept in memory by the process that answered the claim.
- **Protocol.** Every call carries `Authorization: Bearer tm_wrk_…` (since [ADR-031](031-tunnels-and-worker-proof-of-possession.md), only enrollment does; every other call is signed with the key enrollment bound) and is scoped to the worker id in the path. `POST /workers/enroll` resolves the credential (and enrolls a fresh one). `POST /workers/{id}/claims` reports the handshake, capacity and drain state, and returns at most one Attempt. The Attempt's calls live under `/workers/{id}/attempts/{attemptId}/`: `input` (one input file), `heartbeat`, `events` (sequence-numbered, idempotent per sequence), `secrets`, `captures`, `auth-state`, `actions` (agent mode; the wait for the model is never cut), `bundle` (one sealed bundle file), `finalize` and `fail`. A worker never writes a database row; the session applies each call under the fence that is current then.
- **Leases and fencing.** The claim is the same transactional `LeaseRepository.claim` as for local workers (30 s lease, renewed every 10 s by the worker's `heartbeat`). A call whose fence is no longer current is refused with `PRECONDITION_FAILED`, `reasonCode: lease_lost`, and has no effect: no event, secret, upload or publication is accepted for a stale Attempt. A session the server no longer holds (server restart) answers the same way.
- **The worker enforces its own lease.** A partitioned worker cannot renew, so it stops the Attempt when the last lease it saw expires. The sandbox's egress proxy and container end with the Attempt, so a partitioned worker's egress stops no later than the lease expiry, before another worker can reclaim the job. Once it reaches the server again it reports the Attempt and is refused.
- **Recovery is the existing reconciler.** A server-only controller (`lease-reconciler`) expires leases and settles `reconciliation_required` jobs in every workspace, so a deployment with only remote workers still recovers: an Attempt without an uncertain external effect is retried under a new fence; one whose resources were planned or created ends `retry_unsafe_external_effect` and its resources are marked `uncertain`, never retried.
- **Two kinds of remote worker.** A workspace administrator's enrollment (`POST /workers`) gives a private worker that only claims that workspace's Runs. The server operator's enrollment (`testmaster server worker-enrollment --config <file> --name <name> [--label k=v] --out <file>`, token written with mode 0600 and never printed) gives a shared pool worker that claims for every workspace; its row lives in the first workspace and the server adds a row with the same id in each workspace it claims for, so the Attempt keeps its worker reference. Revoking a shared worker fences its leases in every workspace.
- **Labels.** Enrollment labels are the operator's: keys match `^[a-z][a-z0-9._-]{0,62}$` and exclude the keys the runtime declares (`name`, `pid`, `architecture`, `os`, `capacity`, `actions`, `slots`). An environment may set `workerSelector` (the same key and value rules, at most 16). A Run whose environment revision has a selector is claimed only by a worker whose labels contain every selector pair; this applies to local and remote workers. A run without a selector is claimed by any worker.
- **Fair share per tenant.** The existing `fairShareCap` holds a workspace to its share of the ready slots while another workspace waits. A shared worker picks, among the workspaces it serves, the one with the oldest claimable job that is still under its cap. Ready slots count each worker id once.
- **Quotas.** Each claim checks the worker's declared capacity against the Attempts that worker already holds, the worst-case evidence of the Run against both the worker's free disk and the server's, and the tenant's fair-share cap. An upload larger than the Attempt's artifact limit, or a path outside the bundle, is refused.

### Alternatives rejected

- **Database credentials on remote workers.** Simplest, but a remote host would then be able to read and write every workspace; it contradicts REQ-038 and the segregation the roadmap requires.
- **Stateless controller (session rebuilt per call).** The session holds the accepted-event sequence, released secrets, prepared authentication and the agent session; rebuilding them from the database per request needs a persisted session protocol. It is not needed while one API process serves the remote protocol, and a lost session already fails closed through lease expiry.
- **mTLS now.** The bearer credential over TLS is already one-use at enrollment, revocable and scoped to one worker; mTLS identities belong with the relay work (M5-02).

## Consequences

- Remote calls must reach the API process that answered the claim. Several API replicas behind a load balancer need affinity on the worker id; without it the other replica answers `lease_lost` and the job is recovered by the reconciler. A restart of the API process loses its sessions in the same way.
- A partitioned worker loses its Attempt after at most one lease period (30 s); a short network blip that lasts less than the remaining lease does not.
- The input files of an Attempt travel over the worker's connection; fixtures and code bundles count against the same limits as before.
- A shared pool worker runs the code and secrets of every workspace it serves, exactly as the host worker of `worker start --mode server` already does. Hostile multi-tenant execution still needs separate workers per tenant (private enrollment).
- The worker's lease check uses its own clock against the server's `leaseExpiresAt`; worker and server hosts must keep their clocks synchronised (NTP), or a fast worker clock ends Attempts early and a slow one keeps egress open past the lease until the next refused heartbeat.
- Remote workers ship inside the server profile and the capability manifest reports them as `remote-workers` (enabled). The `distributed` capability and deployment profile of `specs/08-operations.md` (stateless API replicas, an elected scheduler, shared object storage, mTLS service identities) stay disabled and keep answering `CAPABILITY_UNAVAILABLE`; this decision does not implement them.
