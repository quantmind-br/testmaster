# Quickstart (M0–M2, local single-user)

TestMaster runs approved test revisions deterministically inside a hardened Docker sandbox and keeps
verifiable evidence under `.testmaster/`. Generation with a model is optional and `experimental`.

## Install the public experimental runtime

The Linux x64 relocatable prerelease is available at
[runtime-f4e3335](https://github.com/quantmind-br/testmaster/releases/tag/runtime-f4e3335)
(signed manifest; the earlier unsigned `runtime-89a7205` is refused by the current installer).
Download its `INSTALL.md` for hash-pinned installation without building the monorepo.
Node 24 and rootful hardened Docker with the containerd image store remain host
requirements. The release includes a standalone installer, runtime, both locked
images, corresponding sources, SBOM and acceptance evidence. npm packages remain
private; public availability is not GA or M3 homologation. Use the documented
per-user link in `~/.local/bin` to make `testmaster` available on PATH.


## Prerequisites

- Linux x64, Node.js 24, pnpm 12.9.1, Docker Engine reachable by the current user (validated: rootful
  with the hardened profile in `docs/adr/003-rootful-docker.md`; rootless is the reference profile but
  not yet validated — see `docs/support-matrix.md`).
- Build once from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
node containers/build.mjs          # builds and pins testmaster-runner and testmaster-runner-python
alias testmaster="node $PWD/apps/cli/dist/main.js"
```
### Install from the checkout with Make

```bash
make install PREFIX="$HOME/.local"
make verify PREFIX="$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
testmaster --version   # e.g. 0.1.0 (schema 1.0.0, runner 1.0.0): the CLI build, then the contract versions capabilities reports
# Remove only this managed installation; project data is retained.
make uninstall PREFIX="$HOME/.local"
```

Run these targets from the repository root. `make install` installs locked build
dependencies and compiles with Node 24 before staging independent production files.
It excludes checkout sources, evaluation results and private configuration; no
hardlinks to writable checkout files are used. Docker and the locally locked images
remain prerequisites; run `node containers/build.mjs` before executing tests if needed.
The launcher pins the Node executable used to install. Prefixes containing spaces
are supported. `SELF_CONTAINED=0` explicitly binds the launcher to this checkout
instead of copying the runtime; moving/removing that checkout then breaks the launcher.

Installation validates the staged CLI before replacing an owned runtime and rolls
back ordinary installation errors. Existing unowned/modified launchers, symlinks,
runtime directories or missing/mismatched ownership markers are refused without
deleting them. An installation made by the previous Makefile has no ownership receipt
and must be moved aside explicitly before installing this version. `uninstall` follows
the saved receipt, not the current `SELF_CONTAINED` option, and never removes the source
checkout or project `.testmaster` data. A process kill may leave a staging directory or
`.testmaster-install.lock`; inspect the prefix before removing stale installation state.


`testmaster doctor` refuses execution (exit 9) when Docker, the image lock or the seccomp profile is
not usable, the data directory is not writable, or the database has pending migrations. The report
separates `blocking` checks from advisory `recommendations` (timezone not an IANA name, non-loopback
network profile, unavailable browser sandbox, low disk, rootful Docker) and prints only the redacted
effective configuration. On a Node.js major other than 24 every command, `doctor` included, exits 6
(`unsupported_node`) before it opens any state. There is no silent fallback to unsandboxed execution;
`--unsafe-local` additionally requires `execution.executor: "process"` and a user-level opt-in, and
reports mark the run as not isolated.

## Deterministic path (no model, no internet)

The application under test must already be running (here on `127.0.0.1:3000`).

```bash
testmaster init --mode local --name shop --base-url http://127.0.0.1:3000
testmaster doctor
testmaster test scaffold --type frontend > testmaster_tests/login.plan.json   # frontend|backend|cli; or write a plan by hand
testmaster test lint --plan testmaster_tests/login.plan.json                   # offline validation
testmaster test create --plan testmaster_tests/login.plan.json --output json   # immutable revision
testmaster test run "$TEST_ID" --wait --output json                              # replay mode, heal off
testmaster artifact get "$RUN_ID" --out .testmaster/failure                     # verified bundle copy
testmaster report export "$RUN_ID" --format junit --out report.xml              # json|markdown|html|junit|allure
# fix the application outside TestMaster, then replay the same revision
testmaster test rerun "$TEST_ID" --wait --output json
```

`--type cli` scaffolds a terminal-runner plan for a command-line or TUI program; see [Terminal tests](terminal-tests.md).

- `--output json` (or `--json`) prints exactly one JSON envelope on stdout; diagnostics go to stderr.
  A long-running command (`server start`, `backup agent`) prints its receipt envelope as soon as it is running; if
  it then fails, a second envelope with the `error` follows on stdout and the exit code is set. Only your own
  interruption (Ctrl-C, SIGTERM) ends it without an error envelope.
- Exit codes follow `specs/05-cli-mcp.md` §3 (0 passed, 1 failed gate, 6 precondition, 7 wait deadline,
  8 capability unavailable, 9 policy/sandbox denied, 15 run blocked by policy, 130/143 interrupted).
- `test run --wait` without a running worker makes the CLI the ephemeral owner; Ctrl-C cancels durably.
  With `testmaster worker start` running, the CLI only waits and Ctrl-C detaches unless
  `--cancel-on-interrupt` is given. Without a worker and without `--wait`, admission is refused.
- Secrets are references: `testmaster secret set API_TOKEN --from-env API_TOKEN` (or `--file`); values never
  go on argv and are released to the sandbox only on demand.


For upload steps or HTTP artifact request bodies, import a project-scoped immutable input first:

```bash
testmaster artifact import-fixture ./profile.bin --mime-type application/octet-stream --name profile --output json
```

Use the returned `art_...` ID in `upload.input.artifactRefs` or a request body's `artifactRef`.
Import requires project write permission and rejects inputs larger than the lesser of the effective
body/artifact limits (defaults: 10 MiB/64 MiB). Storage is content-addressed with private file permissions.
Dispatch admits only same-project, non-revoked fixtures whose bytes match their frozen hash, and
records `inputFixtureHashes` in admission and sealed execution provenance. Upload/download/frame
permissions and ordered popup aliases come only from the frozen plan, not the presence of a fixture.
Fixtures use the same named deletion command and immediate tombstone revocation as run artifacts;
physical removal waits for active runs, legal/shared-reference/backup holds. Imported inputs are not
execution evidence and never appear as fabricated Run/Attempt artifacts.

`testmaster run analyze "$RUN_ID" --output json` persists a factual diagnosis of a terminal Run
without a model request. It uses the frozen revision and persisted execution evidence, preserves
the original outcome/gate, and abstains when evidence cannot establish a cause. Missing bundles
are disclosed with a null snapshot rather than manufactured evidence. A successful analysis
command exits 0 even when the analyzed Run failed.

Optional enrichment is explicit: use
`testmaster run analyze "$RUN_ID" --model` with a provider the operator policy
allows; a model reading has no deadline and runs until the provider answers. Only sanitized execution
summaries and bounded measurements cross that boundary, not raw
trace/video or sensitive captures. Choose the model with `--provider ID --model-id ID`; an unknown
choice is refused before any work. Model refusal/failure retains the factual predecessor and records a
limitation in a separate immutable analysis that stays `source: "rules"` (it never claims to be model
output). Identical requests reuse their stored receipt;
interrupted paid calls are not reissued.

Reports preserve execution outcomes even when evidence is missing, expired or fails integrity:
the affected member has `evidenceState: "unavailable"`, null snapshot/manifest and explicit
`evidenceErrors`; report completeness becomes partial and cannot approve a strict CI gate.
Latest diagnosis is enrichment, never a replacement verdict. Applications exporting multiple
formats should capture `reports.snapshot(id)` once and pass it to `reports.exportCaptured`.
CI exports use `artifacts.exportSanitized(runId, outDir)`: restricted raw entries are omitted
with source snapshot/hash provenance, not relabelled as redacted. Original bundles are immutable.
If the CI wait deadline expires during collection, the exported report stays partial with
`ci-wait-deadline-exceeded` even when bounded cancellation subsequently commits the retained
evidence. JSON and JUnit remain non-approving; collection completion does not erase the timeout.
HTTP artifact downloads are attachment-only, private/no-store, nosniff and sandboxed.

```bash
testmaster artifact delete "$ARTIFACT_ID" --confirm "$ARTIFACT_ID"
testmaster artifact deletion-status "$DELETION_ID"
testmaster usage --run "$RUN_ID" --model qwen3.8-flash --since 2026-01-01T00:00:00Z --until 2026-12-31T23:59:59Z --out usage.json
```

Deletion immediately revokes reads, including Range and previously prepared streams. Physical
collection stays pending under active execution, legal, shared-reference or backup holds; worker
maintenance resumes it. Restore reapplies tombstones and deletion operations before admission
can be reviewed. Old backup bytes are not promised immediate erasure. Deletion needs the named
`artifacts:delete` authority, not ordinary read/raw permission.
Status separates `physicalDeletionDeadlineAt` (request + 24 hours with healthy storage and no
hold; null while a listed hold blocks removal) from `backupExpiryDeadlineAt` (latest recorded
backup hold expiry). `deadlineReason` explains deferral; neither field promises immediate backup
erasure. Local Run artifacts are addressable only after publication; distributed in-flight worker
uploads and S3 version removal remain M4 scope.
Usage filters apply to immutable model-call totals; lifetime project reservations/budgets remain
separately labelled `lifetimeBudget`. Unknown tokens/costs stay unknown; money is grouped by
currency and scale. Reasoning/cache are disclosed components, not extra input/output charges.
`estimatedCosts` uses each call's frozen `priceTableVersion`; changing current prices never
revalues historical rows. `billedCosts` is empty and `billingReconciliation.status` is
`not_requested` until optional external reconciliation exists; divergence is unknown, not zero.
Older calls without recorded cost provenance appear in `unclassifiedCosts`, not billed totals.
Aborted/repair/cache-hit calls remain visible. Provider cached input and reasoning tokens are
components of input/output totals, not extra charges. File export excludes prompts and API keys.
Production approvals additionally freeze current credential metadata/privilege and effective
execution limits; rotation, changed limits/body/target or replay of a consumed approval refuses
execution rather than silently broadening authorization.

## Model-assisted path (experimental)

Model providers are declared only in the user profile `~/.config/testmaster/profiles.json` and allowed by the
operator policy `~/.config/testmaster/policy.json` (`allowedModelProviders`). A provider that is not in that
policy never receives a byte; there is no per-project, per-provider or per-data-class opt-in step beyond
it, and repository files cannot enable a provider. Credentials, secrets, environment values, private keys,
storage state and raw traces are never sent, and what is sent is minimised and redacted. A model without a
price table runs with its cost recorded as `unknown` unless a monetary project budget exists, in which case
the call is refused before it is sent because the ceiling could not be enforced. No token or monetary ceiling
applies unless you set one. The current live validation model is `qwen3.8-flash` on QuantForge, selected
explicitly by the operator. Provider availability is checked at execution time; configuring a model does not
establish generation quality.

```json
{
  "defaultProfile": "default",
  "profiles": {
    "default": {
      "modelProviders": [
        {
          "id": "quantforge",
          "kind": "openai-compatible",
          "baseUrl": "https://api.quantforge.com.br/v1",
          "apiKeyEnv": "TESTMASTER_MODEL_API_KEY",
          "models": [{ "id": "qwen3.8-flash", "capabilities": { "structuredJson": true, "toolCalls": true, "contextTokens": 128000, "maxOutputTokens": 8192 } }],
          "prices": {
            "qwen3.8-flash": { "currency": "USD", "scale": 6, "inputPerMillion": "150000", "outputPerMillion": "470000", "cacheReadPerMillion": "16000", "version": "models.dev alibaba/qwen3.8-flash 2026-10-07" }
          }
        }
      ]
    }
  }
}
```

Prices are per million tokens in integer minor units of `scale` decimal places (here USD with 6
places: `150000` is $0.15). They produce local estimates, not provider invoices; `cacheReadPerMillion`
applies only to cached input the provider reports. Without a price table the cost stays `unknown`.

To control reasoning effort, add `"reasoningEffort": "medium"` to the model entry
(alongside `id` and `capabilities`). Supported values: `low`, `medium`, `high`, `xhigh`, `max`.
When omitted, the provider default applies. TestMaster sends `reasoning_effort` only
when configured; it still omits token ceilings, sampling parameters and `enable_thinking`.

```bash
echo '{"allowedModelProviders":["quantforge"]}' > ~/.config/testmaster/policy.json
testmaster budget set --tokens 12000000                    # optional cumulative project token quota
testmaster source add PRD.md --role prd --format markdown
testmaster source add openapi.yaml --role api --format openapi
testmaster discover --scope codebase                      # or --scope diff --base <ref> --head <ref>; bounded receipt, --full for everything
testmaster requirement normalize --source-revision <svr-id> && testmaster requirement list
testmaster requirement approve <requirement-id> --expected-version <n>   # never automatic
testmaster requirement reject <requirement-id> --reason "Out of scope: CLI behavior" --expected-version <n>   # final; never planned
testmaster plan generate --type frontend --requirement <requirement-id>
testmaster plan get "$BATCH_ID"
testmaster plan accept "$BATCH_ID" --only <proposal-a>,<proposal-b> --expected-version <n>
testmaster test run "$TEST_ID" --mode agent --wait         # resolves flagged steps into typed actions
testmaster test run "$TEST_ID" --revision "$CANDIDATE" --wait   # deterministic replay of the candidate
testmaster test revision promote "$CANDIDATE" --expected-version <n>
testmaster usage                                           # model calls, tokens, budget; unknown cost stays unknown
```

Heal with a specific model using
`testmaster heal propose "$RUN_ID" --provider quantforge --model <id>`; without them the first
allowed provider's first structured-output model is used. `heal propose` refuses a failed Run
whose analysis says healing is not indicated (`healing_not_indicated`) before calling any model;
act on the analysis next step instead. When the model finds no safe test-only repair it prints
`Healing abstained (...)` and exits 0: that is a normal result, not a failure.

Exact flags: `testmaster <group> <command> --help`.

### What plan generation can use

`plan generate` (CLI, REST, MCP `testmaster_generate_plan`) offers the model only what already exists in the
project when it runs, so create these first:

- **Secrets** (`testmaster secret set ... --allowed-origin <origin>`): the model sees names and ids, never values,
  and may send one as a header `{"secretRef": "<id>"}`. A secret inside a JSON request body is bound with
  `body.set`: `{"kind":"json","value":{"user":"demo"},"set":[{"pointer":"/password","value":{"secretRef":"<id>"}}]}`.
  A `secretRef`/`variableRef` object nested in `body.value` is plain data and is refused.
- **Auth profiles** (`testmaster auth-profile create`): the model sees names, kinds and origins. A request to an
  endpoint that needs the session sets `"auth": "profile"`, and the runner applies the session of the profile
  bound to the environment to that request only. A proposal that sets `auth: "profile"` in a project with no
  auth profile is sent back to the model for repair.
- **API specifications** (`testmaster source add openapi.json --role api-spec`): the model sees, for every active
  OpenAPI/Swagger source, each operation (method, path, `operationId`) and the pointer of its JSON response schema
  per HTTP status, and a `jsonSchema` assertion may cite that source's revision id. The specification does not have
  to be normalized: normalize only the PRD to keep the requirements scoped to it, and the planner still reads the
  specification. An archived source (`source archive`) is no longer offered.

A secret, profile or specification created after generation is not retroactively added to existing proposals;
regenerate or edit the plan.

Generated browser plans must end with a positive check on rendered content (`visible`, `textContains`,
`textEquals`, `valueEquals` or `countEquals` above 0) after the last state-changing action (login, navigation,
click, submit). A URL check and the absence of the earlier elements also hold on a blank page, so a proposal that
stops there is refused as repair feedback (`browser_postcondition_missing`); the project-aware plan validation
(REST `POST /projects/{id}/plan-validations`, used by the portal editor) reports the same rule for hand-written plans.

### `jsonSchema` pointers

A `jsonSchema` assertion cites a source revision and a JSON pointer into the OpenAPI document. Accepted forms:

- inside one operation: `/paths/~1items/get/responses/200/content/application~1json/schema` (escape `/` as `~1`);
- a document-level schema: `/components/schemas/Item` (OpenAPI 3) or `/definitions/Item` (Swagger 2).

A schema that still holds recursive references is bundled so it validates on its own. An empty pointer, a
pointer outside `/paths`, `/components` and `/definitions`, or one that reaches nothing is unresolved: the project-aware
plan validation (`POST /projects/{id}/plan-validations`) reports `schema_pointer_unresolved` at the step, and the run would be blocked with
`unsupported_capability`.

## Third-party subresources and additional origins

A browser run may reach only the environment target. When the page loads something from another origin (a CDN
image, a web font, a flag service), the request is aborted. A passive subresource (`image`, `font`,
`stylesheet` or `media`, fetched with `GET`/`HEAD`) is dropped and recorded without failing the run, so a
passing test stays `passed` with `assertions_satisfied`. Any other denied request (script, `XHR`/`fetch`,
WebSocket, document, popup) ends the run `blocked/egress_denied`. A page WebSocket to the target origin
(`ws` maps to `http`, `wss` to `https`) or an additional origin is connected normally; one to any other origin is
closed and denied, naming its origin. `testmaster run analyze` names the denied origin.
Each denial is written once per origin and resource type to the `egress.denied` runner event and to
`logs/egress.ndjson`; only the origin is recorded.

```bash
testmaster env update "$ENV_ID" --expected-version 1 \
  --additional-origin https://flagcdn.com --additional-origin https://fonts.example.test
testmaster env update "$ENV_ID" --expected-version 2 --clear-additional-origins
testmaster env revisions "$ENV_ID"          # newest first; shows additionalOrigins per revision
```

`--additional-origin` replaces the whole list (`additionalOrigins` in the API; at most 32 exact `http(s)`
origins, no wildcard, path, query or credentials). Approving an origin lets page scripts and requests send data
there, so list only origins you trust. Additional origins are not target origins: no secret or auth profile
binds to them and a stored session is never replayed to them. Literal IPs and `localhost` must fit the network
profile; DNS names are classified when the proxy connects. The proxy reaches a private or loopback address for an
additional origin only like it does for the `baseUrl`: that exact host and port, and only inside the ranges the
network profile permits (`local-loopback` loopback, `private` private ranges; the `public` profile never reaches
either). Offline profiles ignore the list. Every change creates a new environment revision, so earlier approvals do
not apply.

## Selective reruns and read-only preview

```bash
testmaster test rerun "$TEST_ID" --preview --env local
testmaster test rerun "$RUN_ID" --wait                    # reproduces the Run's pinned revision/environment
testmaster test rerun "$TEST_ID" --revision "$REV_ID" --wait --env local
testmaster test rerun --diff --base HEAD~1 --head HEAD --preview --env local
testmaster test rerun --working-tree --wait --env local
testmaster test rerun "$CONSUMER_ID" --reuse-from-run "$PRODUCER_RUN_ID" --skip-dependencies --wait --env local
```

Producer closure is the default (`--chain` is explicit documentation of that default).
Preview performs no execution or admission writes and never consumes an approval or
exposes fixture values. Unmapped changes conservatively select all active tests.
Execution rejects an empty selection unless both `--allow-empty` and a nonempty
`--empty-reason` are supplied; an authorized empty batch is not a passed gate.
Active quarantine excludes directly selected tests, but required producers remain
in the closure. Explicit fixture reuse requires the exact passing producer revision,
environment/origin, compatible output/taint, unexpired output and live owned resources;
these checks run again before release. `--skip-dependencies` refuses incomplete reuse.
A Run ID reproduces that Run (same revision, environment revision and admission snapshot,
after verifying its evidence); `--env` re-admits the same revision in another environment.
Selection options (`--preview`, `--chain`, reuse, empty coverage) require test IDs or a diff.

## Code export and import

```bash
testmaster test export "$TEST_ID" --format playwright --out exported/   # or --format pytest
testmaster test import --path tests/login.spec.ts --format playwright --name login
```

Exported projects pin their dependencies and do not call TestMaster. Imported code is statically checked
(import allowlist, no runtime installs, no disabled timeouts, no empty assertions) and only ever executes
inside the sandbox.

An exported imported or generated Playwright project runs with `npm ci && npx playwright install chromium &&
BASE_URL=<target> npm test`: its `testmaster-fixtures/` package keeps the authored `@playwright/test` import
working and provides the `secrets`, `profileRequest` and `profilePage` fixtures. `secrets.get("NAME")` reads
the environment variable `SECRET_NAME`. The auth profile session of `profileRequest`/`profilePage` comes from
`TESTMASTER_PROFILE_STORAGE_STATE` (path of a Playwright storage-state file) and, for header credentials,
`TESTMASTER_PROFILE_HEADERS` (a JSON object such as `{"x-api-key":"..."}`); it is sent only to the `BASE_URL`
origin. `SETUP.txt` and `export-metadata.json` (`environment`) list the variables a given project reads.

An imported or generated Playwright test reads secrets only through the `secrets` fixture, for example
`headers: { authorization: secrets.get("API_KEY") }`, with a literal name. `process.env` and every other way
of reaching a value is refused when the code is imported. `test import` accepts the names of secrets you
registered with `testmaster secret set`; generated code may use the secrets whose `--allowed-origin` covers
the environment's origins (the model sees their names and ids, never a value). A secret that has been
removed blocks the Run with `missing_secret` before anything starts, and values never appear in logs or
reports. When code fails, the report shows Playwright's message with the failing line, plus the expected and
received values, and the analysis names the failing test instead of `unmapped`.

An environment bound to an auth profile gives code its session only on request: destructure `profileRequest`
(an authenticated `APIRequestContext`) or `profilePage` (a page with the profile's browser state) in the test
callback, for example `async ({ profileRequest }) => { await profileRequest.get("/v1/agents"); }`. The plain
`request` and `page` fixtures are never authenticated, so a test that expects a `401` from the same endpoint
keeps using them. The code never sees the cookie or token values, and they are scrubbed from every log and
report. A profile that sends a header credential (bearer token, API key) is applied to the environment's
origins only and its `profileRequest` calls do not follow redirects. Generation refuses a candidate whose plan
has `auth: "profile"` request steps but whose code uses neither fixture, and a run of code that uses them is
blocked (`missing_secret`) when the environment has no usable session.

## Agents: API, MCP and skills

```bash
testmaster server start --port 7331                 # loopback /v1 API, bearer token file 0600
testmaster token issue --token-file ~/.local/share/testmaster/mcp.token   # R,W,X token file; the token is never printed
testmaster mcp serve --transport stdio --root "$PWD" \
  --token-file ~/.local/share/testmaster/mcp.token   # MCP for coding agents; register this command in the agent
testmaster agent install --target claude             # preview; add --yes to apply
```

`token issue` works on the local profile only; repeating it for the same file reuses the token, and a
different `--scope` set needs another file. On a server profile, tokens come from `/v1/tokens` or the portal.

An agent with that token can run the whole pipeline through MCP without asking a person for anything:
`testmaster_bootstrap`, `testmaster_analyze_code`, `testmaster_add_source` (a file inside an approved root; an
invalid source is an error that lists its diagnostics), `testmaster_normalize_requirements`,
`testmaster_review_requirements` (edit, adjudicate conflicts, reject with a reason and approve at the snapshot `version`; it returns the
`sourceSnapshotId` that `testmaster_generate_plan` needs), `testmaster_set_secret` (the value comes from a file
inside an approved root or from an environment variable of the MCP process, never from an argument),
`testmaster_save_auth_profile` and `testmaster_update_environment` (`authRefs`, `additionalOrigins`). Create the
secrets and auth profiles before `testmaster_generate_plan`, because the model is offered only what already exists.
Every decision is recorded with the acting principal. `testmaster_review_plan` (accept or reject),
`testmaster_promote_revision` and `testmaster_approve_healing` take an optional `reason` (1-2000 characters), kept
with the reviewer and the time: on each decided proposal, on the test (and its history entry) and on the
healing proposal (`testmaster_review_healing` shows it). The CLI flag is `--reason` on `plan accept|reject`,
`test revision promote` and `heal approve`.

The same token covers authoring, execution and approvals. `testmaster_edit_plan` changes a still-proposed plan
at the proposal's `expectedVersion` and reports `batchVersion`, the version `testmaster_review_plan` takes (every
edit raises it); `testmaster_save_test` stores a plan as a new test (`projectId`) or as a new candidate
revision (`testId`), and its receipt says that the candidate is not active yet and which calls replay and promote
it. `testmaster_run_tests` with `revisionId` replays that exact revision of one test, and
`testmaster_promote_revision` (at the test's `expectedVersion`) makes it active; a generated candidate needs a
passing replay first. `testmaster_save_suite` creates a list or adds and removes members at its
`expectedVersion`. When a production run is refused with `approval_required`, copy `details.binding` into
`testmaster_approve_execution`, add a reason and repeat the run: the approval is single use and recorded with
the acting principal. `testmaster_get_evidence` reports `staleReasons` next to `freshness`; a candidate
revision's own run is current until it is superseded. A generated candidate still counts only after a passing
deterministic replay.

Agent skill files are written atomically inside managed markers, with backups under
`.testmaster/agent-backups/`; edited managed blocks are reported as drift, never overwritten.

## Not available in M0–M2

Healing, run comparison, CI integration, suites, schedules, tunnels, server multi-user mode, PostgreSQL
runtime, web UI and later features return `CAPABILITY_UNAVAILABLE` (exit 8 / HTTP 422) with their
milestone. `testmaster capabilities` lists every feature and its state.
