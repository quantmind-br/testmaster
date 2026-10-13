# ADR-015: PostgreSQL runtime engine

- Status: accepted
- Date: 2026-10-13
- Scope: the M4 `server` profile persistence layer (`packages/persistence`). Complements [ADR-002](002-storage.md); SQLite stays the local single-user engine.

## Context

M4 requires PostgreSQL as a server storage with proof (ROADMAP M4 gate, OPS-005). About 370 non-test call sites in 59+ files assume the synchronous, single-writer semantics of `PersistenceDatabase` (`get`, `all`, `run`, `withTx`). Converting every caller to async is out of proportion for M4.

## Decision

- `PersistenceDatabase` keeps its synchronous API (`get`, `all`, `run`, `withTx`) on both engines.
  - `readonly engine: "sqlite" | "postgres"` is added.
  - PostgreSQL is reached through a synchronous bridge. One `worker_threads` worker owns one `pg.Client` and exchanges messages over a `MessageChannel`. The main thread blocks with `Atomics.wait` on a `SharedArrayBuffer` flag, then reads the reply with `receiveMessageOnPort`. No new dependency: `pg@8.23.1` moves from devDependencies to dependencies of `@testmaster/persistence`.
  - Reason: about 370 non-test call sites in 59+ files assume synchronous, single-writer SQLite semantics. Converting all of them to async is out of proportion for M4.
- **Writer semantics.**
  - Every PostgreSQL write transaction runs `BEGIN; SELECT pg_advisory_xact_lock(7340041)`.
  - A `run()` outside a transaction is wrapped in the same locked transaction.
  - Reads outside a transaction are autocommit.
  - This reproduces SQLite `BEGIN IMMEDIATE` single-writer semantics across processes.
  - Consequence: the server profile serializes writes on one host. Horizontal write scale belongs to the M5 distributed profile.
- **Tenant isolation.**
  - PostgreSQL enables `ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` on every table with a `workspace_id` column. Policy name: `tenant_isolation`. Expression: `USING (current_setting('testmaster.workspace', true) = '*' OR workspace_id = current_setting('testmaster.workspace', true)) WITH CHECK (<same>)`.
  - `PersistenceDatabase.forWorkspace(id | "*")` returns a view that runs `SELECT set_config('testmaster.workspace', $1, false)` lazily, only when the connection's current value differs. A scope switch inside an open transaction throws `ContractError("INTERNAL", "Workspace scope switch inside a transaction")`.
  - On SQLite, `forWorkspace` returns a view with no extra effect.
  - Request-scoped `Application` instances always use a workspace-bound view. Controller loops (scheduler, outbox dispatch, maintenance, alerts), migrations, backup/restore and the inbound webhook receiver use `"*"`.
  - Superusers and roles with `BYPASSRLS` ignore RLS. The runtime connection must use a dedicated owner role that has neither (compose creates `testmaster`; tests create `tm_owner_<random>`). `Application.open` refuses such a role with `PRECONDITION_FAILED "Database role bypasses row-level security"`, and readiness reports the same check.
  - A PostgreSQL test proves that a raw `SELECT` from a connection scoped to workspace A returns zero rows of workspace B.
  - Every later migration that creates a table with `workspace_id` must enable and force RLS with the same policy. A test that lists every such table in `pg_class` enforces this.
- **Multi-tenancy needs PostgreSQL.** Multiple workspaces in one database are supported only on PostgreSQL. SQLite stays the single-user local profile with exactly one workspace.
- **Migrations.**
  - PostgreSQL uses the same `schema_migrations(version, name, checksum, applied_at)` table and the same checksum and contiguity rules.
  - `pg_advisory_lock(7340042)` is the migration lock. Each migration file runs in its own transaction.
  - `Application.open` on PostgreSQL never auto-migrates. It refuses a pending schema with `PRECONDITION_FAILED "Database schema is behind; run testmaster db migrate"`. Only `testmaster db migrate`/`db upgrade` migrate PostgreSQL.

## Consequences

- Application code stays SQLite-flavoured; the bridge translates a closed, documented SQL subset and throws on anything else (`ContractError("INTERNAL", "Unsupported SQL for PostgreSQL: <construct>")`).
- Synchronous bridge latency is measured by the M4 capacity benchmark (OPS-034) and reported.
- Write serialization is a stated claim limit of the M4 server profile.
