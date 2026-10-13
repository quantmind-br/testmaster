# ADR-016: Server profile topology and storage

- Status: accepted
- Date: 2026-10-13
- Scope: the M4 `server` profile (`specs/08-operations.md` profile table). Supersedes [ADR-014](014-rootless-deferral.md) once rootless evidence exists (slice S2a).

## Context

`specs/08-operations.md:10` defines the `server` profile as "PostgreSQL + filesystem ou S3 compatível". Two other places mention S3 for M4: `specs/10-validation.md:439` ("PostgreSQL/S3 profiles") and J17 ("perfil PostgreSQL/S3"). The ROADMAP M4 gate requires proof of "um storage de servidor", meaning one server storage. M4 proves the PostgreSQL + filesystem option. S3-compatible storage is not implemented in M4.

## Decision

- **Storage.** The M4 `server` profile is PostgreSQL plus filesystem evidence storage on one host.
  - S3-compatible storage is not implemented in M4. Docs and `capabilities` must not claim it.
  - A server config with `storage.kind: "s3"` is refused at startup with `CAPABILITY_UNAVAILABLE` (`{capability: "s3-storage", milestone: "M5"}`). It never falls back to filesystem silently.
  - The remaining S3 scopes move to M5, quoting `specs/08-operations.md:11`: "PostgreSQL + S3 compatível compartilhados | Identidades de serviço, TLS/mTLS, leases e fencing | M5".
- **Processes.**
  - `testmaster server start --mode server` runs API, portal, controller loops and scheduler.
  - `testmaster worker start --mode server` runs one executor in the local segregated worker pool. Executors claim jobs directly from PostgreSQL and run sandboxes on the same host's rootless Docker daemon.
  - Remote workers over HTTP are M5.
  - Local mode is unchanged: `server start` keeps its embedded worker.
- **Compose reference deploy** (`deploy/compose/`).
  - `postgres`: `postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`, TLS on, published only on `127.0.0.1:${TESTMASTER_PG_PORT:-55432}`.
  - `caddy`: `caddy:2-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f`, `tls internal`, published `8443`.
  - `server`: `node:24@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584` plus `postgresql-client` for `pg_dump`/`pg_restore`, built from `containers/server/Dockerfile`. It mounts the built TestMaster runtime read-only at `/opt/testmaster`, and the data directory at the same absolute path as on the host.
  - Workers run on the host as systemd user units from `deploy/systemd/testmaster-worker@.service`. They need host paths for sandbox bind mounts (`packages/sandbox/src/docker/executor.ts` binds host directories).
- **Rootless Docker** is the validated M4 daemon (slice S2a). It supersedes ADR-014 once evidence exists. Rootful hardened Docker stays supported for the local profile.

## Consequences

- Claim limits: filesystem evidence storage only; single-host write serialization (ADR-015); no remote workers.
- A deployment declaring S3 fails closed at startup, never degrades silently.
