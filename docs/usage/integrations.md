# Integrations core

The integrations core (milestone M4) is the shared layer under every outbound and inbound integration
(GitHub App, Slack, email, webhook). It ships no adapter. Each adapter implements
`IntegrationProvider` (`packages/application/src/integrations/provider.ts`) and registers itself in
`integrationProviders`.

## Adapters

- An adapter declares `id`, its own semver `version`, the core contract `schemaVersion` it was written
  against and its `capabilities`. The core refuses an adapter whose `schemaVersion` has another major
  version or a newer minor version than the core with `PRECONDITION_FAILED` and
  `nextActions: ["update-adapter"]`; none of the adapter's code runs.
- Every integration returned by the API carries `adapter` (id, version, schemaVersion, capabilities) and
  `adapterStatus` (`compatible`, `incompatible` or `unregistered`).
- An adapter outcome outside the contract is never read as success: an unknown delivery state becomes
  `failed`, an unknown inbound disposition is refused with `INTERNAL` and
  `reasonCode: "adapter_contract_violation"`. Adapter exceptions that are not `ContractError`s surface as
  `INTERNAL` / `adapter_error` without the adapter's message.

## Configuration

- `POST /v1/integrations` and `PATCH /v1/integrations/{id}` need the administrator scope. The created
  integration records the principal that created it (`createdBy`), which stays accountable for what the
  integration does; there are no per-integration consent scopes to supply or re-check.
- `PATCH` moves `state` between `active` and `paused`, or to `revoked`. Revocation is terminal and ends
  access: the secret bindings are cleared, tests and updates are refused, and inbound
  deliveries for the integration are recorded as ignored. The database also refuses to reactivate a
  revoked integration.
- Projects and secret references must belong to the caller's workspace; archived projects and revoked
  secrets cannot be bound.
- `POST /v1/integrations/{id}/test` sends a delivery labelled `test notification` (the adapter receives
  `context.test`). A test never creates a delivery of record, a Run or an outbox event; its outcome is kept
  as `lastTest` on the integration.

## HTTP routes

- `GET /v1/integrations` (cursor-paged), `POST /v1/integrations` (201, `ETag`), `PATCH /v1/integrations/{id}`
  (`If-Match`; pause, resume and revoke are `state` changes) and `POST /v1/integrations/{id}/test` need the
  administrator scope.
- `POST /v1/integrations/{provider}/webhooks` is described below.

## Inbound webhooks

`POST /v1/integrations/{provider}/webhooks` is a `signature` route: it is authenticated by the provider's
signature, not by a bearer token or session cookie (neither is read), it needs no `Idempotency-Key` (the
delivery ID is the dedupe key), and it still spends the caller's rate-limit budget. The HTTP layer hands
the exact request bytes to the receiver (`RouteContext.rawBody`), caps the transport body at 5 MiB and
runs the receiver in the controller scope. The receiver checks, in order:

1. `Content-Type: application/json` (`INVALID_ARGUMENT`, `reason: unsupported_content_type`);
2. body at most 5 MiB (`PAYLOAD_TOO_LARGE`);
3. the provider signature and the payload schema, both inside the adapter's `receive`
   (`UNAUTHENTICATED`, `INVALID_ARGUMENT`); `verifyHmacSha256` accepts several secrets for a rotation window;
4. deduplication on `(workspace, provider, delivery ID)` in `inbound_webhook_deliveries`, which stores the
   payload SHA-256 and the provider / installation / project / event / action scope.

A repeated delivery with the same payload and scope returns the original receipt reference
(`duplicate: true`) and does not run the adapter's handler again. The same delivery ID with a different
payload or scope is refused with `IDEMPOTENCY_CONFLICT` and recorded as a `tampered` row linked to the
original, which is never overwritten. A delivery whose handler failed can be redelivered; one still
`received` after five minutes is treated as abandoned. Deliveries for a paused or revoked integration, and
for an installation that maps to no workspace, are recorded as `ignored` and run no handler.

Records are append-only evidence: the database refuses to change a delivery's identity columns, a terminal
outcome or a `tampered` row.

## PostgreSQL

Both tables carry `workspace_id`; migration `0012_integrations` enables and forces the `tenant_isolation`
row-level-security policy on them through `tm_enable_tenant_rls`. `inbound_webhook_deliveries.workspace_id` is null only for an unattributed delivery,
which no tenant-scoped connection can see; the webhook receiver and the adapter's installation lookup
(`IntegrationContext.findIntegrations`) therefore run in the `"*"` controller scope.
