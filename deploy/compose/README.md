# TestMaster server profile: reference deployment

One host: PostgreSQL 17 with TLS, the API and portal, Caddy for TLS termination (ADR-016), and
workers as systemd user units on the same host. Storage is PostgreSQL plus a filesystem evidence
directory. Two controllers over a shared PostgreSQL and an S3-compatible bucket are the
distributed profile, described in the last section of this file.

`validation/journeys/j17-server.docker.test.ts` runs exactly the sequence below (with generated
paths and ports) on the rootless Docker daemon: image build, TLS through Caddy, migration,
bootstrap, owner sign-in, a Run executed by a host worker, and crash recovery.

## 1. Prepare

Copy `.env.example` to `.env` next to `compose.yaml` and adjust the paths. Then, from this
directory (`testmaster` below stands for `node $TESTMASTER_RUNTIME_DIR/apps/cli/dist/main.js`; the
runtime is a checkout built with `pnpm install --frozen-lockfile && pnpm build`):

```bash
set -a; . ./.env; set +a
mkdir -p "$TESTMASTER_DATA_DIR" "$TESTMASTER_KEY_DIR" "$TESTMASTER_BACKUP_DIR" "$TESTMASTER_PG_DATA"
bash gen-tls.sh "$TESTMASTER_TLS_DIR"                           # PostgreSQL CA + certificate
testmaster server keygen --out "$TESTMASTER_KEY_DIR/master.key" # prints only the key id
testmaster server keygen --out "$TESTMASTER_KEY_DIR/backup.key"
printf '%s\n' "$(openssl rand -base64 24 | tr -dc A-Za-z0-9)xxxxxxxx" > "$TESTMASTER_PG_ADMIN_PASSWORD_FILE"
printf '%s\n' "$(openssl rand -base64 24 | tr -dc A-Za-z0-9)xxxxxxxx" > "$TESTMASTER_DB_PASSWORD_FILE"
chmod 600 "$TESTMASTER_PG_ADMIN_PASSWORD_FILE" "$TESTMASTER_DB_PASSWORD_FILE"
```

Create two server configuration files from `server.example.json` (mode 0600, owned by you):
`$TESTMASTER_CONFIG` for the container (`database.url` host `postgres`, `passwordFile`
`/run/testmaster/db.password`, `caFile` `/etc/testmaster/tls/ca.crt`) and a host copy for the
operator CLI and workers (`database.url` host `127.0.0.1` and `$TESTMASTER_PG_PORT`, host paths for
`passwordFile` and `caFile`). `storage.root` and both key paths are host paths and are mounted at the
same path in the container, because worker sandboxes bind-mount host paths.
`server.publicOrigin` and `server.origins` must be the `https://` origin Caddy serves
(`https://$TESTMASTER_PUBLIC_HOST:$TESTMASTER_PUBLIC_PORT`).

`security.atRestEncryption` must declare `operator-volume` for the database and the evidence: server
mode refuses to start otherwise, and `/v1/health/ready` reports `atRestEncryption:
"operator_attested"`. TestMaster does **not** verify that the volumes are encrypted; the attestation
is the operator's statement. Secrets (AES-256-GCM, key id = sha256 of the master key) and backups
(`security.backupKeyFile`) are encrypted by TestMaster itself.

## 2. Start

```bash
docker compose up -d --wait postgres
bash provision-db.sh "$TESTMASTER_DB_PASSWORD_FILE"     # role without SUPERUSER/BYPASSRLS, database
testmaster db migrate --mode server --config HOST_CONFIG  # the only thing that migrates
testmaster server bootstrap --config HOST_CONFIG --workspace-name Acme --owner-login owner
docker compose up -d --build --wait server caddy
testmaster server readiness --config HOST_CONFIG          # all probes, exit 1 when not ready
systemctl --user enable --now testmaster-worker@production
```

`bootstrap` prints a one-time owner recovery token: open the portal at your public origin, or
`POST /v1/identity/recovery` with `{principal, recoveryToken, newPassword}`, then sign in. Caddy
uses its own CA (`tls internal`); export it with
`docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .` and trust it, or replace
`tls internal` with an ACME or operator certificate.

On a rootless daemon container root is the operator, so the default `TESTMASTER_CONTAINER_USER=0:0`
keeps file ownership; on a rootful daemon set it to `$(id -u):$(id -g)`. The worker unit reads its
configuration from `~/.config/testmaster/<instance>.json` (the host copy) and talks to the rootless
socket (`DOCKER_HOST=unix://%t/docker.sock`).

