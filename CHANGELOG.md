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

### M3 release gate closure (local single-user profile)

- Release areas carry `gate` and `series`; a failed area superseded by a later passed area of the same series no longer blocks the cumulative milestone gate, and verified items may declare quoted `deferred` scope that blocks later gates ([ADR-013](docs/adr/013-release-area-supersession.md)). Rootless Docker validation is deferred to M4 ([ADR-014](docs/adr/014-rootless-deferral.md)).
- `node tools/dist/traceability/cli.js evaluate --milestone-gate Mx | --capability-gate ID` writes a write-once release evaluation record `validation/results/release-evaluations/<gate>/<commit>.json` from a clean committed tree; failed gates are recorded, never overwritten (VAL-050).
- Check deliveries retry with exponential equal-jitter backoff (1 s base, 300 s cap) and move to a queryable dead letter after 10 attempts or 24 h; `testmaster ci deliveries [--state]` lists them and `testmaster ci deliveries-requeue <id>` reopens one (write authority, audited, never reruns the local test). Migration 0009 lets a dead-lettered delivery reopen to pending while delivered rows and the frozen subject stay immutable (OPS-011).
- `testmaster doctor` reports Node.js, writable data directory, database, timezone, network policy and browser sandbox checks, separates blocking failures from advisory recommendations and prints only the redacted effective configuration; every command refuses a Node.js major other than 24 with `PRECONDITION_FAILED` (`unsupported_node`); admission refuses with `storage_not_writable` before any container starts and the 90 % storage refusal carries redacted recovery options (OPS-001, OPS-023).
- Operations runbook gains a Tabletop record and an executable check that every documented `testmaster` command and option exists; one CLI correlation ID is proven on the Run, worker log, Artifact and outbox event (OPS-035, OPS-027).
- Storage: one `storage.high_watermark` warning per crossing of 80 % use, a `storage.gc_delayed` alert (24 h deadline) when a storage outage delays physical deletion, an exported publication guard that stops an in-flight upload from republishing a deleted artifact, the worker reconciler cadence as `defaults.reconcilerIntervalMs`, and `worker reconcile --dry-run` listing `pendingOutbox` and `missingArtifactReferences`. Metadata and audit retention windows are declared, not enforced: `exportEffectiveConfig().unavailable` labels the purges M4 (OPS-012, OPS-021, OPS-022, OPS-023, SEC-037).
- Backup manifests carry an optional `missingObjects` list; restore replays consent and approval revocations made after the snapshot (never un-revoking), declares an unreadable post-backup ledger (`postBackupLedger: "unavailable"`, restore stays suspended and `backup review --apply` also requires `--ledger-loss-accepted`); a busy SQLite writer lock surfaces as the retryable `UNAVAILABLE` error with `reasonCode: "writer_contention"`; the support matrix labels host facts that no repository file pins as observations (OPS-024, OPS-025, OPS-005, OPS-038, SEC-036).
- Execution approvals require a `reason` (1-200 characters; `approval create --reason`, REST and `approvals.create`), stored on the `Approval` entity (older rows stay readable); the browser runner launches Chromium with explicit `--password-store=basic` and `--use-mock-keychain`; both runners refuse input carrying a browser `storageState` as `unsupported_capability` (SEC-039, SEC-022).
- The live model evaluation refuses loopback, private and link-local provider endpoints and records `providerHost`; `benchmarkEvidenceClass` classifies simulated or controlled reports as non-live; the clean-checkout reproduction script writes write-once per-commit records under `validation/results/clean-checkout/` (M2-08, M0-05). Execution metric definitions label the end-to-end rate as the existing `gatePassRate` (VAL-007).
- Action: the artifact entry allow-list and the CI output confinement are exported pure functions with unit tests, and fork, deleted-fork and foreign-head pull requests are proven refused before any runtime directory is created (INT-007, J12).
- Release packaging runs a fail-closed vulnerability gate (SEC-045): Trivy 0.75.0 pinned by digest in `containers/scanner.lock.json` scans the staged runtime npm graph and both locked images before `manifest.json` is written; CRITICAL and HIGH findings block unless an owned, expiring entry in `docs/security/vulnerability-exceptions.json` covers them. `manifest.json` pins `vulnerabilities.json` and `release-sign.js sign` refuses a missing, altered, failing, wrong-scanner or unbound report. The CycloneDX SBOM carries npm package URLs (NFR-011, SEC-046).

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
