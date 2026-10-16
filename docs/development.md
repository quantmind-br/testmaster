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
`contracts`, `domain`, `playwright-core`, `undici`, and, for the terminal runner (ADR-025),
`@lydell/node-pty` and `@xterm/headless`; it declares `ajv` and `ajv-formats` only so the
`sourceSchemas` fixture of imported Playwright code resolves them (same versions as contracts).

## Tests

Tests live next to the code as `src/**/*.test.ts` and are excluded from `tsc` output.

| Project | Files | Command | Requirements |
|---|---|---|---|
| unit | `*.test.ts` | `pnpm test` | hermetic, no external network |
| docker | `*.docker.test.ts` | `pnpm test:docker` | Docker daemon, built runner images |
| live | `*.live.test.ts` | `pnpm test:live` | `QUANTFORGE_API_KEY` for the real model |

Permanent tests exercise observable behaviour (state transitions, denials, hashes, exit codes,
real browser/API outcomes). No tests that pin wording, wiring or defaults.

The adversarial sandbox Docker suite requires `tcpdump` and permission to run
`sudo -n tcpdump` on loopback for a bounded controlled-target packet recording. It fails
explicitly when capture is unavailable; the container itself never receives extra capabilities.
The suite exercises browser/CDP/broker, JavaScript/meta navigation, service-worker and iframe
requests and WebSocket reconnect denial. A page WebSocket to an approved origin is connected through the proxy and one to any other origin is closed and denied (SEC-011); DNS has
no proxy cache and is revalidated on every fresh socket. Chromium launch failure reports
`blocked/security_precondition_failed` and never retries without its sandbox.
Python runner images remove build-time pip/uv installers after their frozen dependency sync;
runtime dependencies require a reviewed rebuilt image. `python/runtime.json` records the pinned
image ID and exact package versions. Shared evidence text uses known-secret and common sensitive
header/URL/JSON/form/e-mail/document patterns; this is not a guarantee of unknown PII anonymity.
Python pytest items and `testmaster.step(name, index=None)` allocate distinct attempt-local
indexes, including nested steps; finish events retain their start index. Explicit indexes must
be nonnegative and unused (`1000000` belongs to the imported-code wrapper). Repeated or sanitized
colliding names receive distinct step IDs, so an inner failure cannot overwrite its parent's
evidence.
Controller-side raw-pattern hits and malformed JSON/NDJSON are withheld as `redaction_failed`,
and protocol artifact chunks never enter public observation events. Archive extraction accepts
an AbortSignal and removes incomplete staging on failure/cancellation; nested archives are
rejected by both extension and magic, never recursively unpacked.


## Relocatable runtime distribution

Experimental public runtime releases target Linux x64 with Node 24 and rootful hardened
Docker using the containerd image store. Internal workspace packages remain private;
the relocatable archive, not an incomplete npm package, is the distribution boundary.
Every historical file referenced by the traceability registry must be versioned so
`pnpm check` can validate an independent clean checkout. Preservation capture trees
that are not referenced are not required release inputs. Public availability does not
homologate M3 model, healing or integration capabilities.

Release packaging runs from a clean worktree of the committed release (dirty or untracked
sources are refused) after building the CLI and freezing the runner image lock:

1. `node tools/dist/distribution/licenses.js ROOT NEW_AUDIT_DIRECTORY` audits the shipped graph
   offline (staged Node production/optional/peer packages, every dpkg package and Python
   distribution in both locked images, browser revisions, ffmpeg and bundled Node) and writes a
   CycloneDX `sbom.cdx.json`, `obligations.json` and `release-notes.txt`. Flags quote retained
   copyright text; they are not a certified per-binary license selection.
2. `node tools/dist/distribution/sources.js AUDIT/obligations.json [--cache DIR] [--source-commit SHA]`
   builds the corresponding-source bundle in a resumable cache outside the repository: exact
   Ubuntu source packages (every file verified against its `.dsc`), the Playwright browser patch
   trees with exact upstream Firefox/WebKit sources and Chromium's `third_party/ffmpeg`, the
   FFmpeg/libvpx/zlib tarballs of `containers/ffmpeg/`, the Node source tarball, and a
   `git archive` of the TestMaster source commit. Output is ≤1 GiB tar parts plus
   `sources-index.json`; unresolved items stay typed residuals.
3. `node tools/dist/distribution/package.js --out NEW_DIRECTORY --sources-index INDEX` writes
   `manifest.json`, a deterministic `runtime.tar.gz`, ordered image archive parts
   (`images/<name>.tar.gz.part-0000`, each ≤1 GiB) and the source parts. It refuses image
   redistribution unless the index is bound to the identical audit and covers every source and
   notice obligation. The manifest records source commit, file hashes (including `LICENSE`,
   `NOTICE`, `containers/NOTICE` and upstream notices), image-lock hash, sources-index hash and
   full/part archive hashes. Packaging saves both locked image IDs; it does not rebuild images.
   It then runs the vulnerability gate (Trivy container pinned in `containers/scanner.lock.json`;
   CRITICAL/HIGH findings block unless covered by an owned, unexpired exception in
   `docs/security/vulnerability-exceptions.json`; the advisory database cache is
   `~/.cache/testmaster-release-scanner/trivy`) and writes `vulnerabilities.json`, pinned by the
   manifest. A failing scan leaves no `manifest.json`; see `docs/security/release-process.md`.

Playwright's own ffmpeg build recipe is not public, so both images build FFmpeg 7.0.1 from
`containers/ffmpeg/build.sh` (LGPL configuration, SHA-256 pinned tarballs, provenance at
`/ms-playwright/ffmpeg-1011/TESTMASTER_FFMPEG_BUILD.json`) and are flattened so the replaced
vendor binary is absent from every layer. Apache-2.0 does not relicense Ubuntu, browser or
library components; their notices and source obligations travel with the release.

Every release manifest is signed (detached Ed25519 over the exact manifest bytes,
`manifest.json.sig`) by a key listed in `docs/security/release-keys/keyring.json`; keys, signing,
advisories and revocation are documented in [release-process.md](security/release-process.md).
Additionally distribute the manifest SHA-256 through a separate trusted pinned channel.
Installation is
`node tools/dist/distribution/install.js --manifest PATH --keyring PATH --advisories PATH --dest NEW_DIRECTORY [--signature PATH] [--manifest-sha256 HEX]`
and refuses an unsigned or tampered manifest, an unknown or revoked signing key and a revoked
release before reading, extracting or loading anything.
The destination must not exist and is created with mode `0700`; installation rejects unsafe
tar paths, escaping symlinks, hardlinks/devices, archive/hash mismatches, missing license assets
and mismatched Docker image IDs. It executes no package lifecycle scripts. Node 24 and hardened
Docker remain host prerequisites. The installer verifies all image archives before loading either image.
Locked image IDs are the IDs reported by Docker's containerd image store (`docker info`
driver type `io.containerd.snapshotter.v1`, the default for new Docker 29 installations); the
classic store assigns other IDs to the same archive, so installation fails with `No such image`.
GitHub's `ubuntu-24.04` runner (Docker 28.0.4) uses the classic store: the generated workflow
enables `features.containerd-snapshotter` in `/etc/docker/daemon.json` and restarts Docker
before installing.

The runtime preserves monorepo-relative lookups for contract schemas/OpenAPI, both SQL migration
trees, image lock/seccomp profile, managed agent skill content and the runner harness. Source,
tests, source maps, declarations, private configuration and historical results are not shipped.
A clean extracted-runtime HTTP smoke is required separately from packaging; successful archive
creation alone is not execution evidence.

The GitHub Action is published from a dedicated distribution commit built by
`node tools/dist/distribution/action-dist.js CLEAN_SOURCE_ROOT NEW_OUTPUT_DIRECTORY` (builtin-only
module closure, licenses, hashed `source-commit` provenance; no development `node_modules`).
Workflows pin the full distribution commit SHA and the runtime manifest SHA-256; tags are
discovery labels only. `testmaster ci init github --action-ref OWNER/REPO@SHA --setup-script PATH
--runtime-repo OWNER/REPO --runtime-tag TAG --runtime-assets JSON (including `manifest.json.sig`) --runtime-manifest-sha256 HEX
--target-url URL [--workflow-file PATH] [--overwrite]` (default `.github/workflows/testmaster.yml`;
`--output` is the global format option) generates the complete workflow: a fork guard before any
download, a `contents: read` execute job (credentials not persisted, depth-2 checkout so a pull
request's assessed head stays reachable from the synthetic merge, the untracked trusted
distribution checkout and setup-written `testmaster.config.json` excluded from the assessed tree
through `info/exclude` (tracked files stay bound), containerd image store,
anonymous hash-verified downloads, runtime install, the repository's declared setup script,
strict CI, upload of only the sanitized envelope bound to run/job/SHA) and a separate
`checks: write` publisher that runs trusted pinned code in clean state and never executes PR code
or loads execution state. `--target-url` must be the credential-free loopback origin the setup
script serves from the checkout and registers as the `ci` environment base URL with network
profile `local-loopback`; any other target leaves the source unbound, so it is refused.
Runner-temp paths are exported by each job's first step because job-level `env` cannot read the
`runner` context. It reports the informational `TestMaster / result` and the required
`TestMaster / required-gate` checks; only passed, provenance-bound, complete evidence approves.
`examples/github/` is the maintained example.


## Conventions

- Code, identifiers, comments and commit messages in English; Conventional Commits.
- One logical change per commit; every commit builds and passes `pnpm build && pnpm lint && pnpm test`.
- Original TestMaster code and synthetic fixtures are Apache-2.0 (`LICENSE`, `NOTICE`, ADR-010);
  manifests keep `"private": true` only to prevent accidental registry publication.
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

Worker admission reserves aggregate CPU, memory, PIDs and scratch disk before the lease claim
in the same transaction. CPU and RAM retain 25% host headroom; browser, HTTP, Python and terminal have
independent pool slots (the terminal pool reuses the browser concurrency default). A job that cannot fit stays queued without an Attempt, and published worker
metadata includes verified image IDs and its resource budgets. `worker.run({capacity})` can narrow
operator budgets for a smaller dedicated host; repository run flags cannot expand those budgets.
Queued cancellation completes the job atomically without a container; repeated and terminal
cancellation never adds a second event or cleanup. Security enforcement absence returns a durable
blocked Run with `security_precondition_failed`, never an implicit process fallback. Admission
receipts remain in durable Run events even after the seven-day idempotency window expires.

Evidence filesystem publication keeps `.partial` until the fenced transaction publishes every
Snapshot and Artifact reference together. A renamed bundle without DB references is an orphan,
not authorized evidence; GC rechecks leases/references before deletion. Storage publication
failure does not rewrite accepted assertion outcomes: the independent evidence gate fails.
`worker reconcile --dry-run` requires admin authority and lists actions without changing state.
SQLite storage preflight rejects incompatible network/FUSE filesystems. A real preallocated
4 MiB `.control-plane.reserve` is released under disk pressure or SQLITE_FULL for recovery
metadata; it is not an artifact quota or a substitute for operator disk capacity monitoring.
Backups derive object and bundle metadata selection from the online DB snapshot. Missing or
corrupt objects stay listed in the evidence index, and `backup:last-warning` records incomplete
backups. Restore merges the current controller's secret version/revocation metadata and
retention tombstones, keeps admission suspended, invalidates tokens/leases, and still requires
operator review. Vault keys/ciphertext have separate recovery: absent keys never generate a
replacement during release. Ciphertexts carry key IDs; admin `secret rewrap` atomically re-encrypts
all objects, retaining old keys until admin `secret retire-key OLD_ID --apply` confirms no references.
Retired-key denylisting precedes physical key deletion. Interrupted rewrap is recoverable with
retained keys. `backup review` and `backup resume-run` require separate explicit admin decisions.
Fault preloads live only in `validation/journeys/crash-publication-hook.mjs`, require explicit
Node `--import` plus an acceptance gate, and are never imported by product admission; setting
the acceptance environment flags alone has no effect.

