# Distributed profile

Scope: two or more controllers (`server start --mode distributed`) over one PostgreSQL database and
one S3-compatible bucket, behind one address, with remote workers, tunnel agents and a backup agent
outside the controllers ([ADR-035](../adr/035-distributed-profile.md)). The reference deployment is
`deploy/compose/compose.distributed.yaml`; [its README](../../deploy/compose/README.md) has the start
sequence and `validation/journeys/m5-distributed.docker.test.ts` runs it. Backup format, encryption
and verification are in [backups.md](backups.md); workers in [workers.md](workers.md) and tunnels in
[tunnels.md](tunnels.md).

## What runs where

| Part | Where | Holds |
|---|---|---|
| Controllers | containers, any number, each with its own `internalOrigin` | the evidence credential, the master key, a local staging directory (scratch, never shared) |
| PostgreSQL 17 | one database, TLS `verify-full` | all state, the leases, the proof nonces |
| S3-compatible bucket | evidence bucket | evidence bundles, uploads, the vault ciphertext and its lock |
| Backup bucket | a second bucket with Object Lock | encrypted backups |
| Remote workers | their own hosts, over HTTPS to the public origin | no database and no storage credential |
| Tunnel agents | developers' machines | one loopback port each |
| Backup agent | its own host and user | the backup key and the backup bucket credential |

A controller refuses to start when the configuration names SQLite, filesystem storage, no
`internalOrigin`, a backup key or backup bucket credential it can read, or a mode other than the
`--mode` flag (`distributed_requires_postgres`, `distributed_requires_shared_storage`,
`backup_access_not_separated`, `server_mode_mismatch`). There is no downgrade.

## Bootstrap

Follow the README sequence: TLS (`gen-tls.sh` also issues the MinIO certificate), keys, secret files,
`postgres` and `minio`, `provision-db.sh`, `minio-init`, `db migrate --mode server`, `server
bootstrap`, then the controllers and Caddy. Only one process migrates. Bootstrap prints the owner's
one-time recovery token.

`minio-init` creates the evidence bucket, the backup bucket with Object Lock and a default COMPLIANCE
retention of `TESTMASTER_BACKUP_LOCK_DAYS`, and two users each limited to its own bucket. The
controllers get only the evidence user. Check the result with `testmaster server readiness --config
<host config>` (exit 0) and `GET /v1/health/ready`, which names the storage, the master key and the
schema.

Every controller's `server.trustedProxies` must include the addresses of the other controllers and of
the proxy: a request relayed between controllers keeps its `X-Forwarded-Proto` and the holder checks
HTTPS again, so a missing entry makes the holder see the relayed call as plain HTTP and refuse it.

## Adding a controller

1. Copy an existing controller's configuration and change `server.internalOrigin` to the new
   controller's address on the private network (reachable from every other controller). Raise
   `server.expectedControllers`; the `controllers_below_expected` alert fires when fewer controllers
   than that have a heartbeat newer than 30 s.
2. Give it the master key file (mode 0600) and the evidence credential files. Do not give it the
   backup key or the backup credential.
3. Start it and add it to the proxy's upstreams. It registers in `controller_instances`; the loops
   elected across controllers move only when a holder disappears, so nothing restarts.
4. Check `/v1/health/ready` through the proxy and the new controller's own front.

Removing a controller is stopping it: it releases its leases and marks itself stopped. Remove it from
the proxy and from `expectedControllers`.

## Leader loss

The scheduler, alerts, retention, the lease reconciler and the other elected loops each hold a lease
of 30 s that the holder renews every 10 s, judged on the database clock. A controller that dies
without releasing it (a kill, an out-of-memory stop, a lost host) is replaced by a survivor within one
lease term plus one poll; a stopped controller releases at once. In the journey a killed holder's
leases moved to the survivor, with a higher fence, within the 60 s bound, and the next scheduled
firing came from the survivor under that fence. Firings stay unique per schedule and instant.

