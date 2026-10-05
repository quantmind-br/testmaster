# Development

## Toolchain

- Node.js `>=24 <25`, pnpm 12.9.1 (`packageManager`), ESM only.
- TypeScript 7.0.2 strict with project references (`tsc -b`). Base options in `tsconfig.base.json`
  (`nodenext`, `es2024`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `isolatedModules`).
- Biome 2.5.15 for lint and format (`preset: recommended`).
- Vitest 5.0.3; fast-check 4.10.2 for property tests.
- Python 3.12 via uv for the `python/` adapter.
- Docker (rootful, hardened; see `docs/adr/`) for sandboxed execution.

## Layout

- `packages/*`: libraries (`@testmaster/<name>`). Each exports
  `{"source": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js"}`.
  Vitest resolves the `source` condition, so tests run against `src` without a build.
- `apps/*`: executables (CLI, server, MCP).
- `fixtures/*`: reference applications and adversarial corpora (plain ESM JavaScript, no deps).
- `tools/`: repository tooling (traceability checker, dependency-direction test, CI script).

Dependency direction (NFR-009): `contracts` ← `domain` ← `persistence`, `evidence` ← `sandbox`,
`model-gateway`, `planner`, `reporting` ← `application` ← `apps/*`. `runner` imports only
`contracts`, `domain`, `playwright-core`, `undici`.

## Tests

Tests live next to the code as `src/**/*.test.ts` and are excluded from `tsc` output.

| Project | Files | Command | Requirements |
|---|---|---|---|
| unit | `*.test.ts` | `pnpm test` | hermetic, no external network |
| docker | `*.docker.test.ts` | `pnpm test:docker` | Docker daemon, built runner images |
| live | `*.live.test.ts` | `pnpm test:live` | `QUANTFORGE_API_KEY` for the real model |

Permanent tests exercise observable behaviour (state transitions, denials, hashes, exit codes,
real browser/API outcomes). No tests that pin wording, wiring or defaults.

## Conventions

- Code, identifiers, comments and commit messages in English; Conventional Commits.
- One logical change per commit; every commit builds and passes `pnpm build && pnpm lint && pnpm test`.
- All manifests are `"private": true`, `"license": "UNLICENSED"` until the maintainer picks a license.
- Field names, enums, reason codes and error codes are copied verbatim from `specs/`.
- Disabled features return `CAPABILITY_UNAVAILABLE` with `details: {capability, milestone}`; never a
  stub that reports success.
- Never use `--network=host`, `--privileged`, Docker socket mounts, `--no-sandbox` for Chromium, or the
  process executor as an implicit fallback.

## Local application and CLI

`@testmaster/application` is the shared service boundary for CLI, API and MCP. Open an
`Application` with an explicit `cwd`; initialize once with `init()`, then use `projects`,
`environments`, `tests`, `revisions`, `approvals`, `secrets`, `runs`, `batches`, `worker`,
`artifacts`, `reports` and `backups`. `close()` releases SQLite. Every service checks the
local principal, membership, project restrictions and optional session `R/W/X/A` scopes;
server/MCP callers must pass their authenticated identity to `Application.open`.

Run admission atomically writes the pinned revision/environment/config, lease, outbox and
idempotency receipt. A foreground `worker start` owns durable execution. Without a live
worker, `test run --wait` owns an ephemeral supervisor; asynchronous admission is refused.
Client timeout never implies a passing verdict. Ctrl-C detaches from a persistent worker
unless `--cancel-on-interrupt`; interruption of an ephemeral owner cancels and cleans up.
Attempts run only through the hardened sandbox. Explicit unsafe process execution requires
both `--unsafe-local` and operator authorization and is labelled `isolation: none`.

Configuration precedence is flag, `TESTMASTER_*`, project config, selected user profile,
defaults. `resolveConfig` exposes each leaf origin and the policy digest. The user profile
file is `{defaultProfile?, profiles: {name: {config?, policy?, endpoint?, projectId?}}}`.
Operator ceilings/grants live in `~/.config/testmaster/policy.json`; profile policy narrows
them. Repo config cannot enable model providers, uploads or unsafe execution. `CI=true`
restricts healing, and offline keeps authorized loopback targets usable without model calls.