Admission records immutable source revision/hash links, configured and generation model hashes
when available, runner/browser image digests, exact build-input and seccomp hashes, policy and
seed. The manifest and published Snapshot carry that sealed provenance; unavailable source,
repository SHA, dependency lock, browser version or remote provider snapshot is explicitly
listed as a reproduction limitation rather than invented. Strict rerun without overrides
creates a new Run linked by `originalRunId`, preserving the original environment revision,
effective configuration and policy; changed image/capabilities or tampered inputs/evidence
refuse with `security_precondition_failed` and a typed incompatibility. Explicit revision or
environment overrides create a fresh admission. Retried Attempts never silently adopt a new
image lock. No model is called by deterministic rerun.

Untracked-file provenance hashes are streamed in bounded chunks without changing the existing
content hash format. A process reuses hashes only while device, inode, size, mtime and ctime
remain unchanged, and never caches files changed in the last two seconds (filesystem timestamp
race guard). On the local (SQLite) profile the identity-to-digest cache is also persisted across
processes in `<dataDir>/provenance-cache/untracked-hashes.json` (file 0600, directory 0700, atomic
temp-and-rename write, versioned with the digest algorithm, at most 100000 entries and 32 MiB;
entries for paths not seen in the latest scan are dropped). It stores repository-relative paths,
identities and digests only, never content, and it is a separate file from the database. A
missing, corrupt, oversized, foreign-version or other-repository file is ignored and rewritten,
and a write failure never fails admission, so a cold CLI process re-reads only files whose
identity changed. The server (PostgreSQL) profile keeps the in-process cache only. Files changing
during a read and non-regular untracked files are refused rather than assigned an unreliable
identity.

The working-tree diff (`collectDiffChanges` in `packages/planner/src/code/diff.ts`) hashes untracked
files with the same streaming digest (`hashConfinedCodeFile`), so an untracked file larger than the
25 MiB code-read limit is hashed rather than aborting the analysis; the read limit applies only to
files whose content is parsed. `summarizeDiffScope` (`code/scope.ts`) limits a diff analysis to the
changed files plus their reverse relative-import closure: `git grep` over-approximates importers
(untracked files included for a working tree, the pinned head's blobs otherwise), then the AST
confirms them. The pinned head is staged from git objects into
`<dataDir>/discovery-snapshots/` (candidate blobs and ancestor `.gitignore` blobs only, removed
afterwards). A failing `git grep` aborts with `PRECONDITION_FAILED` (`details.step =
importer_closure`); aliased (tsconfig/bundler) imports are not followed and are declared as a gap.
Codebase mode caps symbols (200/file, 20000/run) and keeps relative imports only, so the discovery
state stays below `MAX_STATE_BYTES`; `PAYLOAD_TOO_LARGE` from `saveAiState` carries
`details.key/bytes/limitBytes`. Component exports are summary features, not feature-map entities,
and Next route handlers become `endpoint:METHOD:/path` features. Route handlers exported through a
destructuring declaration (`export const { GET, POST } = createFromSource(source)`) are resolved by
the names the pattern binds (`{ handler: GET }` binds `GET`; `{ GET: handler }` binds `handler`, which
is no method; rest elements are ignored). A comparison of a request path with a literal starting
with `/` becomes a `node-http` route: `path|pathname|route`, any `<object>.pathname`
(`url.pathname`, `new URL(req.url).pathname`) or any `<object>.url` (`req.url`), in either operand
order; a `.url` comparison with a literal containing `?` is ignored (it carries a query string). Only
a file that imports `http`/`https`/`http2` (or the `node:` forms) and calls `createServer` counts,
never under `app/` or `pages/`, in `.tsx`/`.jsx`, or in a test file (`*.test.*`, `*.spec.*`, or
under `__tests__/`, `test/`, `tests/`: a stub server there is a fixture, not an application route).
The method is the `method === "GET"` / `req.method === "GET"` comparison in the same `&&` chain,
else `UNKNOWN`. Bumping `CODE_DETECTOR_VERSION` (now 1.6.0) stops old discovery jobs from resuming.
A file is skipped as `binary` only when its bytes are not valid UTF-8 or more than a tenth of them
are NUL (UTF-16 text, zero-filled data); a literal NUL inside a source string, even near the start
of the file, does not exclude it.

Python is read by `python/testmaster_runner/code_summary.py` (AST only, in the pinned Python image;
`PythonCodeSummary` version 1.1.0) and composed in `packages/planner/src/code/python-routes.ts`. A
FastAPI route is reported under its full path: `<parent prefix><include prefix><router prefix><decorator path>`
along every chain that reaches it. The chain links are `APIRouter(prefix=...)`,
`parent.include_router(child, prefix=...)`, `parent.mount(path, child_app)`, and routers handed to
another function (`register_routes(router, ...)` where the parameter is annotated `APIRouter`, which
makes a decorator on that parameter an endpoint of the caller's router). The child of an include is a
router name, a call to a factory that `return`s a router (`include_router(create_x_router(...))`), or
a dotted name; names are followed across modules through static imports (absolute, relative,
`import a.b as m`, and re-exports in a package `__init__.py`) when the module is among the analyzed
files, matching module names by their path suffix so a `src/` root works. A prefix may be a string
literal or a name bound to one in the same file. A router mounted more than once yields one endpoint
per distinct full path. Scope is respected: two factories that each build a local `router` stay
separate. When a prefix is not resolvable (a call, an attribute, a name from another module, a
conditionally reassigned name) the endpoint is kept with the path it declares plus the router's own
literal prefix, never a guessed one, and the file gets a `fastapi_prefix_unresolved` warning; a
router that no analyzed file includes (for example because a diff scan did not read the file that
mounts it) is kept with its own prefix and gets `fastapi_router_unmounted`. Flask blueprints,
routers imported into another module that decorates them, and `app.add_api_route` are not composed.

The project data directory (`<repo>/.testmaster/` by default, or `TESTMASTER_DATA_DIR`) is never
listed or opened by repository provenance or by the working-tree diff, whether or not Git ignores
it. The process that scans holds the SQLite database open, and POSIX `fcntl` locks are per
process and released when any descriptor of the file closes, so even a read-only hash would let a
concurrent CLI writer delete the live `-wal`/`-shm` and corrupt the server's view. Excluding it
also keeps `dirtyHash` stable across runs, which write their own evidence there. A data directory
outside the repository is unaffected; `testmaster init` still does not edit `.gitignore`.

A dirty or diff impact analysis never counts TestMaster's own artifacts (`testmaster.config.json`
and any `.testmaster/` directory) as changes. A change widens the impact to every analyzable file
(`criticalSmoke`) only when it touches authentication or shared code AND the changed path is code
or a schema-like source (`.sql`, `.prisma`, `.graphql`, `.proto`), outside hidden tool directories
(`.reversa/`, `.atl/`) and not excluded by the default or configured scan rules; untracked tool
caches and binaries are listed in `changes` but never widen and never appear in `selectedFiles`.
"Shared" is judged on path segments, not substrings: a directory named `schema(s)`, `migration(s)`,
`shared` or `database`, or a file whose stem ends in one of those words (`schema.ts`,
`user.schema.ts`, `prisma/schema.prisma`); `schema-summary.json` and `schemaless.ts` do not match.

Reports reopening verified bundles declare `evidence-replay`; manifests distinguish
`strict-execution-replay` from fresh agent-mode `fresh-llm-regeneration`. External target/data
changes, platform-dependent rendering and unavailable remote model snapshots preclude bitwise
determinism claims even when the pinned execution succeeds.

Reports publish five independent coverage metrics (`requirement`, `route`, `operation`, `code`,
`execution`) plus spec-10 named execution rates. Each ratio carries numerator, denominator,
known/unknown state, scope and definition; an absent inventory is `insufficientData`, an explicit
empty denominator is `notApplicable`, and neither renders as a percentage. Requirement coverage
is scenario mapping, not independent verification; OpenAPI coverage requires passing status and
schema assertions for the declared method/path/status/media pair. Partial route exploration and
uninstrumented code retain unknown denominators. Duplicate selections and extra dependency Runs
are reported separately and never inflate the frozen requested denominator.

Runtime boundaries are persisted as fenced `attempt.timing` events, using Linux boot-bound
monotonic clock readings and separate UTC timestamps. Reports never subtract UTC timestamps.
Queue, preparation, execution, collection, analysis and end-to-end durations remain separate;
unrequested analysis and unavailable/reboot-crossing timing are null, not zero. `durationMs` and
JUnit time refer only to measured execution, not preparation or optional model analysis.

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
raw trace/video export requires explicit `--raw` and separate `artifacts:raw` authorization;
authenticated sessions need a scoped raw grant (viewer and explicit deny always reject).
Run admission also checks the raw grant before enabling trace/video or full HTTP body capture;
production capture needs a current matching `artifacts:raw` approval before any browser starts.
The implicit local owner may request raw explicitly. Production export additionally requires
`--approval ID` bound to `artifacts:raw`, the actor, exact revision/environment, origins and
current policy. MCP pages never expose raw bytes. Reports derive from the same committed snapshot.
Backup restore writes an isolated directory, suspends admission and requires operator review.

Browser downloads accept authorized HTTP origins and same-origin blob URLs, never opaque
blobs. The real-browser acceptance matrix exercises iframe child assertions, popup aliases,
upload/download byte roundtrips, waits, ambiguous hooks, console/network channels and opt-in
trace/video. Context cookies and profiles are never reused across attempts or target environments.
HTTP 500 responses preserve target evidence and fail the configured oracle; a broken upstream
transport remains inconclusive rather than receiving a synthetic gateway status. A rejected
static credential is `manual_auth_required` unless HTTP 401 itself satisfies the explicit oracle.

Request/response bodies stay in runner memory for assertions and declared captures, but are
not persisted by default. HTTP traces retain body SHA-256/byte size/content type, status,
monotonic duration and headers limited to content-type/content-length/cache-control/etag/
last-modified/retry-after. JSON errors retain only redacted error/message/code fields bounded
to a 512-character failure excerpt. Browser network logs do not store request/response bodies.
Explicit `artifacts.httpBodies: "on"` (or `TESTMASTER_HTTP_BODIES=on`) writes separate
`restrictedRaw.http` evidence, requiring the same scoped raw permission and production approval
as trace/video. The sanitized metadata trace remains useful without that opt-in.

Required producer dependencies are expanded into separate pinned Runs; requested and expanded
denominators remain separate. Consumers wait for a successful producer gate, exact revision,
environment, typed capture and freshness before any target effects. Public capture values stay
in accepted observations; sensitive captures cross only the trusted runner protocol and are
encrypted by the supervisor into secret references before persistence. They are stored only in
TestMaster's own encrypted vault, never in the host keyring. A worker pass erases the stored value
and revokes the reference once the producing Run and every member of its batch have completed,
unless a resource the Run created is not yet `cleaned`: that fixture is still live, so its
outputs can be reused by a later batch and its `handle` capture feeds manual compensation, and
the erasure follows the cleanup. A failed erasure keeps the reference live and the next
maintenance pass retries. Runtime sockets use a
short private per-user runtime root to remain inside the Unix socket pathname limit.

Worker maintenance expires only eligible completed evidence through versioned
mark/tombstone/delete, leaving sealed metadata and historical verdicts immutable. Trusted DB
tombstones produce an expired/partial evidence view. `operational_state` keys
`retention:artifact:<workspaceId>:<artifactId>` record GC stages; legal holds use
`retention:legal-hold:<workspaceId>[:<runId>|:<artifactId>]` (any value except `released` holds).
Storage use at 80% warns; at 90% new admission suspends. Only the pressure-owned
`suspended_storage` state is automatically recovered; restore/manual suspensions are not.
SEC-025 requires ephemeral browser profiles and containers to be torn down cleanly on Attempt exit.
If container teardown or browser-profile removal fails, the business verdict of the Run is preserved,
the run gate and cleanup outcome evaluate to `failed`, and the worker/runner-slot enters persistent
quarantine recorded in `operational_state` (`worker:quarantine:<workspaceId>`) along with an active
incident (`incident:<incidentId>`) and outbox records (`worker.quarantined`, `incident.created`).
A quarantined worker refuses to claim or dispatch any queued execution across process restarts until
an authorized operator explicitly runs `testmaster worker clear-quarantine` (with `A` permission).
The clear operation audits the action (`worker.quarantine.clear`), verifies that leftover containers
or profiles are removed (or safely removes them), and refuses unsafe clear while leftovers remain.


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
M2 source/discovery/requirement/proposal/usage commands share application services. `source add`
accepts OpenAPI 3.0, 3.1, 3.2 and Swagger 2.0; a 3.2 document is validated as the 3.1 model (the
validator knows no 3.2 schema) after its 3.2-only fields (`$self`, `itemSchema`, `summary`, `kind`, ...) are
lifted out, `query` and `additionalOperations` operations are validated and inventoried, and a 3.2 keyword
the 3.1 schema does not know is a warning diagnostic, never an invalid document. A source whose revision
ends `invalid` exits non-zero (exit 5, `INVALID_ARGUMENT`, diagnostics in `details` and on stderr).
`discover` prints a bounded receipt (shared with MCP `testmaster_analyze_code`); `--full` prints the stored
discovery. The global `--dry-run` reports `validated: true` only after the command's own validation ran,
and `--example` prints a command's input contract with a sample file before commander checks required
options. Declare
OpenAI-compatible `modelProviders` only in the selected user profile and list their IDs in the
operator policy's `allowedModelProviders`; that allowlist is the only provider gate. There is no
consent, grant or revoke step per project, provider or data class: a provider outside the allowlist
never receives a byte (`POLICY_DENIED`), credentials, secrets, environment values, private keys,
storage state and raw traces are never sent whatever the request declares, and the request's
`dataPolicy.dataClasses` is descriptive metadata that enters the cache key and audit only. Repo
content cannot configure providers or tools. Prices remain `unknown`, never zero, unless the
profile declares a price table (`prices.<model>`: `currency`, `scale`, integer
`inputPerMillion`/`outputPerMillion`, optional `cacheReadPerMillion` applied only to
provider-reported cached input, and `version` naming its source). An unpriced model runs and its cost
stays `unknown`, except under a monetary project ceiling: the reservation is then unknown, so the call
is refused before the request is sent with `QUOTA_EXCEEDED` and `reasonCode: "budget_exhausted"`;
the token ceiling keeps applying to unpriced models. No token or monetary
ceiling exists by default. `budget set --tokens N` (or authenticated `POST /v1/projects/{id}/budget`
with `{ "tokens": N }` and an Idempotency-Key) opts into an independent cumulative project
input+output quota; until then `tokenBudget.limit` is null. Reservations atomically charge
conservative prompt bytes plus maximum output, then reconcile measured tokens. Two concurrent
model compute slots per project bound even unpriced/local requests; settlement/release frees
a slot. Lost usage retains its conservative token charge. `usage` reports tokenBudget, model wall runtimeMs, and
recorded evidence storageBytes with per-Run attribution; lowering quotas never cancels
already admitted deterministic replay or deletes evidence. Normalization extracts bounded
chunk batches with prior grounded statements and exact deduplication, followed by a bounded
conflicts-only reconciliation that retains all requirements and exact source references.
Models never copy evidence objects: each request labels supplied chunks or requirement evidence
with opaque handles (`E1`, `E2`, …) and outputs cite only `evidenceIds`. The application resolves
handles to the exact supplied `EvidenceRef`s before persistence; an unknown handle rejects the
whole output. Copied refs gained fabricated locator fields (artifact/snapshot/page/pointer) in a
replay of Round 4 trial-02, matching the grounding rejections of all Round 4 normalizations.
The configured model output ceiling is respected. A length finish records `output_truncated`
and stops without blind repair calls; schema-invalid completed responses retain bounded repairs.

Sources retain immutable bytes/hash/parser revisions and expose `invalid` or `needs_input`
instead of empty successful input. Discovery uses AST-only summaries, confines its repo root,
requires explicit diff base/head (or base plus working tree), and resumes only the same complete
input fingerprint. Deterministic discovery is labelled partial until observed exploration grounds it.
Git analysis is read-only and bounded to 30 seconds per command. It drops credentials and
Git environment overrides, disables hooks/fsmonitor/helpers/external diff and all transport
protocols, ignores submodule internals, and never checks out or initializes imported code.
The hostile-repository CLI acceptance checks marker files, unchanged Git configuration/remotes,
excluded credentials and zero network connections. Fork workflow text remains data; GitHub App
tokens and immutable check-SHA publication are unavailable until M4.

Network privacy acceptance uses Linux `strace` (required on the test host) to observe connection
addresses from the whole CLI process tree, plus Node fetch/undici/net/tls/dns diagnostics and
sealed container egress logs. It records no socket payloads or request headers. The Docker
journey runs init/doctor/lint/create/replay/rerun/evidence/report with default privacy settings
and no model key; a separate live-model journey exercises the same recorder positively through
real normalization, proposal generation and code export. Observations are retained under
`validation/results/network-*.json`; these checks do not claim M4 web or GitHub integration.

Requirements preserve conflicting source refs; reviewers adjudicate conflicts and explicitly approve
selected requirements, or reject out-of-scope ones with a mandatory reason (`requirement reject`,
MCP `reject`, REST `POST /requirements/{id}/reject`; audited as `requirement.rejected`, stored in the
`testmaster:rejection` extension). A rejection is final: the requirement is not pending, is never
planned and can be neither approved nor edited, so a statement is proposed anew only by normalizing the
sources again. It raises the snapshot version but keeps its fingerprint, so approved snapshots and
proposal batches stay valid; a proposal citing the rejected requirement is refused when accepted.
A conflict decision keeps the selected requirement and supersedes the conflict's other requirements:
they are not pending, are skipped by planning without an explicit selection, and approving or planning
one is refused with `requirement_superseded`. Until its conflict is decided a requirement can be neither
approved nor planned (`requirement_conflict_unresolved`, naming the conflict).
Generated executable proposals need typed nontrivial assertions and grounded
refs, and must match the requested `--type` (`backend` → `http`, `frontend` → `playwright`;
absent means `backend`). `--type auto` (MCP `type: "auto"`, REST `scope: ["frontend","backend"]`)
lets the model choose per requirement but still requires one of those two pairs; `--type integration`
requests `integration` plans. Any other plan rejects the batch. The evaluator generates
with `auto` so UI-only requirements are not forced into invented HTTP endpoints, as observed in
Round 6. Generation sees each requirement's evidence locators (path,
JSON pointer) next to its handle but cites only handles.
`plan accept --only ... --expected-version N --idempotency-key KEY` atomically creates only
selected generated revisions and preserves retained proposals. Edits are CAS and return a diff on
conflict. J02/J03 live journeys record their exercised evidence in `validation/results/`.
M3–M6 groups report their milestone rather than returning successful placeholders.

