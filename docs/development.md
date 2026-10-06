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

The adversarial sandbox Docker suite requires `tcpdump` and permission to run
`sudo -n tcpdump` on loopback for a bounded controlled-target packet recording. It fails
explicitly when capture is unavailable; the container itself never receives extra capabilities.
The suite exercises browser/CDP/broker, JavaScript/meta navigation, service-worker and iframe
requests and WebSocket reconnect denial. WebSockets remain unsupported (fail closed); DNS has
no proxy cache and is revalidated on every fresh socket. Chromium launch failure reports
`blocked/security_precondition_failed` and never retries without its sandbox.
Python runner images remove build-time pip/uv installers after their frozen dependency sync;
runtime dependencies require a reviewed rebuilt image. `python/runtime.json` records the pinned
image ID and exact package versions. Shared evidence text uses known-secret and common sensitive
header/URL/JSON/form/e-mail/document patterns; this is not a guarantee of unknown PII anonymity.
Controller-side raw-pattern hits and malformed JSON/NDJSON are withheld as `redaction_failed`,
and protocol artifact chunks never enter public observation events. Archive extraction accepts
an AbortSignal and removes incomplete staging on failure/cancellation; nested archives are
rejected by both extension and magic, never recursively unpacked.


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

Worker admission reserves aggregate CPU, memory, PIDs and scratch disk before the lease claim
in the same transaction. CPU and RAM retain 25% host headroom; browser, HTTP and Python have
independent pool slots. A job that cannot fit stays queued without an Attempt, and published worker
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
encrypted by the supervisor into secret references before persistence. Runtime sockets use a
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
M2 source/discovery/requirement/proposal/usage commands share application services. Declare
OpenAI-compatible `modelProviders` only in the selected user profile, grant their IDs in the
operator policy's `allowedModelProviders`, then explicitly `consent grant --provider ID
--data-class documents requirements --allow-unknown-cost` for an unpriced provider before
normalization/planning. Unknown-cost consent defaults to false, is stored with data-class
consent, audited by its digest, and revoked with the grant. Repo content cannot configure
providers or tools. Prices remain `unknown`, never zero; monetary ceilings refuse unknown
reservations. `budget set --tokens N` (or authenticated `POST /v1/projects/{id}/budget`
with `{ "tokens": N }` and an Idempotency-Key) sets the independent cumulative project
input+output quota. The initial ceiling is 100,000 tokens; reservations atomically charge
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
  `--feature ID...` observes each expected feature's admitted route independently; unauthenticated
  login barriers remain `unreachable` with `login_required`. `ready` means the operator-declared
  `testmaster:completionText` was observed (the feature-state extension labels it `full`); absent
  completion evidence remains `partial`, never complete coverage by route visitation alone.
  `--job ID --retry-feature ID...` creates a new job/cost ledger for only eligible selected features,
  preserving all unselected results and the original job. `--video` is explicit restricted-raw opt-in,
  requires raw/admin permission, and is refused for production exploration. Default exploration has
  no video. Updating a source or discovery fingerprint clears descendant requirement approvals and
  makes retained proposal batches stale, without rewriting immutable revisions or pinned Runs.
  Code-role source inference cannot acquire explicit authority from model output; conflicting
  implementation versus desired PRD remains subject to reviewer adjudication.
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
reasoning_effort. Configure reasoningEffort (low, medium or high) on a model entry in the
user profile; an explicit ModelService.complete call overrides the model setting. Omission
uses the provider default. Invalid values are rejected before network access. The effective
effort participates in the model configuration hash, prompt hash and gateway cache key and
is preserved during repairs. Provider rejection remains an error, never a silent fallback.
TestMaster does not send max_tokens, max_completion_tokens, temperature, top_p, seed,
penalties or enable_thinking. Proposal budgets accept only deadlineMs. Consent, input
admission, cancellation, response validation and accounting
remain local. Output capability metadata is used only for conservative budget reservations,
falling back to declared context capacity or the admitted input allowance; no token limit is
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

Round 4 (`116f682e197727e867f2b4937caacbbb0be37fc8`) observed all eight planned trials:
all full-source normalizations failed semantic grounding validation; no generated proposals,
accepted revisions or paired benchmark replays were reached. Primary and conditional yield
were 0/8 (Wilson 95% [0, 0.3244156195108769]); secondary replay/proposal denominators were zero.
J02 failed ungrounded conflict evidence, J03 returned four requirements instead of three,
and the fixture-authored agent/candidate journey passed. Local acceptance is failed, not M2
completion. `validation/results/m2-round4-qwen38-medium/closure.json` records stages, usage,
single-execution captures and residual blockers. VAL-038/039 verify measurement integrity only;
human review, family holdout, graduation, security/license and public-release obligations remain.

