# ADR-017: Team identity, sessions, tokens and RBAC

- Status: accepted
- Date: 2026-10-13
- Scope: M4 multi-user identity (`packages/application`, `packages/contracts/src/rbac.ts`, `apps/server`).

## Context

M0–M3 authenticate one local human through host-issued local tokens kept in `operational_state`. M4 needs multiple humans per workspace, a browser portal, API tokens, workers and an operator role, with RBAC as data rather than inline tables.

## Decision

- **Bearer tokens.** All bearer tokens live in the existing `server_tokens` table.
  - Formats: `tm_local_<43 base64url>` (host-issued, as today), `tm_api_<43>` (created via `POST /tokens`), `tm_wrk_<43>` (worker enrollment, one use), `tm_op_<43>` (host-issued operator token that may create workspaces).
  - `data_json` holds `{name, kind, scopes, grants, audience, operator}`.
  - Migration 0010 moves every `operational_state` row `local-token:<sha256>` into `server_tokens` and deletes the old rows. `authenticateLocalToken` is replaced by `authenticateToken(app, token)` reading `server_tokens`. Clean cutover: no fallback to `operational_state`.
- **Passwords.** Human login uses a password stored in `password_credentials`.
  - Hash: scrypt with N=32768, r=8, p=1, 32-byte salt, 64-byte key. Stored as `scrypt$32768$8$1$<salt b64>$<key b64>`, compared with `timingSafeEqual`.
  - `login` is globally unique and matches `^[a-z0-9][a-z0-9._@-]{2,63}$`.
  - Lockout: after 10 failures within 15 minutes, the credential is locked for 15 minutes. All failures return the same `UNAUTHENTICATED "Invalid credentials"`.
- **Sessions.** Table `sessions`.
  - Cookie `__Host-tm_session=<43 base64url>` with `HttpOnly; Secure; SameSite=Strict; Path=/`.
  - Absolute TTL 12 h. Idle TTL 30 min, refreshed at most once per minute.
  - CSRF: login returns `csrfToken` (43 base64url). Its sha256 is stored. Every cookie-authenticated non-GET request must send a matching `X-CSRF-Token` and an `Origin` in the configured allowlist, else `FORBIDDEN` with `details.reason: "csrf"`.
  - Bearer requests never read cookies.
- **Recovery.** `testmaster identity recovery-token --login <login>` is in-process and needs `A`. It prints a one-time token valid for 30 minutes, stored hashed in `password_credentials`. `POST /identity/recovery` with `{principal, recoveryToken, newPassword}` sets the password and revokes all sessions of that principal.
- **Workspace binding.**
  - `Application.withIdentity` binds `context.workspaceId` from the authenticated token or session record, never "first workspace".
  - "First workspace / first human" stays only for the SQLite single-user in-process CLI path.
  - On PostgreSQL, `Application.open` without an identity may only run host operator commands (`db`, `server bootstrap`, `server operator-token`, `identity recovery-token`, `backup`). Any service call that authorizes throws `UNAUTHENTICATED`.
- **Workspace creation.** A workspace equals an organization in M4. Only `tm_op_` tokens may `POST /workspaces`. The body `WorkspaceInput` gets `ownerLogin`. The response includes a one-time `ownerRecoveryToken` that the new owner uses with `/identity/recovery`.
- **RBAC.** The RBAC matrix is data in `packages/contracts/src/rbac.ts`, consumed by authorization and exposed at `GET /v1/rbac/matrix`.
  - It replaces the inline role-default tables in `Application.authorizePermission` (`packages/application/src/application.ts`) and `authorizeNamed`.
  - Columns `read | write | execute | secret | export | admin` take values `allow | deny | grant-only`:

  |Role|read|write|execute|secret (write/rotate; reveal never by role)|export (redacted)|admin|
  |---|---|---|---|---|---|---|
  |org_owner|allow|allow|allow|allow|allow|allow|
  |org_admin|allow|allow|allow|allow|allow|allow (no change to `org_owner` memberships)|
  |maintainer|allow|allow|allow|allow|allow|deny|
  |runner|allow|deny|allow|deny|deny|deny|
  |reviewer|allow|allow (proposal/healing decisions and revisions)|deny|deny|allow|deny|
  |viewer|allow|deny|deny|deny|deny|deny|
  |service_account|grant-only|grant-only|grant-only|grant-only|grant-only|deny|

  Rules on top of the matrix:
  - Pipeline decisions (proposal acceptance, healing approval, execution approval, requirement approval) use the ordinary write scope of any authenticated principal and are recorded with it. Only the SEC-047 agent pull-request path (and the M5 visual baselines) keeps an explicit `approve` grant (`authorizeNamed`).
  - `raw` and secret reveal/export require an explicit unexpired grant.
  - Grants now match `resourceType` (`"*"` matches all). This fixes the defect where any grant with a matching action widened generic scope.
  - Changing one's own membership returns `FORBIDDEN` with `details.reason: "self_promotion"`.
  - Removing or demoting the last `org_owner` returns `PRECONDITION_FAILED "Workspace needs an org_owner"`.
  - When a worker claims a job, it re-authorizes `X` for the job's `actorId`. If that fails, the Run ends `blocked` with reasonCode `actor_revoked` and no Attempt starts.

## Consequences

- Authorization has one data source; docs tables and the HTTP matrix are generated from it.
- SSO/SCIM are out of scope for M4 (SCIM revocation source is M6, OPS-019).
- Every credential kind is revocable through one table, so SSE streams and sessions can be ended by the same mechanism.
