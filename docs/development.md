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
file is `{defaultProfile?, profiles: {name: {config?, policy?, endpoint?, projectId?, modelProviders?}}}`.
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
M2 source/discovery/requirement/proposal/usage commands share application services. Declare
OpenAI-compatible `modelProviders` only in the selected user profile, grant their IDs in the
operator policy's `allowedModelProviders`, then explicitly `consent grant --provider ID
--data-class documents requirements` for the project before normalization/planning. Revocation
is durable and audited. Repo content cannot configure providers or tools. Model costs without
prices remain `unknown`; a monetary ceiling refuses unknown reservations rather than assuming zero.

Sources retain immutable bytes/hash/parser revisions and expose `invalid` or `needs_input`
instead of empty successful input. Discovery uses AST-only summaries, confines its repo root,
requires explicit diff base/head (or base plus working tree), and resumes only the same complete
input fingerprint. Deterministic discovery is labelled partial until observed exploration grounds it.
Requirements preserve conflicting source refs; reviewers adjudicate conflicts and explicitly approve
selected requirements. Generated executable proposals need typed nontrivial assertions and grounded
refs. `plan accept --only ... --expected-version N --idempotency-key KEY` atomically creates only
selected generated revisions and preserves retained proposals. Edits are CAS and return a diff on
conflict. J02/J03 live journeys record their exercised evidence in `validation/results/`.
M3–M6 groups report their milestone rather than returning successful placeholders.

`server start --port 7331` owns the foreground worker and publishes `/v1` plus `/mcp` only on
`127.0.0.1`. The startup receipt reports the private token file, not its contents; `--print-token`
is an explicit opt-in. Token hashes, workspace binding, scopes, expiry and revocation live in
SQLite; the plaintext file is a descriptor-confined regular file with mode `0600`. Browser Origins
are denied unless explicitly supplied with repeatable `--origin`; non-browser clients omit Origin.
Every protected request and stream reconnect resolves the token identity, and services recheck
scopes. `--mode server` remains unavailable until M4.

HTTP mutations require `Idempotency-Key` (16–128 characters); authoring updates require quoted
`If-Match` versions. Collection pages use signed workspace/filter-bound keyset cursors with a
five-minute expiry. Run SSE uses signed `Last-Event-ID` cursors and 15-second heartbeats;
slow clients disconnect and reattach instead of dropping terminal events. Upload byte streams
use `application/octet-stream` and `X-Upload-Token` in addition to the bearer installation token;
only explicit completion after exact size/hash verification permits ingestion. OpenAPI is served
at `/v1/openapi.json`. M3+ routes return `CAPABILITY_UNAVAILABLE` with their milestone. Manual
resource compensation is available through `resource get` (approval binding), `approval create`,
and `resource cleanup --approval ID --expected-version N --idempotency-key KEY`. It replays only
the recorded compensation inside a fresh hardened sandbox with the original environment policy,
protected handle, ownership proof and a consumed resource-bound approval. Failed or uncertain
compensation preserves the owning Run's original verdict and records a separate cleanup event.

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
- `CodeImportService(context, {cwd, dataDir}).import({projectId, path, format, name?})`
  admits confined `.ts` Playwright or `.py` pytest code after parse-only AST checks. Relative
  code helpers are bundled; imports outside the runner allowlist, shell/eval/install access,
  disabled timeouts and empty/constant/self-comparison assertions are refused. Python parsing
  uses isolated `python3 -I -S` with CPU, address-space, output and wall-time limits, never import
  or execution of submitted source. Static validation is not a sandbox or behavioral proof.
- Code revisions have `plan: null`, a `CodeReference`, immutable authored bundle/lock Artifacts,
  and `origin`/`trustLevel` of imported or generated. Authored artifacts have null Run/Attempt/
  Snapshot provenance; migration 0002 enforces all-or-none execution provenance. `readBundle`
  verifies ownership, source/bundle hashes and revision linkage before runner materialization.
  Its bundle stores `files` (relative UTF-8 source bytes), `sourceHashes`, `entrypoint`, `format`,
  validator version, discovered test names and limitations. The separate dependency lock pins
  image ID/build-input hash and forbids runtime installs. Both harnesses emit a real aggregate
  `imported-code` assertion from reporter/process outcome; no declarative plan is synthesized.
- `createRevision(testId, codeRef, parentId?, idempotencyKey?)` and
  `createTestFromReference({projectId, codeRef, name?, idempotencyKey?})` recheck owned same-project
  code references and ASTs. `createGeneratedRevision(testId, {code, format, parentId?})` creates
  a checked candidate without promotion; none of these methods claims execution passed.

- `explore --url URL --env ENV` uses a hardened browser Attempt and returns a partial feature
  map with sealed observation evidence. Its controller-enumerated links are the only model
  choices; requests/time/model-call budgets and an empty mutation allowlist are enforced
  independently of page text. `ExploreService.begin` exposes a durable job receipt, completion,
  read/resume and cancellation for API/MCP callers.
- `test run --mode agent --revision REV` requires an accepted generated proposal. Resolution
  flags name existing action steps; the model chooses only typed actions grounded in sanitized
  browser observations. Assertions remain deterministic and immutable. A passing agent Attempt
  produces a separate generated candidate event; a passing replay and explicit revision promotion
  are required before that candidate becomes active. Semantic judgments are listed separately
  (none are used as replacements for deterministic assertions).
- `test export ID --format playwright|pytest --out DIR` writes a confined standalone project
  with pinned dependencies and configuration-driven base URL. `test import --path FILE --format
  playwright|pytest` and `test create --code FILE --runner playwright|python` admit checked source
  bundles and execute only inside the matching pinned Docker image. Generated-code candidates
  likewise require AST validation and replay verification; compilation never establishes passing.
- `CodeExportService(context, {cwd, dataDir}).export(testId, {format, out?, revisionId?, async?})`
  reads an immutable authorized revision and returns `files` plus deterministic metadata without
  a model call or secret release. Writing requires W scope and a new directory confined beneath
  the workspace, outside application data. Plan exports include `package-lock.json` for pinned
  Playwright 1.63.0 or `pyproject.toml` plus a real `uv.lock` for Python 3.12 pytest/requests and
  sync/async Playwright. Unsupported predicates and unresolved source schemas fail explicitly.
- Configure exported projects through `BASE_URL`, `TEST_INPUTS_JSON` (variables, artifact
  manifest and popup aliases), `SECRET_<secretRef>`, and `INPUT_DIR`. Exact text/JSON Pointer
  assertions are retained, including independent assertions after navigation/reload. Producer
  outputs are supplied explicitly; export never queries earlier runs for convenient bindings.
  Imported code exports preserve authored bytes and the admitted `runtime-lock.json`; format
  translation is refused, and authored harness-specific fixtures still require that harness.
  Standalone projects do not implement supervisor grants/approval/egress/redaction: use an
  authorized target and external isolation. Docker export tests exercise byte-identical generated
  helpers through `AttemptExecutor` against healthy and semantic-mutant fixtures.