To remove a deployment on a rootless daemon: `docker compose down -v`, then give the database files
back with `docker run --rm --entrypoint chown -v "$TESTMASTER_PG_DATA:/d" <postgres image> -R 0:0 /d`
(PostgreSQL's files belong to a subordinate uid).

## 3. What the server process does and does not do

The server process has no Docker daemon. At admission it verifies the runner image lock file and
the seccomp profile hash (`server` branch of `Application.preflight`) and freezes the lock into the
Run's admission snapshot. The worker host compares that lock with its own image store when it starts
and verifies every container's hardening before each Attempt; a mismatch ends the Run `blocked` with
`security_precondition_failed`. A Run is only admitted while a worker is live.

## 4. Readiness

`testmaster server readiness` (and `GET /v1/health/ready` for a signed-in caller) reports database
reachability, schema version (`current`, `behind` or `ahead`), the tenant-isolation role check,
evidence-volume writability and free space (refuses below 10%), master-key availability, admission
state, and ready workers. Without a worker the API is ready and reports `worker.status: "degraded"`.
While PostgreSQL is down the API answers 503 and recovers by itself when it returns.

## 5. Per-component rolling upgrade (OPS-038)

Migrations of one release are additive (expand-only), so adjacent releases can overlap.

1. Back up: `pg_dump --format=custom` plus the evidence directory (or `testmaster backup create`).
2. Upgrade the server first: install the new runtime, `testmaster db upgrade` (preview), then
   `testmaster db migrate --mode server --config ...`, then `docker compose up -d server`.
3. Running workers keep finishing their fenced leases. Within about two seconds a worker older
   than the schema stops claiming, drains and exits with `PRECONDITION_FAILED` /
   `worker_schema_behind`. systemd restarts it every 30 s until its own runtime is upgraded; it then
   resumes claiming. A new process of an older build is refused at start
   (`Controller is incompatible with database schema`, `schema_ahead`).
4. Upgrading a worker first is refused by the new build until the migration ran
   (`Database schema is behind; run testmaster db migrate`).
5. A lease that was in flight when a worker died is reclaimed through the lease fence on the next
   worker's maintenance pass: the lost Attempt ends `inconclusive` and a new Attempt gets a higher
   fence; nothing runs twice under one fence.

`validation/journeys/rolling-upgrade.docker.test.ts` proves steps 3 and 4 with real worker
processes on the rootless daemon.

## 6. Distributed profile: two controllers, S3 evidence, locked backups (ADR-035)

`compose.distributed.yaml` is a standalone file, not an override of `compose.yaml`. It runs
PostgreSQL 17 with TLS, MinIO with TLS and Object Lock, a one-shot `minio-init`, two controllers
(`server`, `server-2`) and Caddy balancing both. Only Caddy publishes a non-loopback port. Remote
workers and the backup agent run on their own hosts. The full procedure, with failure behaviour, key
rotation and backups, is [docs/operations/distributed.md](../../docs/operations/distributed.md);
`validation/journeys/m5-distributed.docker.test.ts` runs this sequence on a rootful daemon.

```bash
cp .env.distributed.example .env && $EDITOR .env        # paths, ports, TESTMASTER_CONTAINER_USER=$(id -u):$(id -g)
set -a; . ./.env; set +a
export COMPOSE_FILE=compose.distributed.yaml
bash gen-tls.sh "$TESTMASTER_TLS_DIR"                     # CA, PostgreSQL and MinIO certificates
testmaster server keygen --out "$TESTMASTER_KEY_DIR/master.key"
testmaster server keygen --out /srv/testmaster-backup/backup.key   # the backup agent's host only
# Write the secret files named in .env (mode 0600, owned by you): database passwords, MinIO root
# user and password, one S3 access key pair for the controllers and one for the backup agent.
docker compose up -d --wait postgres minio
bash provision-db.sh "$TESTMASTER_DB_PASSWORD_FILE"
docker compose run --rm minio-init                         # buckets, Object Lock, two bucket-scoped users
testmaster db migrate --mode server --config HOST_CONFIG
testmaster server bootstrap --config HOST_CONFIG --workspace-name Acme --owner-login owner
docker compose up -d --build --wait server server-2 caddy
```

Create one configuration file per controller from `server.distributed.example.json`; they differ
only in `server.internalOrigin` (`http://server:7331`, `http://server-2:7331`). Each controller's
`server.trustedProxies` must contain the private network of the other controller and Caddy, because
a request relayed between controllers keeps its `X-Forwarded-Proto`. The credential files of the
controllers are mounted from the host, so they must be mode 0600 and owned by
`TESTMASTER_CONTAINER_USER`. The backup bucket credential is read only by `minio-init`; do not mount
it into a controller.

Things to know before relying on it:

- Docker Hub no longer serves `minio/minio`, so the MinIO image is pinned by digest to
  `ghcr.io/quantmind-br/minio`, an unmodified linux/amd64 mirror of RELEASE.2025-09-07T16-13-09Z
  (AGPL-3.0, source at github.com/minio/minio). For another architecture, pin an image you have run
  the journey against.
- `TESTMASTER_BACKUP_LOCK_DAYS` sets a COMPLIANCE retention. Nobody, including the MinIO root user,
  can shorten it or delete a backup earlier, so choose it deliberately (the journey uses one day).
- Controllers talk to each other over the compose network in plain HTTP. Do not publish their ports
  beyond loopback, and do not attach other containers to that network.
