# Changelog

Release notes for the local single-user profile. Version identifiers are source commits; no npm or
registry package is published. Entries state behavior that tests exercise; see
[`docs/support-matrix.md`](docs/support-matrix.md) for the supported platform matrix and
[`docs/operations/local-operations.md`](docs/operations/local-operations.md) for the upgrade and
rollback procedure. A test (`tools/src/distribution/release-notes.test.ts`) fails when the migration
table below drifts from `packages/persistence/migrations/sqlite/`.

## Unreleased

### Operations (OPS-038, local single-user profile)

- `testmaster db upgrade` previews (default) or applies (`--apply --backup-out <dir>`) an ordered offline
  upgrade: read-only preflight, drain, backup of the old schema, migrate, readiness. Pending migrations
  are reported as irreversible before anything changes.
- `make install DATA_DIR=<data dir>` (also used for rollback) checks the candidate release against the data
  directory before replacing the installation: a database schema newer than the candidate, a changed
  migration checksum or a revoked pinned image refuses the install without mutation. Without `DATA_DIR`
  the check is skipped and a warning says so.
- `testmaster image revoke <image-id> --reason <text>` records a durable image revocation. Revoked image IDs
  are refused by the image-lock verifier, by `db upgrade`/`make install` and are carried into restored
  data directories.
- `testmaster backup restore <path> --out <dir> --keep-schema` restores without migrating forward, which is
  the restore point required for rolling back to an older release.

## Database migrations

SQLite migrations are forward-only and checksummed (`schema_migrations`). No down migration exists, so
every migration is irreversible: after it is applied, an older application cannot open the database
and rollback means restoring a backup taken before the upgrade.

| Version | Name | SHA-256 (first 12) | Content |
|---:|---|---|---|
| 1 | `initial` | `a42410421581` | Forward-only M0–M2 relational schema (workspaces, projects, tests, runs, attempts, audit, outbox, operational state) |
| 2 | `authored_code_artifacts` | `8178ac2c5516` | Rebuilds `artifacts` as `artifacts_authored` for authored-code artifacts |
| 3 | `model_accounting` | `ef46ab871483` | Consent unknown-cost flag, budget reservation token columns and `token_budget_limits` |
| 4 | `contract_constraints` | `10f62ba32976` | Generated contract CHECK constraints for stored documents |
| 5 | `recovery_storage` | `44ec3f8ac63e` | `blob_reference_counts`, `backup_object_holds` and `upload_leases` |
| 6 | `m3_diagnostics` | `cc958418043d` | Immutable `analyses`, `healing_proposals`, `deliveries` and their identity indexes |
| 7 | `m3_contract_constraints` | `b8a0f05372b8` | Generated M3 contract CHECK constraints |
| 8 | `fixture_inputs` | `aa12ad5eb6f9` | Fixture input objects (`fixture_inputs`) included in backups and retention |
| 9 | `delivery_requeue` | `041fd69b1c99` | Lets a dead-lettered check delivery reopen to `pending`; the frozen delivery subject and delivered rows stay immutable |
