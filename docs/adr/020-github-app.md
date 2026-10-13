# ADR-020: GitHub App and previews

- Status: accepted
- Date: 2026-10-13
- Scope: M4 GitHub integration (INT-014–023, SEC-047, INV-014, J12).

## Context

M4 delivers PR-triggered runs against preview deployments with required checks bound to the assessed SHA. Webhook input is attacker-influenced; fork code must never reach secrets.

## Decision

- **Creation.** The App is created with the GitHub manifest flow.
  - Permissions: metadata read, contents read, checks write, pull_requests write (comments), deployments read. `contents: write` is requested only when the integration setting `allowAgentPullRequests: true`.
  - Events: `installation`, `installation_repositories`, `push`, `pull_request`, `deployment_status`, `check_run`.
  - Credentials (App ID, private key PEM, webhook secret, client secret) are stored as TestMaster secrets bound to `https://api.github.com`.
- **Webhook endpoint** `POST /v1/integrations/github/webhooks`.
  - Order of checks: Content-Type `application/json`, body ≤ 5 MiB (413 otherwise), `X-Hub-Signature-256` HMAC-SHA256 over the raw bytes compared with `timingSafeEqual`, then schema validation.
  - The secret is rotatable: during a 24 h window two secrets are accepted.
  - Dedupe on `X-GitHub-Delivery` in `inbound_webhook_deliveries`, unique `(provider, delivery_id)` with the payload sha256:
    - same ID and same hash → 200 with the original outcome;
    - same ID and different hash → 409 `IDEMPOTENCY_CONFLICT`, recorded as `tampered`.
  - Events for an unknown or revoked installation, or a repository outside the installation's allowlist, are recorded and create no Run.
- **Tokens.**
  - App JWT: RS256 via `node:crypto`, `iat = now-60`, `exp = now+540`.
  - Installation tokens are minted per use with explicit `repositories` and `permissions`, cached only in memory until 5 minutes before `expires_at`, and never persisted.
- **PR flow.**
  - `pull_request` (`opened`, `synchronize`, `reopened`) for a repository bound to a project creates or updates a `GitHubPullState` keyed `(repositoryId, prNumber, headSha)`.
  - Both checks (`TestMaster / result`, `TestMaster / required-gate`) are created `queued` on that head SHA through the existing check `Delivery` machinery (`packages/application/src/delivery.ts`).
  - Preview: wait for a `deployment_status` with `state: success` whose `deployment.sha === headSha` and whose `environment` matches the project setting `preview.environmentPattern` (glob, default `*`).
    - The preview URL must pass `EgressPolicy` (`packages/sandbox/src/egress/policy.ts`) against the project network policy.
    - Deadline: `preview.timeoutMs`, default 1 800 000. On timeout the state becomes `timed_out`, `result` concludes `action_required` and `required-gate` concludes `failure`.
  - Then a BatchRun of the project's `github.suiteId` is admitted against an ephemeral environment revision whose `targetOrigins` is the preview origin. Origin `"github"` is added to `RunRequest.origin`.
  - Push A then B on the same PR: in-flight work for older SHAs is cancelled (`superseded`). Their checks conclude `cancelled` on their own SHA and the comment marks them superseded.
  - Checks never move to another SHA.
- **Forks.** A PR whose `head.repo.full_name !== base.repo.full_name` gets no execution by default (`github.forkPolicy: "deny"`): `result` concludes `action_required` and `required-gate` concludes `failure`, with `fork_policy_denied`.
  - `"fixture-only"` runs only against an environment flagged `fixtureOnly: true` that has no secret refs.
  - `pull_request_target` events are ignored.
- **Comments.** The PR comment is upserted by the marker `<!-- testmaster:pr installation=<id> repo=<id> pr=<n> -->`. All interpolated text is Markdown-escaped. It links to `<publicOrigin>/runs/<id>` and `<publicOrigin>/batches/<id>`, which need portal authentication.
- **Uninstall.** `installation.deleted` and `installation.suspend` revoke the installation: state `revoked`, in-memory tokens dropped, `operational_state['integration:revoked:<id>']`. Restore re-applies these keys, so an old backup never reactivates the App.
- **Previews.** The provider contract is `github-deployments`, which covers Vercel, Netlify and Render because they all publish GitHub deployment statuses, plus `manual` (URL posted with `POST /preview-deployments`). No vendor API is called.

## Consequences

- Required checks accept only `success` for passing; neutral, action_required, cancelled and passed-with-gate-failed never satisfy them.
- No vendor-specific preview API is called; vendors without GitHub deployment statuses use `manual`.