M3 diagnosis is separate from terminal execution: `run analyze RUN` retains an immutable
factual predecessor; `run analyze RUN --model` requests optional enrichment, which has no deadline.
An unavailable capture, an unavailable or cancelled model, or a rejected enrichment returns a partial diagnosis and cannot
rewrite the Run outcome, gate, Attempts, or artifacts. Identical requests reuse their retained
receipt rather than issuing another model call; unknown usage keeps its conservative charge.
`--provider ID --model-id ID` (REST `provider`, `modelId`) choose the model of the reading and
require `--model`; the choice is validated before any job or reservation exists and never falls
back to another model. The MCP tool spells the same choice `model` (`true`, or a model id) and
`provider`, like the other model tools. A reading that abstains is stored as a `source: "rules"`
analysis without a `modelCallId` (the database admits a parent only for `source: "model"`, so it
has none) plus the limitation; only a real model call produces `source: "model"`. The outcome is
structured in the model job's receipt (`modelStatus`: `used`, `abstained` or `unavailable` with a
`reasonCode`, e.g. `model_not_in_inventory`; a missing provider API key is `unavailable` with
`provider_credentials_unavailable`), and `testmaster_analyze_run` returns it as `modelStatus` and
in its text content, so an agent never mistakes a rules-only analysis for a model reading. The CLI
(`run analyze --model`) returns the same `modelStatus` in `data`, prints a `Model reading:` line
and warns on stderr when the model was not used. A reading refused before anything was sent (the
`unsentModelReasons` of `ai/model.ts`: a missing API key, a model that is not declared, configured,
capable or in the provider inventory) is not final: the job is settled unpaid, and the next request
for the same reading reopens it (`reopenUnpaid`, the earlier receipt kept in
`progress.unpaidSettlements`) and evaluates again, so fixing the configuration is enough. A reading
that abstained after a model call stays stored. A later enrichment with another model, or a reopened
one, starts from the factual analysis, not from the abstention.
Evidence redaction scrubs only the values of credential-named environment variables with at least
8 characters (`environmentSecretValues`), so flags such as `INSPECTOR_MASK_SECRETS=true` are never
treated as secrets; structured evidence and the exported config are scrubbed structurally
(`scrubEvidenceValue`), never by re-parsing scrubbed JSON text. An HTTP evidence file
`http/<stepId>.json` carries `redirects` (the hops followed, in order). A failed `statusIn` that
expects the redirect the runner followed (first hop in the expected statuses, or every expected
status 3xx) is a test defect (`test_fragility`, `fix_test`: set `redirect: "manual"` on the
request), not a product mismatch. The failure is localized to the first failed step, else the
first inconclusive or blocked step; without either the conclusion says it could not be localized.
The model catalog carries bounded sanitized frozen predicates and expected/observed structures,
scoped verified evidence hashes, contrary passed steps, and verified locator observations.
Artifact availability is one fact per artifact kind ("Verified N log artifacts available.") citing
every artifact of that kind. For a non-passed step the locator catalog also lists visible unnamed
`input`/`select`/`textarea` candidates, so a label locator that matched nothing still shows the
controls the page offered.
Status/timeout alone does not prove a product cause; absent JSON is not an approved schema violation.
`run analyze RUN --model --discovery DISCOVERY` (REST analysis body `discoveryId`) additionally
requires the same workspace/project, repository, assessed commit and
dirty identity frozen at Run admission. Only manifest-verified summary paths/symbols are offered;
no working-tree source bytes or private absolute paths are transmitted. `fixTarget` binds the exact
CodeSnapshot/path/hash as a proposed inspection location, not source causality or edit permission.
Unbound Runs disclose the missing source binding. The controlled-provider OPS-014 Docker journey
tests an unavailable model/idempotency/accounting and positive/negative source bindings; it is deterministic
acceptance, not evidence of live-model diagnostic quality.

