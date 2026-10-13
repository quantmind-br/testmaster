# Operating the GitHub App

This page is for the operator of a TestMaster server profile that tests GitHub pull requests. User-facing
behavior is in [GitHub App and previews](../usage/github-app.md); the design is in
[ADR-020](../adr/020-github-app.md).

## Prerequisites

- A server-profile deployment reachable from GitHub over HTTPS (the Caddy reverse proxy of
  `deploy/compose` terminates TLS). The webhook is `POST <publicOrigin>/v1/integrations/github/webhooks`;
  it needs no TestMaster token because GitHub's HMAC signature is the credential.
- `server.publicOrigin` in the server config must be the origin GitHub uses. Check-output links and the
  pull-request comment point at `<publicOrigin>/batches/<id>` and `<publicOrigin>/runs/<id>`; both need portal
  sign-in.
- Workers run the ephemeral preview Runs on the same Docker daemon as every other Run. A preview origin must
  be allowed by the project's network profile, or the pull request concludes with a policy denial instead of
  running.
- The `github-reconciler` controller runs inside `testmaster server start`. It advances pull requests,
  publishes checks and comments and enforces preview deadlines. Without it nothing is published.

## Create and install

1. `testmaster integrations github setup --public-origin <url> --project <id>` on the server host (add
   `--mode server --token-env VAR` to act through a token). It stores the App ID, private key, webhook secret
   and client secret as TestMaster secrets bound to `https://api.github.com`.
2. Install the App on the repositories to test from the printed URL. The `installation` webhook creates the
   installation record; repositories stay disabled until an administrator enables them in the portal
   (**Integrations → GitHub**).
3. In branch protection require `TestMaster / required-gate`. Do not require `TestMaster / result`: it can
   legitimately conclude `action_required`.

GitHub's "recent deliveries" page can redeliver any event; a redelivery is answered from the stored record.
Redelivering after a long outage is safe.

## Signals to watch

| Signal | Meaning | Action |
|---|---|---|
| `alert.fired` with `github_check_rate_limited` | GitHub returned 403/429 with a retry hint | Nothing: retried after the advertised delay (bounded). Persistent: reduce concurrent pull requests. |
| `github_check_host_unavailable` | `api.github.com` unreachable or 5xx | Retried with backoff; check egress from the server. |
| `github_check_permission_revoked` | The installation lost `checks: write` | Re-grant the permission in the App settings, then retry. |
| Check in `dead_letter` | A 4xx retrying cannot fix, or retries exhausted | Fix the cause, then **Retry delivery** on the integration page. |
| `github_comment_*` | The comment could not be written | Never changes a check; retried a bounded number of times. |
| Pull request in `timed_out` | No qualifying preview by `preview.timeoutMs` (default 30 min) | Check the preview provider and the environment pattern. |
| Pull request in `denied` | Fork policy or network policy denied it | Intended; see the reason code. |

A verdict is never changed by any of these. The Run, the batch and the gate stay as measured; only what
GitHub shows can lag.

## Rotation

- **Webhook secret**: store the new value as a secret, `POST /v1/integrations/{id}/github/rotate-webhook-secret`
  with its reference, then set the same value in the GitHub App settings. Both secrets verify for 24 hours.
- **Private key**: generate a new key in the GitHub App settings, store it as a secret and update the
  integration's credentials through `PATCH /v1/integrations/{id}`. Installation tokens already minted keep
  working until they expire (one hour at most) and are held in memory only.
- A leaked webhook secret allows forged events until rotated: forged events still need an installation and a
  repository that were enabled, and a forged `deployment_status` can only point at an origin that passes the
  project's network policy.

## Revocation and restore

- `installation.deleted` or `installation.suspend` revokes the installation and writes
  `operational_state['integration:revoked:github:<installationId>']`. The tombstone is authoritative: a row
  restored as `active` is revoked again the first time it is used.
- Restoring a backup sets `restore:isolated`. While it is set the reconciler advances nothing and publishes
  nothing. Re-enable integrations deliberately after checking that each installation still exists on GitHub.
- Backups taken before an uninstall can never reactivate it, because retention keeps the tombstone key.

## Tenant boundaries

All GitHub tables carry `workspace_id` and are row-level-secured on PostgreSQL. Webhook intake and the
reconciler run in the controller scope and take the workspace from the stored installation, never from the
payload. An installation ID can be bound to one workspace only; another workspace claiming it is refused.

## Limits of this release

- One host: write serialization is PostgreSQL's single writer lock (ADR-015).
- Preview providers are `github-deployments` and `manual`; no vendor API is called.
- GitHub Enterprise Server is not part of the validated scope.
- Agent pull requests are off by default (`allowAgentPullRequests`) and need `contents: write` and an explicit
  human approve grant.
- The hosted proof against a real GitHub App installation is recorded separately from the fake-GitHub suite.
