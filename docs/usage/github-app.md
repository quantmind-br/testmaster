# GitHub App and previews

TestMaster (milestone M4) tests a GitHub pull request against its preview deployment and reports the result as
two checks on the pull request's head commit. It runs as a GitHub App you create for your own deployment; no
shared TestMaster App exists, and no vendor API is called.

What it does for a pull request that targets a repository you enabled:

1. Creates `TestMaster / result` and `TestMaster / required-gate` as `queued` on the head SHA.
2. Waits for a `deployment_status` event with `state: success` for that SHA whose environment matches the
   repository's `preview.environmentPattern` (default `*`). The preview URL must pass the project's network
   policy. Vercel, Netlify and Render publish such statuses; so does any CI that creates GitHub deployments.
   For anything else use the `manual` provider and attest the URL yourself.
3. Runs the project's tests against that URL in an ephemeral copy of the base environment and publishes the
   terminal result on **that SHA only**.
4. Keeps one comment per pull request, edited in place, linking to the authenticated portal pages.

Pushing a newer commit cancels the work of older ones. Their checks conclude `cancelled` on their own SHA; a
check never moves to another commit.

## Create the App

```bash
testmaster integrations github setup --public-origin https://testmaster.example.com --project <project-id>
```

`--public-origin` is the HTTPS origin GitHub reaches the webhook on (`<origin>/v1/integrations/github/webhooks`);
a plaintext public origin is refused. The command serves the GitHub manifest form on `127.0.0.1`, prints the
URL, and waits. Open it, click **Create GitHub App**, confirm on GitHub, and the command stores the App
credentials (App ID, private key, webhook secret, client secret) as TestMaster secrets bound to
`https://api.github.com`. Credentials are never printed and never returned by the API. The command then prints
the install URL.

Options: `--name`, `--organization <login>` (create under an organization), `--allow-agent-pull-requests`
(also requests `contents: write`; leave off unless agents may open pull requests), `--timeout <seconds>`
(default 900), `--port`. Against a server-profile deployment add `--mode server --token-env <VAR>` with an
administrator token in that variable.

Requested permissions: metadata read, contents read, checks write, pull requests write, deployments read.
Events: `installation`, `installation_repositories`, `push`, `pull_request`, `deployment_status`, `check_run`.

The same flow is available over HTTP (`POST /v1/integrations/github/manifests`, then
`POST /v1/integrations/github/manifests/{state}/conversion`) for integrators that cannot run the helper.

GitHub Enterprise Server is not configured through the CLI. The adapter reads an `apiBaseUrl` runtime option;
treat any GHES deployment as unverified.

## Enable repositories

Installing the App enables nothing. Open **Integrations → GitHub** in the portal, choose the integration, and
for each repository set:

| Setting | Meaning |
|---|---|
| Run pull requests | Off by default. Nothing runs for a repository until it is on. |
| Project and base environment | The project whose tests run, and the environment whose locale, timezone and policy are copied into every ephemeral preview environment. |
| Pull requests from forks | `deny` (default) or `fixture-only`. |
| Preview provider | `github-deployments` or `manual`. |
| Preview environment pattern | Glob over the deployment environment name, for example `preview/*`. |
| Include draft pull requests | Drafts are skipped by default. |
| Preview tunnel | `previewTunnelId`, REST only: an active tunnel of the bound project that same-repository previews run through (see below). |

The same settings are `PATCH /v1/integrations/{id}/github/repositories/{repositoryId}`. Administrator scope is
required; only repositories the installation grants can be configured.

A repository the installation stops granting, or an installation that is suspended or deleted, can no longer
be configured and starts nothing.

## Forks

A pull request whose head repository differs from the base repository never runs by default: `result`
concludes `action_required`, `required-gate` concludes `failure`, with reason `fork_policy_denied`. Fork code
and workflow files are never read; configuration comes from the base. `pull_request_target` events are
ignored.

`fixture-only` runs a fork only against an environment flagged as a fixture that references no secret and is
not production. A fork run can never satisfy the required gate: the gate is `failure` and the result `neutral`.

