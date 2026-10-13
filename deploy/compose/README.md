# TestMaster server profile: reference deployment

One host: PostgreSQL 17 with TLS, the API and portal, Caddy for TLS termination (ADR-016), and
workers as systemd user units on the same host. Storage is PostgreSQL plus a filesystem evidence
directory; S3-compatible storage is not implemented (a `storage.kind: "s3"` configuration is
refused at startup with `CAPABILITY_UNAVAILABLE`, milestone M5).

## 1. Prepare

```bash
export TESTMASTER_DATA_DIR=/srv/testmaster/evidence      # evidence volume (operator encrypts it)
export TESTMASTER_PG_DATA=/srv/testmaster/pgdata         # database volume (operator encrypts it)
export TESTMASTER_KEY_DIR=/srv/testmaster/keys
export TESTMASTER_TLS_DIR=/srv/testmaster/tls
export TESTMASTER_RUNTIME_DIR=$HOME/testmaster           # built checkout: pnpm install && pnpm build
export TESTMASTER_CONFIG=/srv/testmaster/server.json     # from server.example.json
export TESTMASTER_PG_ADMIN_PASSWORD_FILE=/srv/testmaster/pg-admin.password
bash gen-tls.sh "$TESTMASTER_TLS_DIR"
node "$TESTMASTER_RUNTIME_DIR/apps/cli/dist/main.js" server keygen --out "$TESTMASTER_KEY_DIR/master.key"
node "$TESTMASTER_RUNTIME_DIR/apps/cli/dist/main.js" server keygen --out "$TESTMASTER_KEY_DIR/backup.key"
```

`security.atRestEncryption` must declare `operator-volume` for the database and the evidence: server
mode refuses to start otherwise, and `/v1/health/ready` reports `atRestEncryption:
"operator_attested"`. TestMaster does **not** verify that the volumes are encrypted; the attestation
is the operator's statement. Secrets (AES-256-GCM, key id = sha256 of the master key) and backups
(`security.backupKeyFile`) are encrypted by TestMaster itself.

Create the application role and database (the runtime role must not be a superuser nor have
`BYPASSRLS`; the server refuses such a role) and put its password in `database.passwordFile`:

```sql
CREATE ROLE testmaster LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '...';
CREATE DATABASE testmaster OWNER testmaster TEMPLATE template0 LOCALE 'C' ENCODING 'UTF8';
```

## 2. Start

```bash
docker compose up -d --wait postgres
testmaster db migrate --mode server --config "$TESTMASTER_CONFIG"     # the only thing that migrates
testmaster server bootstrap --config "$TESTMASTER_CONFIG" --workspace-name Acme --owner-login owner
docker compose up -d --wait
testmaster server readiness --config "$TESTMASTER_CONFIG"             # all probes, exit 1 when not ready
systemctl --user enable --now testmaster-worker@production
```

On a rootless daemon container root is the operator, so the default `TESTMASTER_CONTAINER_USER=0:0`
keeps file ownership; on a rootful daemon set it to `$(id -u):$(id -g)`. The data and key
directories are mounted at their host paths so worker sandboxes bind-mount the same paths.

## 3. Readiness

`testmaster server readiness` (and `GET /v1/health/ready` for a workspace token) reports database
reachability, schema version (`current`, `behind` or `ahead`), the tenant-isolation role check,
evidence-volume writability and free space (refuses below 10%), master-key availability, admission
state, and ready workers. Without a worker the API is ready and reports `worker.status: "degraded"`.

## 4. Per-component rolling upgrade (OPS-038)

Migrations of one release are additive (expand-only), so adjacent releases can overlap.

1. Back up: `pg_dump --format=custom` plus the evidence directory (or `testmaster backup create`).
2. Upgrade the server first: install the new runtime, `testmaster db upgrade` (preview), then
   `testmaster db migrate --mode server --config ...`, then `docker compose up -d server`.
3. Running workers keep finishing their fenced leases. The next heartbeat window a worker older than
   the schema sees `schemaCompatibility() = ahead`, claims nothing, drains and exits with
   `PRECONDITION_FAILED` / `worker_schema_behind`. systemd restarts it every 30 s until its own
   runtime is upgraded; it then resumes claiming. A new process of an older build is refused at
   start (`Controller is incompatible with database schema`, `schema_ahead`).
4. Upgrading a worker first is refused by the new build until the migration ran
   (`Database schema is behind; run testmaster db migrate`).
5. A lease that was in flight when a worker stopped is reclaimed by the lease fence, never
   executed twice.
