# Portal settings, secrets and retention

These pages are part of the server-profile portal. Every call they make is a public `/v1` catalog route; there is no private portal API.

## Project settings (`/projects/<id>/settings`)

- **Environments.** Editing an environment shows, before the save dialog, what the change does to reproducibility (a new environment revision is created and earlier results are not recomputed), cost and data protection (production flag, target origin). A save always creates a new revision; earlier revisions stay readable at `GET /environments/{id}/revisions` (variables are never returned there). If someone else changed the environment first, the save fails with `REVISION_CONFLICT`, nothing is overwritten and the page offers "Reload latest".
- **Model data sharing.** Consent is per provider and per named category (documents, code_summary, dom, requirements, plans, execution_evidence). Nothing is shared by default. A provider the server profile does not allow is shown with that reason and cannot be granted. Revoking stops future calls; data already sent is not recalled.
- **Token budget.** The lifetime token budget is validated at the field, its impact is shown, and the limit is enforced by the server.
- **Limits.** The execution limits table is read-only and comes from `GET /capabilities`. Values the server does not report are labelled "Not reported", never invented.

## Secrets (`/secrets`)

Secrets are write-only. The value field is a password input that is never prefilled and is cleared after storing or rotating. The value is not returned by any route and is absent from the DOM, URL, storage, cookies and exports. Rotation (`POST /secrets/{id}/rotate`) bumps the version; history (`GET /secrets/{id}/history`) lists created, rotated and revoked events with actor and request id, never values. Roles without secret access see the page with the reason the controls are off, and the server refuses the same calls.

## Retention and deletion (`/projects/<id>/retention`)

Four actions are kept apart, each with its own confirmation naming the project and the resource:

1. **Remove a reference** (secret reference): deletes no test, revision, result or artifact.
2. **Archive a test** (single or bulk). Bulk actions apply only to the selected rows; with nothing selected they do nothing and never widen to the whole list.
3. **Expire an artifact**: leaves a tombstone. History never says the evidence "never existed".
4. **Purge project data** (admin only): the project must be archived first, no Run may be unfinished, and the confirmation is typing the project slug (the button is inert until it matches; the server checks the same token). The purge is one durable deletion operation listed under "Deletion history and tombstones". Legal holds still defer physical deletion.

## Demonstration workspaces

A workspace whose `quotaPolicyId` is `demo` shows a banner on every page, and the server refuses CI gates for it (`POLICY_DENIED`, reason `demo_workspace`). Demo data appears only there.
