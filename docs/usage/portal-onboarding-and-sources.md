# Portal: onboarding, sources, discovery, requirements and feature map

These portal pages (milestone M4) take a new project from "nothing" to "reviewed requirements and a
coverage map". They use only the public `/v1` API; there is no portal-private endpoint. Every page is
under `/projects/:projectId/…` and appears in the project sub-navigation.

## Onboarding wizard

`/onboarding` chooses a mode (local repository, remote target, import an existing spec); the wizard
itself is `/projects/:projectId/onboarding`.

- **Resumable.** The state is stored on the server, per principal and project
  (`GET|PUT /v1/projects/{id}/onboarding`, `If-Match` required on `PUT`). A refresh, another browser or a
  new login resumes at the saved step. Two principals on one project have independent states.
- **No credentials.** The wizard never stores a secret value, a URL with embedded credentials or a
  token. A target is reduced to its origin. Authentication is chosen by referencing an existing secret
  (`authSecretRefs`); a reference to a secret that does not exist cannot be saved.
- **Commands are text.** Suggested commands (install, start the application) are recorded and shown;
  the wizard never runs them and never opens a tunnel.
- **Prerequisite check** (`POST /v1/projects/{id}/onboarding/checks`). Each prerequisite reports its own
  status and, when blocked, a registry reason code, so the page can tell the causes apart:

  | Prerequisite | Blocked because | Reason |
  | --- | --- | --- |
  | Runner | The sandbox runtime is not available | `security_precondition_failed` |
  | Authentication | A referenced secret is missing or revoked | `missing_secret`, `credential_revoked` |
  | Policy | The environment's network policy denies the target, or the secret is bound to another origin | `egress_denied` |
  | Target | The origin does not answer (policy allowed the attempt) | none; diagnostic `target_unreachable` |

  A target the policy denies is never contacted. Before a target or environment is chosen the check
  reports only the runner (`ready: false`, everything else `not_checked`).

## Sources

`/projects/:projectId/sources` lists every source with its active revision, hash, type, import date,
owner and update status; `…/sources/:sourceId` shows the revision history.

- **Upload.** The file is hashed in the browser, previewed (name, size, role, SHA-256) and only then
  sent (`POST /v1/uploads`, `PUT …/bytes`, `POST …/complete`, `POST /v1/projects/{id}/sources`). A file
  named like a credential (`.env*`, `*.pem`, `*.key`, `id_rsa`, `.ssh/`, `.git/`) is refused with
  `POLICY_DENIED` for uploads as well as for repository paths.
- **Revisions.** Updating a source adds a revision and keeps the earlier ones readable. For structured
  sources (OpenAPI, GraphQL) the page lists added, removed and changed operations against the parent
  revision. Tests whose requirements cite a superseded revision are flagged with the reason
  (`requirement_cites_superseded_revision`); tests that do not rest on the changed source are not.
- **Concurrent updates.** An update made from an out-of-date page fails with `REVISION_CONFLICT`
  (HTTP 412) and changes nothing.
- **Origin state.** A source imported from a repository file shows whether the file is unchanged,
  changed or missing; a missing origin never reads as unchanged.
- **Exclusions.** The fixed policy and the discovery exclusions are listed on the detail page.

## Discovery

`/projects/:projectId/discovery` lists runs and starts a new one.

- **Scope.** *Full* reads the whole repository. *Diff* needs a base and either a head or the working
  tree; the form checks this first and the server enforces it for every client
  (`PRECONDITION_FAILED`). An unknown base is reported, never read as an empty diff.
- **Preview.** The preview lists what was scanned, parsed and skipped (with the skip reason), endpoints,
  routes and features found, the uncertainties and the coverage statement. It never claims the whole
  application was understood. A diff preview shows the exact base and head SHAs (or "plus uncommitted
  changes"), the changed files, the files ignored by the impact analysis and the limits of that
  analysis.
- Excluded files are never read.

## Requirements and PRD view

`/projects/:projectId/requirements` (`GET /v1/projects/{id}/requirements/review`).

- Each requirement links to the exact source span it came from, with source name, revision, byte range,
  span hash and excerpt, and says whether that revision is still the current one. A requirement that
  rests on a superseded revision is flagged, and its old span stays readable.
- A statement inferred only from code is a conflict until the caller (a person or an agent) decides it. A decision needs the
  statement and a reason and is recorded with the actor; approval of a blocked requirement is refused
  by the page and by the server. Statements from the specification are not held back by it.
- Approving is a contextual confirmation and needs a project environment.
- **History.** Every normalization records what was added, removed or reworded (text before and after),
  and every decision and approval, with time and actor. Nothing is approved automatically; the model
  never approves.
- **Normalize** sends the selected sources to the configured model provider only when the operator policy
  allows it; otherwise the page shows the refusal and no model call is made.

## Feature map

`/projects/:projectId/feature-map` lists requirements, discovered endpoints/routes and features, and
their coverage:

| State | Meaning |
| --- | --- |
| Has a valid run | At least one linked test has a run that reached a verdict |
| Tests, no valid run | Tests exist but none has a run with a verdict |
| No coverage | No test is linked; absence is never shown as covered |

Each state has its own words and icon shape, so colour is never the only signal. The summary counts
and the "Show" filter (kept in the URL as `coverage`) are derived from the same data. A limitations
note states what the map cannot know.

## Limits of this release

- English UI only (the pt-BR/en matrix is VAL-041).
- Chromium is the supported browser.
- The accessibility oracle is axe, keyboard-only journeys and 320 px / 200 % reflow checks; no human
  screen-reader session is claimed.