M3 healing is an explicit separate workflow: `heal propose RUN [--provider ID] [--model ID]`,
`heal get PROPOSAL`, `heal approve PROPOSAL --expected-version N [--wait]`, and
`heal reject PROPOSAL --reason TEXT`. Proposals require a terminal failed declarative Run,
an allowed structured-output provider. Without `--provider`/`--model`
(`provider`/`model` in the API body and MCP input) the first allowed provider's first
structured-output model is used; an explicit choice must be configured, allowed by the profile and
structured-output capable, is validated before any job exists and is never replaced by another
model. With `--model` alone, lookup is confined to the first allowed provider; use both flags
when the model belongs to another provider. A model failure reports `provider`, `model`,
`upstreamCode`, `upstreamStatus` and
`modelCallRecorded` (whether the gateway recorded a call row; a transport failure after sending
may leave none, so it does not prove nothing was sent). Each failed Run gets exactly one paid
healing request: once a paid call started (success, failure, abstention or unknown outcome) it
stays final (`no_regeneration`), and the next eligible failed Run is the place to pass another
`--provider`/`--model`. A request that failed or was refused before any model call (evidence
phase, `provider_unavailable`, `evidence_unavailable`, `evidence_too_large`, `semantic_failure`,
`evidence_invalid`, or a model refusal raised before anything is sent, the `unsentModelReasons` of
`ai/model.ts` such as `provider_credentials_unavailable`) is not final: the next `propose` reopens
the same job (the earlier refusal is
kept in `progress.unpaidSettlements`) and evaluates again. A leased request answers
`already_running`. Diagnosed product, contract or security failures abstain before model
execution (`semantic_failure`, the same normal result with `modelCallId: null`). Before any job,
reservation or model call, a Run whose analysis (the stored one, or the rules analysis `propose`
computes when none exists) says `healing.advice: "not_indicated"` is refused with
`PRECONDITION_FAILED`, `details.reasonCode: "healing_not_indicated"`, `analysisReason` and
`nextStep`; the healing request is not spent, so a later `propose` after a new analysis can still
run, and there is no force option. `test run --heal propose` reports that refusal under
`healing.refused` next to the finished Run instead of failing the command. The healing prompt carries the
sanitized plan, factual statements cited by `E` handles, locator evidence only for steps that
did not pass (candidate lists bounded with their original count and truncation flag) and, per
step, the exact `allowedReplacements` derived from the same contract `applyHealingPatch` admits:
`/input/locator` (locator actions/frame), `/input/trigger/input/locator` (download),
`/input/source` and `/input/destination` (drag, manual-only), `/input/state` (locator wait), and
manual-only business inputs (`/input/value`, `/input/values`, `/input/path`, `/input/pathSegments`,
`/input/query`, `/input/headers`, `/input/body`). Only present fields are offered; whole-plan
pointers, locator leaves, added optional fields, assertions and predicates are refused. Evidence
that cannot fit 80000 bytes after scrubbing is refused (`evidence_too_large`) before dispatch.
The model answers `AIHealingOutput`: `{kind:"patch", patch}` or `{kind:"abstain", reason,
evidenceHandles}`; handles are resolved in both branches. An abstention completes the auxiliary
job with `model_abstained`, creates no candidate, proposal or verification, is not regenerated
and is a normal result, not an error: `propose` returns `HealingAbstention` (`abstained: true`,
`failedRunId`, `reasonCode`, `reason`, `jobId`, `modelCallId`, `nextAction`; `reason` and
`nextAction` are code-owned and the model's own text stays audit-only in the job). The CLI prints
it and exits 0, MCP `testmaster_propose_healing` answers it without `isError`, and asking again
returns the same abstention. Invalid model output is
`PRECONDITION_FAILED` `model_failure` with a code-owned `detail`; model text is never persisted
as a diagnostic. Evidence content hashes stay local. A model diagnosis enrichment rejected by local validation
keeps the factual diagnosis and records `Model enrichment abstained: <code>: <rule>.` as a
limitation. Replacement patches cannot alter
assertions (including nested frames), response predicates, dependencies, cleanup or time ceilings.
Business-input changes require manual review; generic write permission does not grant approval.
Approval admits a distinct strict replay verification. Only its passed outcome AND passed gate,
plus an unchanged active base revision, promote the candidate. Original failures and evidence
remain immutable; failed verification remains reviewable and never starts a healing loop.
Approving (manual or policy) records `healing.approved` and rejecting records `healing.rejected` in the
audit trail, in the same transaction as the state change: actor, proposal id and before/after hashes
only, never the rejection reason (it stays on the proposal's limitations).
In local mode `heal approve` follows the run admission ownership: when a worker heartbeat is fresh
(under 30 s) the verification run is `worker`-owned and is returned queued unless `--wait` is given;
when no worker is live the run is `ephemeral` and the command executes it in-process before
returning (with or without `--wait`), prints the reconciled proposal and the verification run, and
exits with the run outcome. It never leaves an ephemeral verification run queued without an executor.
MCP `testmaster_approve_healing` does the same: it returns the approved proposal at once and the
server process executes an `ephemeral` verification run in the background (`close` waits for it), so
`testmaster_get_run` with `wait` sees it finish and the proposal is settled without a worker.
`heal review` lists, per identity change, only elements a healed locator can target: document and
metadata elements (`html`, `head`, `meta`, `script`, `style`, `link`, `title`, `noscript`,
`template`, `base`) are not recorded by the browser runner (a matched one always is) nor listed, the
list is capped at 50 (matched and identified elements first, DOM order kept) and
`omittedCandidates` counts the recorded elements not listed. Candidates keep role, accessible name,
tag, type, `label` (aria-label, or the accessible name of a form control), `form`, `placeholder` and
`testId` (`data-testid`).
Automatic policy application additionally requires project extension
`testmaster:healingPolicy: "apply"`, configured and frozen Run healing mode `apply`, matching
policy hash, a non-production environment and uniquely proven locator/wait equivalence against
a passing baseline. It records policy approval without a human reviewer. Missing evidence keeps
the proposal manual. `test run --heal propose --wait` proposes only after observed failure;
`CI=true` denies healing and retries. Controlled-provider journey results test these invariants,
not live-model repair quality.

An unambiguous locator state wait that exceeds its approved deadline on a live page is
`failed/assertion_timeout`; a crashed page or detached frame remains an evidence failure.
Browser value predicates (`textEquals`, `textContains`, `valueEquals`, `enabled`) poll the
bound element until the step deadline and fail with the last observation, so an eventually
rendered value passes while a stale one fails. An HTTP assertion whose JSON Pointer target is
absent from a complete, valid response fails as `assertion_mismatch`; captures still treat an
absent target as insufficient evidence. When the target connection fails or resets, the egress
proxy answers opted-in HTTP runners with `502` plus `x-testmaster-upstream-failure: <socket code>`
(stripped from real target responses). The step is the same transport loss as a direct socket
failure: `inconclusive` with that error code, `insufficient_evidence` for reads and
`retry_unsafe_external_effect` once a mutating owned-resource request was sent.
Browser and HTTP assertions retain bounded observed/expected comparisons for rules-first
diagnosis only when neither value is secret-derived or altered by redaction; oversized pairs
are omitted, not truncated into misleading evidence. The paired Docker controls in
`validation/journeys/m3-healing-acceptance.docker.test.ts` cover price/permission defects,
policy-safe selector application versus a wrong button, and observed wait-state equivalence
within the unchanged ceiling. They are deterministic controlled-provider safety acceptance,
not live-model quality evidence.

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
at `/v1/openapi.json`, generated by `node packages/contracts/dist/generate.js` from the route
catalog: each route declares its response kind (`item`, `page` for `{items, hasMore, nextCursor}`,
`items` for an unpaged `{items}`, `empty`, `stream`, `binary`, `text`), item schema, success status
and any further status with the same body (`206`, `503`). The server takes each route's success
status from that declaration, and `apps/server/src/response-contract.test.ts` validates real
responses against the generated schemas. Routes without a handler (M5/M6) are marked unavailable
and return `CAPABILITY_UNAVAILABLE` with their milestone. Manual
resource compensation is available through `resource get` (approval binding), `approval create --reason TEXT`,
and `resource cleanup --approval ID --expected-version N --idempotency-key KEY`. It replays only
the recorded compensation inside a fresh hardened sandbox with the original environment policy,
protected handle, ownership proof and a consumed resource-bound approval. Failed or uncertain
compensation preserves the owning Run's original verdict and records a separate cleanup event.

Execution approvals (`approval create`, MCP `testmaster_approve_execution`) are created by the authenticated
caller whatever its principal kind (human, token, service or agent) with write scope; the reviewer is the
authenticated principal and must be enabled. An `approval_required` refusal carries `details.binding`
(`revisionHash`, `environmentRevisionId`, `originSet`, `actionSet`, `policyHash`, `actorId`) so the caller can
copy it into the approval. The binding, the 30-minute maximum expiry and single use are unchanged. The opt-in
project policy (`approval policy set`, `requiredApprovers` 1 or 2, `separationOfDuties`, default off) is also
unchanged: with separation of duties the requester cannot approve its own execution
(`reason: separation_of_duties`), and two approvers need two distinct reviewers.

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
  bundles. `failedOnly` selects the evidence of non-passed steps; when none of them holds evidence
  (an assertion that read a response) it falls back to the response step it read, then to the
  nearest preceding step with evidence, then to the attempt's `log`/`network`/`console` entries. It
  only selects entries the manifest already holds and a passed run keeps its empty subset.
  `reports.snapshot/export` produce JSON, Markdown, HTML, JUnit or Allure.
  `backups.create/restore` require admin scope; restore never executes restored jobs.
- Every `run.completed` outbox event (and so every `runs.events` payload) is the Run document plus
  the Run's final `reasonCode`: admission refusals publish theirs directly, and the worker passes
  the final reason to `ExecutionRepository.finalize(fence, run, reasonCode)` (the reduced reason, or
  `upstream_failed`, `execution_deadline`, or the registered execution-error reason). The Run
  document itself still has no reason field. Alerts (`egress_denied`), telemetry
  (`run_platform_success`), notifications, the CLI/MCP exit-code lookup and the rules analysis read
  this field; seeding a test Run without it hides the worker path, so drive the worker (see
  `egress-alert.test.ts`) when a rule depends on the reason. The exit code follows the reason
  registry: a Run blocked by `manual_auth_required` or `missing_secret` exits 6; a Run blocked by
  a policy refusal exits 15 (exit 9 is a refusal to act: `POLICY_DENIED` or `doctor` FAIL).
- `reduceOutcome` (packages/domain/src/run.ts) maps a policy refusal to `blocked` even after steps
  started: any reason whose registry effect is `blocked` (`egress_denied`,
  `security_precondition_failed`, `approval_required`) on the last Attempt, with no proven assertion
  failure and no complete pass, keeps its `reasonCode` and exits 15. Other reasons after start
  (`attempt_timeout`, `worker_lost`, ...) stay `inconclusive`; `canRetry` never retries a refusal.
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
  `--feature ID...` observes each expected feature's admitted route independently; unauthenticated
  login barriers remain `unreachable` with `login_required`. `ready` means the operator-declared
  `testmaster:completionText` was observed (the feature-state extension labels it `full`); absent
  completion evidence remains `partial`, never complete coverage by route visitation alone.
  An observed route that no `--feature` named is a Feature keyed by its path, unique per project:
  exploring the same URL again reuses that Feature (its observed title is refreshed under the
  Feature's optimistic version) instead of inserting a duplicate. A rejected observation or a
  failed Feature write is recorded in the job itself (`testmaster:resolutionFailures`, and
  `testmaster:errorMessage` when the job aborts), not only in the sandbox protocol log. A job that
  ends non-passing without aborting (`failed`/`inconclusive`) also carries `testmaster:errorMessage`:
  the first failed action resolution (a model that could not be used, e.g. a declared model absent
  from the provider inventory), else a first page that offered nothing to explore (below), else the
  first failed navigation recorded in the browser network log (`browser/network.json`, already
  scrubbed by the runtime), else the outcome and reason code.
  `--provider ID`/`--model ID` (MCP `provider`/`model`) choose the action-resolution model and are
  validated before the job exists, without fallback to another model.
  The browser observation the model and the Feature state are built from is read after a bounded
  settle wait (two reads at least 500 ms apart that agree, within the step deadline and 5 s;
  otherwise `settled: false`), so a single-page app is not observed half-rendered. It carries
  `controls` (tag, type, role, name, placeholder, test id, visibility of each input, select,
  textarea and button; never a value, checked state or typed text) and `hasPasswordField` (a
  password input is detected, never read), and its text includes form labels and links; only
  `[data-sensitive]` subtrees and field contents stay out. An approved `mutationActions` entry is
  offered when its locator equals a control's `testId`, `aria-label`, button text, placeholder or
  role+name locator (`exact: true`, key order `by,value|role,name,exact`). A password field on a
  Feature that is not itself a login route makes it `unreachable` with `login_required` (DISC-001).
  When an open exploration (no `--feature`) first observes a page with no same-origin link and no
  approved action, the run is `inconclusive` (`insufficient_evidence`), the job `failed`, and no
  model is called; its `testmaster:errorMessage` reads, for example, "Exploration observed no
  same-origin link at <url>: 2 form controls, password field present, 0 approved actions." A
  feature-seeded exploration treats the seeded page as the target and follows only the unvisited
  links that belong to the selected features (a link to one of their routes or to a page nested
  under one; a link elsewhere would attribute another page's content to the feature). Form
  actions (click, fill, press, select, check, uncheck) are never offered on their own: only an
  approved `mutationActions` entry matching an observed control is. The allowlist is MCP
  `testmaster_explore` `mutationActions` or `testmaster explore --mutation-actions FILE` (a JSON
  array, max 20, of typed steps with a locator); a malformed step is `INVALID_ARGUMENT`, a
  non-form step or a production environment `POLICY_DENIED`, both before the job exists. With
  neither a feature link nor an approved match the
  controller has nothing to choose, so no model call is made (`usage.modelCalls` counts the
  calls made, never an attempt over the budget): the job stays the runner's outcome but reports
  `testmaster:reasonCode: no_grounded_actions` (the runner's code moves to
  `testmaster:runReasonCode`), `testmaster:reasonDetail`, and the feature state reason
  `no_grounded_actions`. A feature that stays `partial` after calls reports
  `completion_text_not_observed` or `no_completion_text` instead of a null reason. Stopping after at
  least one observation because no unvisited link
  remains is legitimate and also costs no model call. The closing `observed` (body visible) step
  stays because a plan needs one required assertion, but it only confirms the page is still
  rendered: a run that observed nothing to act on is ended by the runner before it and never
  reaches it. Runner changes need `node containers/build.mjs --only testmaster-runner`.
  `--job ID --retry-feature ID...` creates a new job/cost ledger for only eligible selected features,
  preserving all unselected results and the original job. `--video` is explicit restricted-raw opt-in,
  requires raw/admin permission, and is refused for production exploration. Default exploration has
  no video. Updating a source or discovery fingerprint clears descendant requirement approvals and
  makes retained proposal batches stale, without rewriting immutable revisions or pinned Runs.
  Code-role source inference cannot acquire explicit authority from model output; conflicting
  implementation versus desired PRD remains subject to reviewer adjudication. An inferred
  requirement the model did not link to a conflict gets a single-member reconciliation conflict
  carrying the desired-contract evidence: only the inference is blocked until adjudicated, so one
  inference cannot block or supersede the desired requirements (Round 6 trial-08 approved 0/36).
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
  translation is refused. An imported or generated Playwright export also ships
  `testmaster-fixtures/`, a local package installed as `@playwright/test` that re-exports the pinned
  stock package (installed as the alias `playwright-test-stock`) and adds the runner's `secrets`,
  `profileRequest`, `profilePage` and `sourceSchemas` fixtures, so the authored import runs unchanged with
  `npm ci && npx playwright install chromium && BASE_URL=... npm test`. `secrets.get("NAME")` reads
  `SECRET_NAME`; the auth profile session comes from `TESTMASTER_PROFILE_STORAGE_STATE` (a Playwright
  storage-state file) and `TESTMASTER_PROFILE_HEADERS` (a JSON object of header credentials), is
  sent to the `BASE_URL` origin only and never along a redirect; `export-metadata.json` lists the
  variables in `environment`. Export-side secrets use `SECRET_<name>`, not secret ids.
  `sourceSchemas.violations(sourceRevisionId, pointer, value)` returns the violations of a value
  against a source schema frozen into the revision (`ImportedCodeBundle.schemas`, keyed by revision
  id plus pointer), judged by the runner's source-schema Ajv rules (`SOURCE_SCHEMA_RULES`,
  contracts `validation.ts`: same options, OpenAPI formats and annotation stripping as the plan's
  `jsonSchema` predicate). An export of code that uses it also ships
  `testmaster-fixtures/schemas.json` and pins `ajv`/`ajv-formats` (same versions as contracts, with
  lock entries) in the fixtures package; without schemas the export is unchanged. pytest imports
  have no runner fixtures.
  Standalone projects do not implement supervisor grants/approval/egress/redaction: use an
  authorized target and external isolation. `validation/journeys/export-standalone.docker.test.ts`
  invokes the real CLI export, then directly runs `npx --no-install playwright test` or
  `python -m pytest` inside the pinned upstream Playwright base images. Only third-party
  dependencies are pre-staged from the immutable runner images; their versions match the
  exported locks. No TestMaster package, reporter, AttemptExecutor, model credentials, or
  registry installation is present on this execution path. A dedicated internal Docker
  network connects only the hardened test container and reference shop. Healthy and
  semantic-mutant outcomes are recorded in `validation/results/m2-export-standalone.json`.
  `integration-workflow.docker.test.ts` exercises create/read/update/query through the
  real CLI HTTP runner. Request traces include captured-variable bindings and typed
  capture origins; sensitive resolved values are explicitly redacted. Independent SQLite
  and raw HTTP checks prove persistence, and an ignored-update mutant fails `update_value`.

### Surface contract validation

`contract validate --schema ExecutablePlan|ProjectConfig|RunRequest --document FILE`,
`POST /v1/contracts/validate` and the MCP `testmaster_validate_document` tool share the
same strict catalog and semantic validator. Validation is read-only and rejects document
bytes above 1 MiB before schema traversal. JSON pointers and rules are unchanged across
transports. REST and MCP require a read-authorized installation token; validation never
creates a Source, Test or Run. Rejected MCP calls are append-only audited with actor/tool
identity and a safe outcome hash, not submitted argument bytes.

MCP evidence distinguishes byte integrity (`verified` or `partial`) from freshness
(`current` or `stale`). `verificationEligible` is false for partial, stale or nonpassing
evidence; a historically passing Run is not rewritten when its evidence expires.
`Application.open({imageLockPath})` can select an explicitly pinned deployment image lock;
request-scoped identities retain that lock, and unavailable images disable runner advertising.

Catalog persistence conformance iterates every public entity family, generates parent
fixtures from catalog schemas and relational foreign keys, and pairs DTOs with JSON,
stored data and durable outbox payloads. Families outside local persistence are explicitly
bound to their disabled milestone capability, not silently skipped. Migration
`0004_contract_constraints.sql` adds scalar enum/limit checks derived from the catalog;
regenerate both engines with `node packages/persistence/dist/generate-contract-constraints.js`.
SQLite validates existing rows before installing triggers, and PostgreSQL validates before
adding CHECK constraints. Incompatible historical rows stop the migration without rewriting
them; an operator must inspect preserved data before attempting a corrected upgrade.


### Provider-controlled generation

Model requests contain model/messages and, when needed, response_format/tools and
reasoning_effort. Configure reasoningEffort (low, medium, high, xhigh or max) on a model entry in the
user profile; an explicit ModelService.complete call overrides the model setting. Omission
uses the provider default. Invalid values are rejected before network access. The effective
effort participates in the model configuration hash, prompt hash and gateway cache key and
is preserved during repairs. Provider rejection remains an error, never a silent fallback.
TestMaster does not send max_tokens, max_completion_tokens, temperature, top_p, seed,
penalties or enable_thinking. Proposal budgets accept no deadline: a model call has no deadline
and only the caller's cancellation ends it. Provider allowlist, cancellation, response validation
and accounting remain local. There is no fixed input byte or token cap: the only local size
refusal is a prompt larger than the model's declared `contextTokens` (one token per UTF-8 byte),
raised before any transport as `PAYLOAD_TOO_LARGE` with `details: {promptBytes, contextTokens}`;
a model declaring no context is never refused for size. Normalization checks its cross-source
reconciliation (every source chunk) against that context before the first extraction batch, so a
source set that cannot be reconciled spends no paid batch. Output capability metadata is used only
for conservative budget reservations, falling back to declared context capacity and then to a
fixed 100000-token output reservation (`FALLBACK_OUTPUT_RESERVATION_TOKENS`); no token limit is
sent upstream. Such reservations are estimates, not a provider-enforced spending guarantee.
Measured usage is settled even when it exceeds the estimate; unknown charges remain held.

Historical evaluation registrations/results retain their original decoding settings and
frozen hashes. They cannot be rerun with this changed implementation; another evaluation
requires a new committed registration that records generation defaults and configured reasoning effort.
The evaluator validates `decoding.reasoning_effort` before frozen-input checks and uses it
in each isolated trial profile; reports disclose the resolved effort (null means provider
default). Current M2 supplemental journeys use medium, an 8192-token local output reservation
and a 100000-token project admission quota. Neither reservation is a remote output/spend cap.
Failed journeys capture supplemental model usage before removing their isolated workspace.
Round-specific captures preserve prior `validation/results` bytes and do not alter historical
benchmark ledgers. Measurement integrity is separate from generation graduation/public release.

Model refusals carry `details.reasonCode` (no milestone label): `provider_unavailable`,
`model_not_declared`, `model_capability_missing`, `model_not_in_inventory` (with
`declaredModelsPresent`/`declaredModelsAbsent` from the last provider listing),
`model_substituted` (the provider answered with a different model) and `model_not_configured`
(with the requested provider/model and the available model ids). There is never a silent
fallback to another model. A response that fails local validation is persisted on its
`model_calls` record, returned by the usage report and repeated in the final error and in a
cancellation error that follows an invalid attempt as
`validationFailure {code, message, issues, omittedIssues}`: at most 5 issues of validator path,
rule and message, clipped (message 300, path 200, rule 60, issue message 200 characters) and
scrubbed with the request's secrets. Model output text is never included.

Model cache: `ModelService.complete` builds a new `ModelGateway` for every call without passing
`cache`, so the gateway's `MemoryModelCache` (`model.ts`, `gateway.ts` constructor) is always
empty and `cache_hit` is always 0, even within one process. No persistent cache store exists
(`model_calls` keeps only `responseHash`). A retried normalization therefore pays for its model
calls again. This is a documented limitation, not a behavior change.

Semantic checks in the repair loop: `ModelRequest.check(output)` (model-gateway `types.ts`) runs
after schema validation, also on a cache hit (a cached output that fails it is a miss, so it is
validated on the paid path). It throws a `ContractError` whose `issues` become the repair prompt
(at most 20) and a bounded `validationFailure` on the invalid `model_calls` record; a non-`ContractError`
is a defect, recorded `failed` and never repaired. After two repairs the gateway rethrows the check's own
error (message, code, details) plus `repairs`, `candidateStatus`, `invalidAttempts`, `validationFailure`
and `modelCallId` (the last invalid call). There is no deadline for the whole call: the abort
signal is created once from the caller's cancellation, so repairs and checks share it;
each attempt reserves budget separately. `generate_plan` runs every per-proposal check in
that hook (evidence, requirement refs, plan validity, offered secrets, schema pointers, HTTP
status-only plans, type/runner, integration workflow) and collects all refused proposals, not the
first. A batch still refused after the repairs fails `INVALID_ARGUMENT` with the first cause as
message and `details {atomicity: "all_or_nothing", refused: [{index, requirementIds, reasonCode,
message, pointers?}], modelCallId}`, nothing stored; `partialGeneration` (MCP, CLI `plan generate
--partial`; the REST body has no such field) stores the proposals that pass and records the refused
ones in `extensions['testmaster:refusedProposals']` (they count as covering their requirements, are
never stored, and a batch with none valid is still refused whole). `partialGeneration` also sets
`ModelRequest.callerValidatesSchema`, so the gateway only parses the JSON and the check validates
each proposal on its own (`plan_invalid` with the issue paths as `pointers`): one proposal that
breaks the schema or the plan rules no longer fails the whole output. Accepting a proposal compares
the requirements it cites with `extensions['testmaster:requirementHashes']` of its batch (content
hashes taken at generation), not with the batch-wide snapshot fingerprint; a batch stored without
them counts every cited requirement as changed. `proposals.edit` clears the proposal's `warnings`
(the model wrote them for its own plan; the audit event keeps the old list). Known gap:
`proposals.edit` only re-runs the planner checks, not the secret, schema-pointer and status-only ones.

`generate_tests` takes `provider`/`model` (checked by `ModelService.select` before any call) and runs
the code importer as the response check, so a refusal is repair feedback. The generation prompt
interpolates `CODE_IMPORT_RULES` (planner `code-import`), built from the same constants the importer
enforces. The importer names the forbidden identifier and the line, never the code; it also refuses
the forbidden names as string keys (`x['require']`), `module` and `?.constructor`. A candidate still
refused after the repairs is listed in `validationErrors`; when every candidate is refused the call
fails `INVALID_ARGUMENT` (`reasonCode generated_code_refused`, `requested`, `validationErrors`,
`modelCallIds`). The receipt carries `requested`.

A plan assertion with the `jsonSchema` predicate has no counterpart in the model's vocabulary, so
the generation prompt lists each cited schema as `sourceSchemas: [{sourceRevisionId, pointer,
stepIds}]` (never the document) and tells the model to call `sourceSchemas.violations(rev, pointer,
await response.json())` and expect `[]`. The importer accepts that call only with literal revision
id and pointer that the plan cites (imported, authored code cannot use the fixture) and freezes the
resolved documents (`sourceSchemasFor`, as the plan runner resolves them) into the bundle; the
worker passes them as the runner input `schemas` and the harness stages `schemas.json` beside the
fixtures shim. The check refuses code that never calls it for a cited schema (repair feedback
naming the step, revision and pointer). A cited schema that no longer resolves, or documents above
4 MiB together, refuse that revision before the paid call. The runner image bundles `ajv` and
`ajv-formats` through the contracts dependency flatten (`containers/build.mjs`), so a change here
rebuilds the runner image (`containers/images.lock.json`).

A model call has no deadline anywhere: code generation, like every other purpose, runs until the
provider answers, and only the caller's cancellation (an aborted signal) ends it. Generated code
is long output and a refused first answer is followed by repairs, so a timer used to cut calls
that were still progressing and lose the whole batch. A caller cancellation is never turned into a
per-revision result; a revision the importer still refuses after the repairs is a `validationErrors`
entry and the loop continues, and any failure with no candidate is `generated_code_refused`. A fatal
error after calls were made carries `candidateRevisionIds`, `modelCallIds`, `validationErrors` and
`requested`, so created candidates are never orphaned.

The REST server's socket idle timeout (`connectionTimeout`, 30 s) would destroy the connection of a
handler that has written nothing yet, so the routes that run a model call switch it off for their
own socket (`holdConnectionOpen`, `apps/server/src/routes/authoring.ts`): proposal batches, proposal
and test refinements, requirement normalizations, run analysis, healing proposals and `POST /mcp`.
Every other route keeps the timeout, and `abortOnDisconnect` still lets a client that closes its
connection cancel the call. `ServerOptions.connectionTimeoutMs` shortens the timeout in tests.

Round 4 (`116f682e197727e867f2b4937caacbbb0be37fc8`) observed all eight planned trials:
all full-source normalizations failed semantic grounding validation; no generated proposals,
accepted revisions or paired benchmark replays were reached. Primary and conditional yield
were 0/8 (Wilson 95% [0, 0.3244156195108769]); secondary replay/proposal denominators were zero.
J02 failed ungrounded conflict evidence, J03 returned four requirements instead of three,
and the fixture-authored agent/candidate journey passed. Local acceptance is failed, not M2
completion. `validation/results/m2-round4-qwen38-medium/closure.json` records stages, usage,
single-execution captures and residual blockers. VAL-038/039 verify measurement integrity only;
sealed labels, family holdout, graduation, security/license and public-release obligations remain.

### M3 diagnosis/healing evaluation

`tools/dist/evals/m3.js` runs one preregistered round per directory
`evals/rounds/<id>/preregistration.json`; the registration `id` must equal `<id>`, and a
registration whose `started.json` marker or `evals/results/<id>-*` directory exists is refused.
Sequence: `check REG` (zero model and Docker calls), `controls REG NEW_DIR` (real healthy,
transformed, candidate, semantic-negative and oracle replays with zero remote model traffic),
`policy-probes REG NEW_DIR` (the 12 drift cases through the real HealingService with a controlled
local provider: policy eligibility or manual-only reasons; deterministic acceptance, not model
quality), `freeze REG CONTROLS_MANIFEST POLICY_PROBES_MANIFEST`, commit, then exactly one
`run FULL_COMMIT REG`. Controls and probes record the implementation/input manifest before they
execute; freeze rejects artifacts produced under different implementation, schema, prompt, image
or corpus bytes. `settle RESULTS_DIR` reconciles accounting only and never dispatches a call.
The start marker is created exclusively, so two controllers cannot both start a round.
Assertions are compared against the persisted normalized base revision; main-case
`stages.healthyOracle` comes from the independent oracle; integration stages are supplemental.
Replays pass an explicit healing policy (`apply` only for the policy trial, `off` for strict
controls and verification). Deterministic refusals, `model_abstained` and model failures stay
distinct in ledgers; abstentions and errors are primary misses. Primary denominators stay 12
drift / 26 nonhealthy / 30 main / 4 healthy / 9 true-bug offers; enrichment errors are misses
even when the factual fallback matched.

For local evaluator development, use `dev REGISTRATION OUT_LABEL [CASE_ID...]`. It runs
the same measurement pipeline and registered budget/secret safeguards without freeze,
readiness, commit or start-once checks; omitted case IDs select all 30 main cases plus
integration. The output label must match `[a-z0-9][a-z0-9.-]{0,40}`. Artifacts live under
`evals/results/dev-<label>-<timestamp>/` and are explicitly marked as development probes,
never registered rounds and never evidence toward a milestone gate. Subsets retain
per-case ledgers and `summary.json` without primary scoring; complete cohorts also get
the normal score report. The registered effort accepts low, medium, high, xhigh or max;
optional provider context/output capabilities are local admission metadata, not wire caps.

Round 1 (`b173a64`, `evals/results/m3-round1-qwen38-medium-2026-10-07T03-48-45-013Z/`) failed:
safe healing 0/12, cause accuracy 1/26; `validation/results/m3-round1-posthoc-audit.json`
records the evaluator and prompt defects corrected since. Its registration prose asks for a
Wilson lower bound >=0.8 at n=12, which even 12/12 (lower bound about 0.758) cannot reach; it is
kept verbatim as history, not used as a reachable pilot gate.

Round 2 (`fbafad3`, `evals/results/m3-round2-qwen38-medium-2026-10-07T18-00-29-630Z/`), the single
authorized run, also failed: safe healing 0/12, cause accuracy 1/26, completion 6/30, 0 unsafe
applications, 461818 conservative tokens, unknown money. `validation/results/m3-round2-posthoc-audit.json`
recomputes the score from the ledgers and explains the abstentions: browser drift catalogs that
cite dozens of non-admitted artifacts exceed the 90000-byte pre-dispatch cap, and model
`limitations` longer than an `Analysis` name were rejected locally until `d3dc8ed` bound the
gateway schema to the persisted one. The four verified policy healings match the frozen policy
probes exactly; they count as misses because their diagnoses abstained.

After round 2 the implementation was changed against the retained evidence and checked with paid
development replays (`evals/results/dev-*`, never registered rounds): the model catalog is
compact (every retained case <=34367 bytes, was up to 126 KB), a 2xx status contradicting a
required `statusIn` is a rules-derived `product_bug`, unresolved JSON pointers carry a value-free
structural diagnostic, browser locator evidence waits for attachment before the `before` sample,
named password inputs are identified without recording values, repeated locators on steps that the
failed run never executed get a deferred proof that only a passing verification can discharge
(`HealingService.reconcile` is async and `promoteRevisionCas` refuses an unproven deferral),
unsupported alternative hypotheses and unauthorized fix targets are dropped with a disclosed
limitation instead of discarding the diagnosis, and a model abstention keeps a cause the frozen
rules established from observed evidence. Prompts are `analyze-4-compact-structural-evidence` and
`heal-3-repeated-locator-coverage`.

Round 3 (`b767367`, one run per registration, same 30 cases, so a regression measurement and not a
holdout): `qwen3.8-flash` medium got safe healing 9/12, cause accuracy 21/26, defect recall 8/9,
precision 8/9, completion 30/30, 0/11 unsafe applications, 0/9 false repairs, 567154 conservative
tokens; `muse-spark-1.3` xhigh got safe healing 9/12, cause accuracy 19/26, recall 8/9, precision
8/9, completion 30/30, 0/11 unsafe applications, 0/9 false repairs, 504967 tokens. Money is
unknown for both. `validation/results/m3-round3-posthoc-audit.json` recomputes both scores. Healing
is capped at 9/12 because `m3-drift-07/08/12` are manual-only by design (renamed control,
duplicate roleless fingerprint). `m3-bug-03` and `m3-env-03` are labelled `unknown`
(disputed stratum) while rules and both models observe a failed business assertion, so
they score as misses; labels were not changed. Recall/precision (8/9) and healing (9/12) stay
below their proposed 0.9/0.8 pilot point targets; the M3 milestone gate stays red.

### M3 layered utility and capability decisions

New analyses require the layered diagnosis and hypothesis support at persistence. Rules own the
conclusion and healing advice; model enrichment contributes evidence-bound next steps without
changing either. `run analyze RUN` renders Failure / Expected / Observed / Conclusion / Next step /
Automatic healing in text mode, while `--output json` retains the structured response. Read a
stored analysis without enrichment using `run analysis RUN`. Markdown/HTML reports and MCP
include the same diagnosis summary; legacy records explicitly identify missing layered diagnosis.

`heal review PROPOSAL` is a read-only projection of base/candidate plans and retained evidence.
It exposes before/after values, control identity and candidate equivalence, policy-blocking reasons,
preserved assertion integrity, risk, verification and the exact version-bound approval command.
REST uses `GET /v1/healing-proposals/{id}/review` with `healing:R`; MCP exposes the same review.
Missing label/form evidence is null with a limitation. Nothing changes automatic identity guards,
policy application, promotion CAS or the immutable original failure.

Utility scoring separates `none`, `rules` and `model` arms with corpus-derived denominators;
next-action correctness/safety, dangerous actions, healing advice and overclaim are primary utility
signals. Cause/recall/precision remain secondary. Report automatic coverage separately from
predeclared automatic eligibility and isolated manual-candidate correctness. Regression action
labels are post-hoc scenario-design labels and do not count as sealed holdout; disputed labels remain
separate. Development replay or limited smoke is neither a registered round nor holdout evidence.
The sealed holdout format validates declared provenance and data consistency. Under
[ADR-012](adr/012-automated-only-validation.md) no gate requires human review or a human task study.

The registry adds `release.capabilityGates` with `requiredAreas`, `requiredItems` and
`nonNegotiable` requirement references. Two decisions remain blocked; assisted review (2026-10-10)
and CI integration (2026-10-11) passed automated-only acceptance:

| Command suffix | Evidence / remaining prerequisite |
|---|---|
| `--capability-gate m3-assistive-diagnosis` | **Passed (automated-only).** Sealed round 8 (`validation/results/m3-round8-posthoc-audit.json`, reference-clinic, frozen `b5cd410`, one run, no retries): model nextActionCorrect 29/30, nextActionSafe 30/30 against the approved >=0.95, dangerous 0/30, overclaim 0/30, no unclassified advice (typed next steps) and non-inferior to rules (0 regressed, 29 vs 29 correct); paired gain 0, no incremental-utility claim. Round 7 (reference-dockyard) had missed nextActionSafe (13/30) and round 6 (reference-helpdesk) 3/30; the general defects found there were corrected before round 8. One correlated synthetic family, no human utility evidence. |
| `--capability-gate m3-automatic-healing` | **Passed (automated-only) on sealed round 9.** Rounds 6-8 sent the whole plan to the healing model, including `plan.name`, which was the sealed case ID and spelled the group (`validation/results/m3-holdout-prompt-leakage-audit.json`); their healing-stage figures are void and were not rescored. Round 9 (`validation/results/m3-round9-posthoc-audit.json`) ran on the new reference-hostel family (30 cases, authored after the implementation freeze `d484cf2`, registration frozen at `b476bb8`, one run, no retries) with every request routed through the prompt-leakage guard and opaque plan names; stopReason null (no leak recorded): eligibleSuccess 11/11 against the approved >=0.8, safe healing 10/12, 0/12 unsafe applications, 0/9 false repairs, 45 calls, 657470 conservative tokens. One correlated synthetic family; the guard inspects requests, not model behavior; no population-safety or generalization claim. |
| `--capability-gate m3-assisted-healing` | **Passed (automated-only).** `validation/results/m3-assisted-review-20261010/acceptance.json`: built CLI JSON/text, REST loopback and MCP stdio; complete review, version-conflict and cross-project denial; candidate positive/semantic-negative Docker controls; manual approval and verification with intact assertions and historical evidence. `reviewLoad`: 1 proposal, 1 change, 1 change/proposal. |
| `--capability-gate m3-ci-integration` | **Passed (automated-only).** `validation/results/m3-acceptance/hosted/public/fork-token-isolation-acceptance.json` with raw API records and logs in `22-fork-benign/` and `23-fork-hostile/`: a fork owned by a second GitHub account gets no secret, writable token, gate check or execution; commit binding verified on merge-ref runs. Revalidated by `tools/src/github-action/hosted-evidence.test.ts`. |

To repeat the fork controls, use a disposable public base repository with the generated workflow, a
random canary repository secret and "require approval for all external contributors", and a second
account's fork with a benign branch and a hostile branch (both same-repository job guards removed,
plus a probe workflow requesting write permissions that records HTTP codes, the canary length and the
OIDC endpoint). Approve each run with the base owner, retain the raw run/job/check/status/pull JSON
and logs, delete the canary and revoke the second account's token. The validator rejects the
evidence if the secret is readable, any write API is not refused, a gate check/status exists on the
fork head, or the pinned Action did not refuse before installing the runtime.

Changes after the spent round 6 (2026-10-11, implementation freeze for the next round; prompts
`analyze-6-typed-next-steps` and `heal-4-ranked-candidates`): model next steps are typed
selections from the shared action vocabulary (`AIAnalysisOutput.nextSteps[].action`) and the
application renders their text, so no model prose is shown as advice; an action that does not fit the
recorded cause, or a healing review without a code-owned proposal, is dropped with a disclosed
limitation. A model cause without a hypothesis supported by execution observation is no longer a
whole-response rejection: the cause is not recorded, the rules cause stays, and the typed steps and
evidence gaps remain. The healing model input ranks locator candidates (matched, then interactive or
identified elements) before the 30-candidate cap instead of using DOM order, since round 6 abstained
on two cases whose renamed control sat beyond the first 30 elements. A healing abstention keeps a
bounded, scrubbed copy of the model's stated reason in the job result for audit. The evaluator
measures the drift oracle and semantic negative for any case carrying a semantic-candidate control,
not only the `drift` group. Round 6 is not rescored; the next measurement needs a new sealed family.

Round 7 (`597738f`, one run, sealed reference-dockyard family, `muse-spark-1.3-contributor` xhigh):
safe healing 10/12, eligibleSuccess 11/11, cause accuracy 21/26, recall 8/9, precision 8/8, completion
29/30, 0/12 unsafe applications, 0/9 false repairs, 44 calls, 504125 conservative tokens
(`validation/results/m3-round7-posthoc-audit.json`). Its healing-stage figures are void for prompt leakage (see the `m3-automatic-healing` row), so round 7 did not close `m3-automatic-healing`; round 9 did. The
assistive arm was non-inferior to rules (0 regressed, 25 vs 25 correct) but its nextActionSafe was
13/30, so `m3-assistive-diagnosis` stayed blocked after round 7. The analysis of the retained ledgers found four
general defects, corrected after the round (prompt `analyze-7-code-owned-advice`; the dockyard family
is now development evidence and is not reused as holdout): a model could add an
actionable step beside a code-owned recommendation, and an evidence step to a passed Run; a
credential-establishing request (one that captures a sensitive value) counted as the entity write
that makes a later read a persistence suspect, which made a renamed response field a product bug and
made the model's correct contract cause contradict the rules; a wrong value on a read after a write
was advised as a requirement comparison instead of a persistence inspection; and a locator timeout
on a named password input never reached a baseline-equivalence proof because those inputs have no ARIA
role. Now the model may only add evidence collection once the rules advised an action and nothing to
a passed Run, a required field missing from an existing object of a 2xx response without an
explaining write is a `contract_violation`, a value mismatch on a read after a write inspects the
write and the read, and a named password input is proven equivalent through its recorded test id.
Paid development probes on the burned dockyard cases (`evals/results/dev-dev-rules2-*`) gave a safe
rules and model arm on all six probed cases; that is development evidence only.

Round 8 (`b5cd410`, one run, sealed reference-clinic family authored after the freeze `3bbd838`,
never used in development, `muse-spark-1.3-contributor` xhigh): model nextActionCorrect 29/30,
nextActionSafe 30/30 (Wilson [0.886, 1.0]), dangerous 0/30, overclaim 0/30, no unclassified advice,
paired improved 0 / regressed 0 (rules correct 29, model correct 29: non-inferior); safe healing
10/12 (the two misses are manual-only by design), eligibleSuccess 11/11, cause accuracy 24/26,
recall 9/9, precision 9/9, completion 30/30, 0/12 unsafe applications, 0/9 false repairs, 44 calls,
534618 conservative tokens (`validation/results/m3-round8-posthoc-audit.json`, score recomputed from
the retained ledgers). That closes `m3-assistive-diagnosis` automated-only (the analysis prompts were audited clean; the healing-stage figures above are void for prompt leakage, see the `m3-automatic-healing` row; cause accuracy, recall and precision are diagnosis measurements and stand): one correlated synthetic
family, no human utility, population or generalization claim, and no incremental gain over rules.

Round 9 (`b476bb8`, one run, sealed reference-hostel family authored after the freeze `d484cf2`, `muse-spark-1.3-contributor` xhigh, provider routed through the leakage guard, opaque plan names): safe healing 10/12, eligibleSuccess 11/11, cause accuracy 24/26, recall 9/9, precision 9/9, completion 30/30, 0/12 unsafe applications, 0/9 false repairs, assistive nextActionCorrect 29/30 and nextActionSafe 30/30 (non-inferior to rules, 0 regressed), 45 calls, 657470 conservative tokens (`validation/results/m3-round9-posthoc-audit.json`, score recomputed from the retained ledgers). It re-measured healing after the VAL-016 invalidation and closes `m3-automatic-healing` automated-only; the targets were preregistered unchanged from round 8. One correlated synthetic family; no population, human-utility or generalization claim.

Run each as `node tools/dist/traceability/cli.js check COMMAND_SUFFIX`. The scoped checker returns
the selected decision and concrete reasons, validates its referenced evidence and refuses missing
targets/controls, waived invariants or critical/high findings. It does not require unrelated release
areas, but the full normative inventory still applies. `check --milestone-gate M3` is the
cumulative gate (passing since 2026-10-12 under ADR-013, below); a scoped pass alone does not graduate M3 or GA.

Release areas carry `gate` (`M0`..`M6` or `claim`) and `series`. A cumulative milestone gate is
blocked by a non-passed area only when its `gate` is not `claim`, is not later than the gate being
checked and the area has no valid `supersededBy` (a passed area of the same series that appears
later in the register); `check --milestone-gate Mx` prints the per-area effect as an `areaSummary`
line. Supersession is additive metadata: a failed area keeps its decision and numbers. A verified
registry item may declare `deferred` residual scope owned by a later milestone with a literal
specification quote; it blocks every gate at or after that milestone. See
[ADR-013](adr/013-release-area-supersession.md).

#### Cumulative M3 gate (2026-10-12)

`node tools/dist/traceability/cli.js check --milestone-gate M3` passes at `1838f47`
(`validation/results/release-evaluations/M3/1838f47f87ff2944b3bbc00bab79efe3c09b08db.json`, written once by
`evaluate --milestone-gate M3` from a clean worktree; the four capability gates have records beside it, and the
earlier failed record `a3ac6e35...` stays as history). Procedure for a new record: commit, run `evaluate` in a clean
worktree of that commit, commit the record; re-evaluating the same commit refuses (`already recorded`).

How the gate passes ([ADR-013](adr/013-release-area-supersession.md); nothing historical was rewritten and no target was relaxed):

- Seven failed or blocked qwen3.8 and early Muse loop areas are superseded by the passed round 9 area of the same series; their
  decisions stay `failed`/`blocked`. Claims cover the round 9 model and configuration (`muse-spark-1.3-contributor`, xhigh);
  qwen3.8 diagnosis and healing are not claimed.
- The six M2 generation areas are claim-scoped: they block only the homologated model-generation claim, which stays unmade.
- `public-release` is an M6 area and does not block the M3 gate.
- Local engineering for the remaining M3 items was verified with real tests and evidence (OPS-001/005/011/012/021-025/027/035/038, SEC-013/022/036/037/039/045/046/047,
  NFR-003/011, INT-007, M0-05, M2-08, VAL-003/007/050 and others); SEC-045 evidence is `validation/results/sec-045-scan/`.
- Residual scope owned by later milestones is deferred with a literal quote and blocks every gate at or after its milestone
  (`check --milestone-gate M4` lists it):

- **M4**: ARCH-004, INV-014, J05, J12, NFR-003, OPS-001, OPS-005, OPS-011, OPS-021, OPS-022, OPS-024, OPS-025, OPS-027, OPS-035, OPS-037, OPS-038, SEC-013, SEC-022, SEC-036, SEC-037, SEC-039, SEC-047, VAL-007, VAL-033, VAL-035, VAL-045.
- **M5**: J08, J12, OPS-001, OPS-035, REQ-028, VAL-035.
- **M6**: M0-05, OPS-035, VAL-035, VAL-045.

The per-item scope and quote tables live in ADR-013.

Claim limits: rootful hardened Docker only (rootless unvalidated, [ADR-014](adr/014-rootless-deferral.md)); generation quality is
claim-only; no GA; webhook, GitHub App, preview, advanced browser matrix and server-profile scope remain M4/M5.

Reproduce the assisted-review journey after `pnpm build` with
`TMPDIR=/tmp pnpm exec vitest run --project docker validation/journeys/m3-healing-acceptance.docker.test.ts -t 'HEAL-003 automated assisted review'`
through the result-preservation wrapper. It uses one local controlled provider response and no
paid model calls. The evidence records Run/Attempt rows, manifests, frozen review projections and
binary/source/image-lock SHA-256 hashes. One deterministic selector-drift family demonstrates the
review surface, not model quality, population safety, human usability or workload improvement.
REST/MCP/CLI healing approval needs only the ordinary write scope (REST route scope `healing:W`); no grant and no human principal is required.
All processes use the same project-frozen execution configuration, including configuration origins;
the scenario does not weaken execution-identity, authorization or automatic-healing guards.
Approval and verification admission commit in one transaction after every refusal was checked
(`assertVerificationAdmissible`): a refused admission leaves the proposal's version, status and
limitations unchanged, and a successful approval is two version steps (approval, then the link to
the verification Run). Under `CI=true` the resolver forces `healing.mode` off with origin
`environment` (recorded as `ResolvedConfig.overrides`, outside the hashed `effectiveConfig`), so a
shell with `CI=true` cannot approve a proposal whose failed Run was admitted without it: the
`REVISION_CONFLICT` message and `details` (`reasonCode: execution_configuration_changed`,
`changed`, `overrides`, `nextActions`) name the keys and their frozen/current origins, never values.
The `environment` section of `testmaster.config.json` (and `TESTMASTER_BASE_URL`, `TESTMASTER_NETWORK_PROFILE`,
`TESTMASTER_LOCALE`, `TESTMASTER_TIMEZONE`) only seeds the first Environment at `init`, the model request
locale and the `doctor` timezone check; changing it after `init` retargets nothing, so
`testmaster_update_environment` does not rewrite it. A Run never records those file values as
effective: `matrixCell.effectiveConfig.config.environment` holds the values of the EnvironmentRevision
the Run executed against (`baseUrl` is the origin actually targeted, a destination override included),
with origin `environmentRevision` for each `environment.*` key. The frozen-configuration comparison
above protects the execution configuration (limits, executor, browser, artifacts, healing mode,
policy hash); it substitutes the pinned revision into the `environment` section on both sides, so
a project-file or `TESTMASTER_*` environment change no longer refuses an approval (the environment
itself stays pinned by the revision id check, `Frozen healing environment changed`), and Runs
recorded before this change still compare. Run comparability reports an environment difference
only as `environment-changed`, never also as `execution-config-changed`.
An unauthorized caller is refused with a plain `FORBIDDEN` (`details.scope`); the refusals `approval_grant_required`,
`approval_not_permitted` and `requiredGrant` no longer exist. The approval is recorded with the acting principal
(human, token, service or agent) and stays version-bound, with assertions never changed.


Plan/ID reconciliation: VAL-053 and VAL-054 already existed in the normative corpus (registry
completeness and immutable/versioned release evidence). They were extended additively for utility
provenance and scoped capability decisions, not reassigned as new IDs or stripped of prior controls.
AI-005 and HEAL-003 are the new layered-diagnosis and healing-review requirements. New test source
links record implementation controls, not sealed holdout or security homologation.

#### Exercised development evidence (2026-10-08)

`validation/results/m3-utility/rules-replay-summary.json` records offline rules replay over copies
of 62 retained original workspaces: 61 analyses, with the Qwen supplemental integration Run
explicitly skipped because its retained Run was missing (30 Qwen / 31 Muse analyses). Originals
were not replay targets. Each arm's undisputed primary regression cohort has 28 cases: rules
next-action correct 23/28 versus none 0/28, safe 24/28, dangerous 0/28, healing advice 25/28 and
overclaim 1/28. The overclaim is env-01's rules environment cause versus the post-hoc security label;
labels were not revised to fit outputs. The disputed bug-03/env-03 pair remains separate (rules
correct 0/2 versus none 2/2). These are correlated development-corpus observations, not holdout
or generalized rates; intervals and limitations remain in the retained summary.

`validation/results/m3-utility/cli/summary.json` records seven real CLI case inspections, text/JSON
analysis, Markdown/HTML exports and manual/applied healing reviews. The HTML render was visually
inspected (`cli/diagnosis-render.png`). `assisted-candidate-replay.json` records drift-07/08/12 on
isolated copies with healing off: all three candidate positives passed, all three semantic negatives
failed, assertions stayed intact and no candidate was promoted (six Docker controls).
`generic-driver-controls.json` records two synthetic external-driver controls with four Docker
runs, physical independent oracles and zero model calls. These prove exercised local mechanics,
not sealed holdout, recorded review-surface acceptance or automated security homologation.

The single limited paid Qwen medium smoke is **failed utility enrichment**, not success:
`validation/results/m3-utility/qwen-medium-smoke-summary.json` records four generation calls plus
four inventory calls, all HTTP 200, 91,422 conservative tokens, 24,367 measured input-plus-output
tokens (5,238 reasoning tokens are included in output, not additive), zero first-attempt schema
invalids and zero repairs. Generation latencies were 36,126 / 41,098 / 46,747 / 14,855 ms; money
is unknown. All four enrichments were rejected by the newly added execution-observation-only
next-step guard despite known handles, so rules layers remained and no model next steps were
admitted. No observed incremental utility gain or model superiority follows from this smoke.

That extra predicate was removed for next steps only; known-handle validation and existing
hypothesis-support guards remain. The correction passed a 60-test deterministic analysis/replay suite and a
built-runtime controlled-output admission check (`nextstep-guard-runtime.json`, `providerLive:false`);
the corrected code has **not** received another live provider call. Supplemental-advice safety
controls passed the 54-test evaluation suite: primary first-displayed action stays rules-first,
any dangerous visible advice is unsafe and unclassified advice cannot receive safety credit.
Unresolved free-text advice stays `unclassified` without safety credit. Post-hoc advice
classification is recorded separately in `posthoc-advice-classification.json` without changing the
original smoke/replay evidence or making another provider call.

Final preserved `pnpm check` passed 112 files / 839 tests, regenerated contract consistency and
448 normative registry IDs. The full Docker suite passed 50 files / 133 tests. Both wrapper
manifests reported `verifyFailures=0`; the Docker wrapper restored 84 rewritten result files.
The four capability commands all returned blocked (exit 1), with their genuine external holdout,
safety-review or participant-study reasons and no missing protected assertion (the fork-isolation
reason has since passed; see the gate table above).
The cumulative M3 milestone remains red (exit 1). See `validation/results/m3-utility/verification.json`
and `gates/summary.json`. The 62 original retained workspaces / 6,841 files remain byte-identical.

#### Post-correction live admission smoke (2026-10-08)

The separately authorized bounded smoke ran `m3-bug-02` first, then `m3-bug-03`,
`m3-drift-03` and `m3-healthy-01`. All four enrichments were admitted by the current
built application: four Qwen medium generation requests and four inventory requests,
91,878 conservative tokens, 23,808 measured input/output tokens, no repairs and all
generation responses HTTP 200. Conclusion and healing advice remained rules-owned;
the four original workspaces were byte-identical. No test changes or healing were applied.

Admission is not demonstrated utility or safety. The twelve supplemental next steps
remain unclassified by the runtime classifier; `bug-03` is excluded from utility
denominators as a disputed label. `healthy-01` suggests unnecessary
investigation despite passing. `bug-02` suggests diagnostic polling, not authorized
test modification; some advice points to empty logs or uninspected artifact fields.
`drift-03` still has unknown cause and manual-only advice, which differs from the
existing scenario labels. Those labels and the earlier smoke evidence were not changed.

Evidence: `validation/results/m3-utility-postfix-live/summary.json`, `session.json`
and the referenced development replay reports. The next prerequisite is a sealed holdout
authored after implementation freeze using `evals/holdout/case-format.md`, with declared
authorship and the deterministic `disputed` rule ([ADR-012](adr/012-automated-only-validation.md)).
No capability was homologated by this smoke.


### M4 server, portal, teams and automation

`node tools/dist/traceability/cli.js check --milestone-gate M4` passes. The cumulative M3 gate and the four M3 capability gates still pass. The
write-once record is written by `evaluate --milestone-gate M4` from a clean worktree into
`validation/results/release-evaluations/M4/<commit>.json` (same procedure as M3: commit, evaluate in a clean worktree of that commit, commit the
record). Every cited run goes through the result-preservation wrapper; the records are under `validation/results/m4-acceptance/<slice>/`
(`manifest.json`, `output.log` and the created journey manifests).

How the gate passes ([ADR-022](adr/022-m4-gate-closure.md); nothing historical was rewritten and no target was relaxed):

- All 111 registry items owned by M4 are verified, and the 36 M4 deferred entries on M0–M3 items were discharged by tests.
- Journeys J09, J10, J12, J13, J16 and J17 (server) have versioned scripts, retained passing runs and automatic, reviewer-named manifests
  (`validation/journeys/m4-journey-manifests.test.ts`).
- J12 was also exercised on GitHub.com: a real GitHub App created through the manifest flow, installed on a disposable public repository, with
  signed webhooks reaching a server-profile stack through a quick tunnel. That run found and fixed three defects that the fake GitHub did not
  show (manifest events, `push` without `action`, redelivery after uninstall). Evidence: `validation/results/m4-acceptance/hosted/`, validated by
  `tools/src/github-app/hosted-evidence.ts`.
- Residual scope that the specification assigns to later milestones is deferred with a literal quote and blocks the gate at that milestone:
  - **M5**: J08, J12, J13, OPS-001, OPS-026, OPS-028, OPS-033, OPS-035, REQ-028, REQ-038, SEC-030, VAL-035, VAL-045.
  - **M6**: J16, M0-05, OPS-019, OPS-034, OPS-035, VAL-035, VAL-045.

Claim limits (what M4 does not show):

- Storage is PostgreSQL plus the filesystem on one host. S3-compatible storage is refused (`CAPABILITY_UNAVAILABLE`) and not claimed; tenant key and IAM
  isolation for S3 is M5 (SEC-030).
- PostgreSQL writes are serialized by one advisory lock on one host; the server profile does not scale writes horizontally. Remote workers,
  outbound enrollment over a network and distributed fair share are M5.
- The portal is verified in Chromium only. No human screen-reader session and no pt-BR/en visual matrix (J16, VAL-041: M6). Firefox and WebKit are M5.
- Docker: rootless and rootful hardened daemons on Linux x64; no macOS/Windows capacity or portability claim (OPS-034: M6).
- GitHub: the fake GitHub suite plus one hosted installation on GitHub.com. No real fork case was exercised there (one GitHub account), so fork
  denial is proven by `validation/journeys/j12-github.pg.test.ts` only. `github.suiteId` list admission is not implemented: pull-request runs use the
  repository selection. GitHub Enterprise Server and vendor preview APIs are not validated.
- Dynamic authentication evidence uses the local `fixtures/reference-auth` provider; no hosted identity provider was tested. Notification delivery makes
  no exactly-once claim, and there is no Jira/Linear tracker (M5).
- Operations: one disaster-recovery rehearsal (RPO 2.6 s, RTO 8.9 s on the reference host) and one capacity benchmark on Linux x64
  (`validation/results/m4-dr-rehearsal.json`, `m4-capacity-benchmark.json`); proposed objectives are not measured service levels. Volume encryption is an
  operator attestation. No SCIM revocation source (OPS-019: M6).
- Reproduce with `pnpm test`, `pnpm test:postgres`, `pnpm test:postgres-parity`, `pnpm test:docker` and `pnpm test:docker:rootless`, each through the
  preservation wrapper; the PostgreSQL projects start a pinned `postgres:17-alpine` container per run.