## Required-check semantics

`TestMaster / required-gate` is the check to require in branch protection. It is `success` only when the
terminal Run passed, the gate passed, the pull request is not from a fork and the Run is bound to the
deployment GitHub reported for that SHA. It is never `neutral`, `skipped` or `success` for anything else:
timeouts, missing previews, failed or cancelled Runs, unbound verdicts, selections that match nothing and
fork pull requests all conclude `failure`, `cancelled` or `action_required`.

`TestMaster / result` carries the detail: Run, environment, SHA, exclusions, first-attempt outcome, freshness
and a link to the authenticated portal page. The link opens a portal page that requires sign-in; it is never a
public URL.

## Manual previews

For a repository using the `manual` provider, a pull request waits in `awaiting_preview` until someone with
write scope attests the URL: `POST /v1/preview-deployments` (`integrationId`, `repositoryId`, `prNumber`,
`headSha`, `url`) or the **Manual preview** form on the integration page. The Run's provenance then records
`binding: "unbound"` with a human attestation, never `verified`, and the network policy still applies.

## Previews through a tunnel

A developer can serve a pull request's preview from their own machine through a self-hosted tunnel
(`testmaster --endpoint <server> tunnel start --target 127.0.0.1:<port>`). Set the repository's
`previewTunnelId` to that tunnel (it must be active and belong to the bound project) and attest each head with
a manual preview at the tunnel's target URL, `http://127.0.0.1:<port>`. A same-repository head is then admitted
with the tunnel and runs on a remote worker; a fork never uses the tunnel, whatever its fork policy.

A Run through a tunnel needs a reviewer's approval (SEC-039). Without one the head is denied with
`admission_failed:POLICY_DENIED`, `result` concludes `action_required` and `required-gate` `failure`, and the
pull request's `approvalBinding` (`GET /v1/integrations/{id}/github/pulls`) lists the exact fields
`testmaster approval create` needs, including `actorId` and `limits`. An approval is consumed by one Run, so
every later head is denied again until it is approved. Stopping the tunnel cancels the preview's Run with
`tunnel_lost`; its checks never turn green.

## Delivery problems

Publishing to GitHub is separate from the verdict. A rate limit (`rate_limited`), an unreachable host
(`host_unavailable`) or a revoked permission (`permission_revoked`) retries with backoff and raises an
`alert.fired` event, once per class. A rejection retrying cannot fix, or exhausted retries, ends in
`dead_letter`, visible on the integration page, where **Retry delivery** republishes the same content. None of
these change a Run, a batch or a gate.

## Revocation, uninstall and restore

`installation.deleted` and `installation.suspend` revoke the installation: tokens are dropped, nothing runs and
the state is `revoked`. The revocation is recorded in a tombstone that survives a restore, so restoring an
older backup cannot reactivate an App that was uninstalled afterwards. After a restore the integration stays
inactive until an administrator re-enables it; while the restore isolation flag is set no pull request is
advanced.

## Rotating the webhook secret

`POST /v1/integrations/{id}/github/rotate-webhook-secret` with the new secret reference. The previous secret
keeps verifying for 24 hours so in-flight deliveries are not lost; after that only the new one does. Update the
secret in the GitHub App settings within that window.

## What to know

- Deliveries are deduplicated on `X-GitHub-Delivery`. A redelivery returns the original outcome; the same ID
  with different bytes is a `409 IDEMPOTENCY_CONFLICT`, recorded as `tampered`.
- Installation tokens are minted per use for the one repository and permission set needed, kept only in
  memory, and never stored.
- Agent-created branches and pull requests need `allowAgentPullRequests`, an installation with
  `contents: write`, and an explicit human `approve` grant for the agent. They only create new `testmaster/…`
  branches and draft pull requests, never touch the base branch or workflow files.
- Jira and Linear trackers are separate integrations ([ADR-034](../adr/034-trackers-memory.md)); a pull
  request check never files an issue. The test suite for a project (`github.suiteId`) is not yet
  selectable; a repository runs all tests of its project or an explicit list.