Secrets enter through `secret set NAME --from-env VAR` or `--file PATH`, never argv values.
The keychain receives values on stdin. Its AES-256-GCM fallback stores versioned ciphertext
under `~/.local/share/testmaster/` and a private key at `~/.config/testmaster/vault.key`,
outside SQLite and backups. Ephemeral values exist only in the current process. A runner
receives only pinned, non-revoked, origin-authorized refs through the protocol.

Test and environment revisions are immutable. Updating a test or promoting a candidate
uses the TestCase version for CAS; an admitted Run never moves to a later revision.
Production mutation approvals bind actor, revision/environment hashes, origins, actions
and policy, and are consumed in the admission transaction. Plan lint/scaffold/dry-run are
offline APIs and do not open the database. Evidence downloads verify committed IDs/hashes;
raw trace/video requires explicit `--raw`. Reports derive from the same committed snapshot.
Backup restore writes an isolated directory, suspends admission and requires operator review.

Required producer dependencies are expanded into separate pinned Runs; requested and expanded
denominators remain separate. Consumers wait for a successful producer gate, exact revision,
environment, typed capture and freshness before any target effects. Public capture values stay
in accepted observations; sensitive captures cross only the trusted runner protocol and are
encrypted by the supervisor into secret references before persistence. Runtime sockets use a
short private per-user runtime root to remain inside the Unix socket pathname limit.

Worker maintenance expires only eligible completed evidence through versioned
mark/tombstone/delete, leaving sealed metadata and historical verdicts immutable. Trusted DB
tombstones produce an expired/partial evidence view. `operational_state` keys
`retention:artifact:<workspaceId>:<artifactId>` record GC stages; legal holds use
`retention:legal-hold:<workspaceId>[:<runId>|:<artifactId>]` (any value except `released` holds).
Storage use at 80% warns; at 90% new admission suspends. Only the pressure-owned
`suspended_storage` state is automatically recovered; restore/manual suspensions are not.

Report entries expose `freshness.state` (`current` or `stale`) by comparing the admitted test
and environment revisions against their current active revisions. Reasons and current IDs
make changed test source and environment context explicit. This is a read-time view, separate
from artifact completeness: expiry may make a bundle partial while its original Run outcome,
snapshot hashes and historical audit remain unchanged. JSON, Markdown and HTML expose freshness.
The J17 evidence-history Docker journey advances only its maintenance subprocess clock, exercises
real retention, and proves foreign Run/Attempt snapshot substitution is denied.



M1 journeys use the built CLI and real reference app in `validation/journeys/`. They write
observed JSON summaries under `validation/results/`. The separately exercised manual quickstart
transcript is `validation/results/quickstart-m1.md`.
M2 command groups are registered but unavailable until their application surfaces are enabled;
M3–M6 groups report their milestone rather than returning successful placeholders.

### Service integration notes

- `Application.open({cwd, configPath?, profile?, env?, identity?})` resolves configuration and
  opens local storage. `identity` carries `principalId`, `scopes` and optional permission grants;
  never replace authenticated server/MCP identities with the default local principal.
- Projects/environments/tests expose create, list, get, update and archive; updates take
  `expectedVersion`. `revisions.create/get/list/promote` keep revision content immutable;
  promotion CAS applies to the owning TestCase version.
- `runs.admit(request, {wait?, idempotencyKey?, unsafeLocal?})` returns an owned receipt;
  `batches.admit(request, options)` admits requested and expanded members atomically.
  `runs.get/list/events/steps/wait/rerun/cancel` are the read/wait/control boundary. Event
  polling takes `afterSeq`; durable outbox rows retain stable event IDs and sequences.
- `worker.run({signal?, ephemeral?, runIds?})`, `worker.live/status/drain/reconcile` provide local
  supervisor control. Ephemeral dispatch must include expanded dependencies, not just the
  requested run IDs. `retention.maintenance()` is internal worker maintenance.
- `artifacts.get(runId, {attemptId?, out?, failedOnly?, allowRestrictedRaw?})` verifies sealed
  bundles. `reports.snapshot/export` produce JSON, Markdown, HTML, JUnit or Allure.
  `backups.create/restore` require admin scope; restore never executes restored jobs.
- `secrets.set/rotate/remove/get/list/release` separate metadata from values; `release` is a
  supervisor-only integration port. `approvals.create/get/list/revoke/verify` bind explicit
  mutation approval to the exact admitted revision, environment and policy.
- Replay modules do not import the model gateway. M2 services may build on this boundary
  without introducing model loading into deterministic execution.