What a leaderless window means: no schedule fires, no alert is evaluated and no expired Attempt lease
is reclaimed until the survivor takes over (at most 60 s). Admission, the API, workers' calls to the
surviving controller and tunnel streams held by it keep working. A worker call that reaches the
survivor for an Attempt the dead controller held answers `lease_lost` (the session was in the dead
controller's memory): the Attempt ends `inconclusive` and a new Attempt gets a higher fence. A
stream of a tunnel held by the dead controller ends with `tunnel_lost`.

Start the killed controller again when you can; it registers as a new instance and the dead instance
ages out of the live set after 30 s without a heartbeat.

## Object store outage

When the bucket cannot be reached or refuses the credential, a controller reports `storage_unavailable`
in readiness and `doctor`, admission rejects new Runs in preflight, and an Attempt whose evidence
cannot be published ends non-green with `reasonCode: "storage_unavailable"`. Nothing falls back to a
local directory (OPS-037). The storage probe (a put and a delete) is cached for 5 s, so recovery is
seen within a few seconds of the bucket answering. A bundle missing from the bucket reads as missing evidence,
never as an empty one.

## Master key rotation

All controllers read one master key file. Rotate with the `rewrapKeys` operation on exactly one
controller:

1. Back up every controller's master key file and the `vault/` prefix of the evidence bucket.
2. Run the rewrap on one controller. It writes a new master key file there and leaves
   `<oldId>.key` in that controller's key directory.
3. Copy the new master key to every other controller's `masterKeyFile` (mode 0600). No restart is
   needed. Until a controller has it, its reads of rewrapped secrets fail with a typed error and its
   writes are refused with `vault_key_stale`.
4. Check that every controller's readiness shows `masterKey: ready`.
5. Only then retire the old key. Retirement refuses while any ciphertext is still under it.
6. If a rewrap crashed halfway, run it again from the same controller. If it is refused as stale,
   delete `vault/active-key.json` from the bucket and retry.

## Backups

The backup agent runs on its own host as its own user, with the configuration of
[backups.md](backups.md): `backup.destination` is the Object Lock bucket, the credential files and
the backup key belong to the agent user, and `pgDump` and `pgRestore` must match the server's
PostgreSQL major version (the controller image carries version 15; the journey wraps a `postgres:17`
container). The controllers' configuration may name the same destination so that `POST
/v1/operations/backups` is accepted; they never hold the credential. The agent fulfils the request:

```bash
testmaster backup agent --mode server --config agent.json        # runs until stopped
curl -X POST "$TM/v1/operations/backups" -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"reason":"before the upgrade"}'
testmaster backup list --mode server --config agent.json
```

A backup lands as `data/<name>/…` and `catalog/<name>.json`, written last. COMPLIANCE retention is
whatever `TESTMASTER_BACKUP_LOCK_DAYS` was when `minio-init` ran (at least one day); it cannot be
shortened later, so storage for old backups is paid until it ends.

### Restoring after losing the bucket and the database

1. Stop every controller (`docker compose stop server server-2`).
2. Recreate an empty database and an empty evidence bucket (`provision-db.sh`, `minio-init`; the
   locked backup bucket is untouched).
3. `testmaster backup restore --mode server --config agent.json <name>` on the agent's host. It
   verifies the manifest and every hash, restores the database, then the evidence into the empty
   bucket behind a `tm-restore-pending` marker, and a rerun after a crash converges on the same hashes.
4. Start the controllers. Sign in, then apply the restore review and release isolation as described in
   [backups.md](backups.md) and [disaster-recovery.md](disaster-recovery.md).

In the journey this restored a Run's bundle with the same object hashes and served its artifacts again
after the evidence bucket was emptied and the database dropped; timings are in
`validation/results/m5-distributed.json` (one measurement on one host, not an objective).

## Known limits

- The controller link is plain HTTP. Keep it on a private network that only the controllers and the
  proxy share.
- Both controllers, the database, the bucket, Caddy and the workers of the journey share one host; no
  multi-host behaviour is claimed beyond what the database-clock tests cover.
- Only MinIO RELEASE.2025-09-07T16-13-09Z was exercised. AWS S3 was not. The pinned MinIO image is no
  longer on Docker Hub; keep your own copy.
- MinIO needs `s3:DeleteObject` for a versioned delete, so the backup credential can hide a backup
  behind a delete marker; the locked version stays. Keep that credential on the agent host.
- `backup list` reads one catalog object per backup; its time was not measured.
- Caddy retries only a connection that failed to open. A request that failed after reaching a
  controller is the client's to repeat.
- The reference `Caddyfile.distributed` drops a controller from the rotation after two failed health
  probes in a row (`health_fails 2`, one probe every 5 s) and closes idle upstream connections after
  30 s (`transport http { keepalive 30s }`), well inside the controllers' 65 s `keepAliveTimeout`. A
  shorter controller timeout, or no proxy keep-alive limit, lets a stalled controller reset a socket
  the proxy is about to reuse, which surfaces as a bare 502 with no API envelope.
