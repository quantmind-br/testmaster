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
testmaster artifact get "$RUN_ID" --out .testmaster/failure                     # evidence bundle copy, hash-checked
testmaster report export "$RUN_ID" --format junit --out report.xml              # json|markdown|html|junit|allure
# fix the application outside TestMaster, then replay the same revision
testmaster test rerun "$TEST_ID" --wait --output json
```

`--type cli` scaffolds a terminal-runner plan for a command-line or TUI program; see [Terminal tests](terminal-tests.md).

`artifact get` has no integrity flag in its JSON: it succeeds only when every entry it could read matches its manifest
hash (a mismatch fails with `BUNDLE_INTEGRITY_ERROR`), but an entry that is expired, missing or truncated is not
copied, and that is not a failure. Read completeness in `data.manifest.entries[].state` (`available` or not); MCP
`testmaster_get_evidence` reports `integrity` and the partial state directly.

`testmaster init` writes `testmaster.config.json` in the working directory and binds that directory to the
project. Run again in the same workspace, it keeps an existing file (unless `--overwrite`) and writes an absent
one for the same project, with its default environment's origin; `configWritten` in the receipt says which.
TestMaster's own files (`testmaster.config.json`, `.testmaster/`) never make a run's checkout `working-tree-dirty`.

- `--output json` (or `--json`) prints exactly one JSON envelope on stdout; diagnostics go to stderr.
  A long-running command (`server start`, `backup agent`) prints its receipt envelope as soon as it is running; if
  it then fails, a second envelope with the `error` follows on stdout and the exit code is set. Only your own
  interruption (Ctrl-C, SIGTERM) ends it without an error envelope.
- Exit codes follow `specs/05-cli-mcp.md` §3 (0 passed, 1 failed gate, 6 precondition, 7 wait deadline,
  8 capability unavailable, 9 policy/sandbox denied, 15 run blocked by policy, 130/143 interrupted).
- `test run --wait` without a running worker makes the CLI the ephemeral owner; Ctrl-C cancels durably.
  `--timeout` and `--request-timeout` never end that run: the wait continues until the run completes or
  Ctrl-C, and the command prints a warning. With a running worker they bound only the wait (exit 7, the run
  continues). With `testmaster worker start` running, the CLI only waits and Ctrl-C detaches unless
  `--cancel-on-interrupt` is given. Without a worker and without `--wait`, admission is refused.
- `test run --step-timeout <seconds>` (MCP `limits.stepTimeoutMs`, REST `limits.stepTimeoutMs`) caps every step of
  that run: a step stops at the least of its own `timeoutMs` and the requested value, so the flag shortens
  steps and never lengthens one. Without it, `execution.stepTimeoutMs` of the project config only fills steps
  that declare no timeout (saved plans stamp it on every step). The applied limits are recorded on the run
  (`matrixCell.limits`, `matrixCell.stepTimeoutCapMs`) and in the evidence manifest's `executionSnapshot`.
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
summaries and bounded measurements cross that boundary, including the text, acceptance criteria and
review state of the requirements the failed test maps to, not raw
trace/video, screenshots, DOM or HTML, or sensitive captures: the model reads no image, so a cause
visible only in a screenshot stays `cause_unknown`. Choose the model with `--provider ID --model-id ID`; an unknown
choice is refused before any work. Model refusal/failure retains the factual predecessor and records a
limitation in a separate immutable analysis that stays `source: "rules"` (it never claims to be model
output). Identical requests reuse their stored receipt; interrupted paid calls are not reissued. A
reading that ended before anything was sent (missing key, undeclared model, busy compute slots, or a
local database writer busy with another process before the paid call started) is not final: the next
request reaches the model.

The model never changes a cause the rules derived from observed evidence. One exception only lowers it:
when a failed assertion made the rules say `product_bug` and the model reports that the observation
agrees with an approved requirement the test maps to (`requirementAgreement`: requirement id and
acceptance criterion), TestMaster checks the claim against the supplied requirements and, if it holds,
records `failureKind: unknown` instead, puts a "review the test's expectation against that requirement
and criterion" step first, keeps healing not indicated and adds a limitation naming the requirement.
A claim about an unmapped, not approved or out-of-range requirement, or about a cause that is not
`product_bug`, is not recorded and the limitation says why.

Reports preserve execution outcomes even when evidence is missing, expired or fails integrity:
the affected member has `evidenceState: "unavailable"`, null snapshot/manifest and explicit
`evidenceErrors`; report completeness becomes partial and cannot approve a strict CI gate.
Latest diagnosis is enrichment, never a replacement verdict. Applications exporting multiple
formats should capture `reports.snapshot(id)` once and pass it to `reports.exportCaptured`.
CI exports use `artifacts.exportSanitized(runId, outDir)`: restricted raw entries are omitted
with source snapshot/hash provenance, not relabelled as redacted. Original bundles are immutable.
When the CI wait limit (`timeoutMs`, default 31 minutes) expires on runs a worker executes, the exported
report stays partial with `ci-wait-deadline-exceeded`; those runs are not cancelled and keep running. With
no live worker, `ci run` executes the runs itself and waits with no limit: only an interrupt cancels them,
and a given `timeoutMs` produces a warning. JSON and JUnit remain non-approving for a partial report.
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
Usage filters apply to immutable model-call totals; the ledger's reservation counts by state are reported
separately as `reservations`. Unknown tokens/costs stay unknown; money is grouped by
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
price table runs with its cost recorded as `unknown`. No token or monetary ceiling exists: a model call is
never refused for what was already used. The current live validation model is `qwen3.8-flash` on QuantForge, selected
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
testmaster source add PRD.md --role prd --format markdown
testmaster source add openapi.yaml --role api --format openapi
testmaster discover --scope codebase                      # or --scope diff --base <ref> --head <ref>; bounded receipt, --full for everything
testmaster requirement normalize --source-revision <svr-id> && testmaster requirement snapshot   # version, statuses, conflicts
testmaster requirement adjudicate <conflict-id> --selected-requirement <requirement-id> --reason "PRD wins" --expected-version <snapshot-version>
testmaster requirement approve <requirement-id> --expected-version <n>   # never automatic
testmaster requirement reject <requirement-id> --reason "Out of scope: CLI behavior" --expected-version <n>   # final; never planned
testmaster plan generate --type frontend --requirement <requirement-id>
testmaster plan get "$BATCH_ID"
testmaster plan trial "$BATCH_ID" --env staging              # replay the proposals before review, no model call
testmaster plan accept "$BATCH_ID" --only <proposal-a>,<proposal-b> --expected-version <n>
testmaster test run "$TEST_ID" --mode agent --wait         # resolves flagged steps into typed actions
testmaster test run "$TEST_ID" --revision "$CANDIDATE" --wait   # deterministic replay of the candidate
testmaster test revision promote "$CANDIDATE" --expected-version <n>
testmaster usage                                           # model calls, tokens, reservations; unknown cost stays unknown
```

`testmaster bootstrap --target-url <url> [--root <directory>] [--scope codebase|diff] [--mode replay|agent]` is the
CLI of MCP `testmaster_bootstrap`: it creates or finds the project bound to a root inside the workspace directory
(the workspace directory by default; a root outside it is `FORBIDDEN`), adds an environment for the target origin
when the project has none, and prints `projectId`, a proposed `testmaster.config.json`, the environment, a
preflight and next actions. It is idempotent per root, never writes a file (write `proposedConfig` yourself) and
never sends a request to the target; an environment aimed at another origin is reported with the `env update`
command, never retargeted.

`testmaster job get|wait|cancel <id>` reads the durable jobs behind the model operations: `job_` ids (analysis,
healing, normalization, delivery) and `dsc_` ids (discovery, exploration). A batch id (`bat_`) is followed with
`run wait` and `report export`. `job get` prints the kind, state and, once the job ended, its stored result.
`job wait` blocks with no deadline (a model call has none; `--request-timeout` does not apply) and exits 0 when the
job completed and 1 when it was cancelled, failed or needs settlement; Ctrl-C detaches and never cancels it.
`job cancel <id> --reason <text>` asks the job to stop and prints its state: a request is not a stop, so confirm
with `job get` that the state is `cancelled`. A queued auxiliary job is cancelled at once and a running exploration
is stopped by the process that runs it; a job a process holds (a running analysis or healing call, which may
already be billed and stops only through its own caller's cancellation) is refused with `PRECONDITION_FAILED` and
left untouched.

Heal with a specific model using
`testmaster heal propose "$RUN_ID" --provider quantforge --model <id>`; without them the first
allowed provider's first structured-output model is used. `heal propose` refuses a failed Run
whose analysis says healing is not indicated (`healing_not_indicated`) before calling any model;
act on the analysis next step instead. That is always the case when the failed step is an
assertion: healing replaces locators of action steps only, and an assertion's locator names what
it checks, so correct it in a new revision. It also refuses a failed Run of a revision that is not the
test's active revision (`revision_not_active`) before calling any model: healing derives its
candidate from the active revision, so save a corrected revision and replay it
(`test revision create`, `test run --revision`), or promote that revision and heal a failed Run of
the active one. When the model finds no safe test-only repair it prints
`Healing abstained (...)` and exits 0: that is a normal result, not a failure.

`plan trial` replays each still-proposed plan of the batch against the environment exactly like a replay run,
before anyone accepts it and without calling a model. A wrong JSON pointer or value then shows as a failed step with
its expected and observed values (`check-total failed assertion_mismatch: expected 4, observed null - ... missing JSON
pointer: /results/0/value`), so you fix the proposal with `plan edit` and try again, instead of finding a false failure
after acceptance. That includes a locator that matches nothing or the wrong element: edit it in the proposal. Healing
(`heal propose`) only repairs a failed Run of a test's active revision, so it cannot fix a proposal that was never
accepted. A failure the requirement predicts is a product defect: keep that plan. Trial runs belong to a
hidden test per proposal that no listing, suite, selection, coverage or feature map shows and that `test run` cannot
run; accepting the proposal creates the real test. MCP: `testmaster_trial_plan {batchId, environmentId,
proposalIds?}`. A review receipt (`plan accept`, `plan reject`, MCP `testmaster_review_plan`) and
`testmaster_edit_plan` return `batchVersion`, the `expectedVersion` of the next review of the batch (for example a
second group of proposals with another reason).

A plan that creates a resource and deletes it in `cleanup` must let the runner prove the resource is its own: the
creating request step sets `input.resource` with `handle` (JSON pointer to the new id in the creation response) and
`ownerProof` (JSON pointer to a field proving the run's account owns it, such as the creator or tenant id), and the
cleanup deletes `{"variableRef": "<step id>.handle"}`. Without both pointers the runner never sends the cleanup and
never binds `<step id>.handle`, so the declared cleanup leaves the resource orphaned and the gate fails. Generation,
`plan edit`, `plan trial`, the plan validation route, `testmaster_validate_document`, `contract validate`,
`testmaster_save_test`, `test create` and `test revision create` refuse such a plan (`cleanup_never_runs`, and
`handle_not_captured` for a reference to a handle that is never bound). Generated cleanup paths get the
specification's server path prefix (`basePath` or the server URL path) like request paths.

Data that a browser step creates (a form that adds a project) has no creating request step to declare
`input.resource`. Its `cleanup` entry carries `find` instead and `resourceRef` names the plan step that creates the data:

```json
{
  "resourceRef": "submit-project",
  "operation": "request",
  "find": {
    "resourceType": "project",
    "lookup": { "method": "GET", "pathSegments": [{ "literal": "api" }, { "literal": "projects" }], "auth": "profile" },
    "itemsPointer": "/items",
    "keyPointer": "/name",
    "equals": { "variableRef": "project_name" },
    "handlePointer": "/id",
    "ownerProofPointer": "/ownerId",
    "totalPointer": "/total"
  },
  "input": { "method": "DELETE", "pathSegments": [{ "literal": "api" }, { "literal": "projects" }, { "variableRef": "submit-project.handle" }], "auth": "profile" },
  "successPredicate": { "predicate": "statusIn", "values": [200, 204, 404] },
  "deadlineMs": 10000,
  "required": true
}
```

The runner runs the lookup (GET only, no body, capture or resource) at cleanup time, before the cleanups of
request-created resources, and deletes only when exactly one item's `keyPointer` equals `equals` (a scalar, never
sensitive, compared strictly by type) and the item carries a non-empty `handlePointer` and `ownerProofPointer`.
No match deletes nothing and passes: nothing was created. Two or more matches fail the cleanup and nothing is deleted
(never the first of several). A match without handle or ownerProof, a lookup that does not answer 2xx with a JSON array at
`itemsPointer`, and a paged list (`totalPointer` above the items returned, or a `Link` header with `rel="next"`) end the
cleanup `inconclusive`, so a gate fails rather than reading a partial list as "nothing created". A match is recorded as a
resource like a request-created one, so a deletion that fails is listed orphaned and can be compensated with
`resource cleanup`. Give the data a name unique to the run (a captured or dependency value in `equals`): the lookup deletes
whatever one item carries that name, including a leftover of an earlier run. Validation refuses a non-GET lookup, a
lookup with a body, capture or resource, a `variableRef` no step captures (or the entry's own `<resourceRef>.handle`),
a sensitive `equals`, an empty `handlePointer`/`ownerProofPointer`, and a `resourceRef` that names no step or a request that
declares `input.resource`; code export refuses a plan with `find`.

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
  bound to the environment to that request only, in an HTTP plan and in a request step of a browser plan alike. A
  proposal that sets `auth: "profile"` in a project with no auth profile is sent back to the model for repair.
  An HTTP plan keeps no cookie jar: a cookie one response sets is not sent by the next request, so a preference
  the site remembers in a cookie is tested with a browser plan.
- **API specifications** (`testmaster source add openapi.json --role api-spec`): the model sees, for every active
  OpenAPI/Swagger source, each operation (method, path, `operationId`) and the pointer of its JSON response schema
  per HTTP status, and a `jsonSchema` assertion may cite that source's revision id. The specification does not have
  to be normalized: normalize only the PRD to keep the requirements scoped to it, and the planner still reads the
  specification. An archived source (`source archive`) is no longer offered.

A secret, profile or specification created after generation is not retroactively added to existing proposals;
regenerate or edit the plan.

Generated browser plans must end with a positive check on rendered content (`visible`, `textContains`,
`textEquals`, `valueEquals`, `countEquals` or `countAtLeast` above 0) after the last state-changing action (login, navigation,
click, submit). A URL check and the absence of the earlier elements also hold on a blank page, so a proposal that
stops there is refused as repair feedback (`browser_postcondition_missing`); the project-aware plan validation
(REST `POST /projects/{id}/plan-validations`, used by the portal editor) reports the same rule for hand-written plans.

A negative check (`hidden`, `countEquals` 0, `countAtMost` 0, `waitFor` hidden or detached) also passes while the page is still blank,
so it may not directly follow a page load. After a `navigate`, or a click or key press that submits a form or is
followed by a URL assertion (`urlEquals` or `urlMatches`), put a required positive assertion on content of the destination page (or a
`waitFor` visible) before it; for a login: submit, URL check, a visible element of the authenticated page, then the
checks that the login fields are hidden. `test lint`, `test create`, `testmaster_save_test`, `testmaster_edit_plan`,
`testmaster_validate_document` and proposal generation refuse the plan with `negativeBeforeRender` at the negative
step (`negative_before_render` as repair feedback); plans already stored keep running.

### URL assertions

`urlEquals` compares the whole page URL, query included; a path (`/dashboard`) resolves against the environment base
URL. When the destination carries a query that is not fixed (a `return_to` parameter) or only the path matters, use
`urlMatches` with an unanchored ECMAScript pattern (flag `u`) tested against the full URL:

- `{"predicate": "urlMatches", "pattern": "/login(?:[?#]|$)"}` passes on `/login` and `/login?return_to=%2F`;
- `{"predicate": "urlMatches", "pattern": "^(?!.*/login(?:[?#]|$))"}` passes once the page has left `/login`, wherever it went.

Keep the origin out of the pattern so the plan runs against every environment. Both URL predicates belong to browser
(`playwright`) plans; an HTTP plan asserts a redirect with `statusIn` and `headerMatches` on `Location`.

### The nth item of a list

A locator that matches more than one element fails as ambiguous: the runner never picks one silently. When the target
is genuinely the n-th of several identical elements (the second of two identical buttons, one row of a list), add
`nth`, a 0-based index applied last, after `container`, `frame` and `pageAlias`:

- `{"by": "role", "role": "button", "name": "Delete", "exact": true, "nth": 1}` acts on the second Delete button.

The runner takes that one match and skips the ambiguity check; an index past the last match never attaches and fails
with `assertion_timeout` like a missing element. Do not use `nth` to hide an ambiguity that a name, label, test id or
container would resolve: the index silently retargets when the list changes, so healing never repairs or replaces a
locator that carries `nth`. A count predicate (`countEquals`, `countAtLeast`, `countAtMost`) refuses a locator with `nth`
(`nthCount`), because one match is always a count of 0 or 1: count the unscoped locator, or put `nth` on its
`container`. Exported Playwright and pytest code applies `.nth(n)` last.

### Text of a response

`textEquals` and `textContains` with `responseStepId` (and no `jsonPointer`) read the whole response body as UTF-8
text, on an HTTP plan or a browser plan's request step. Use them for answers that are not JSON: a health check that
returns `OK`, a `robots.txt` line, a CSV header row:

```json
{"id": "csv-header", "kind": "assertion", "operation": "assert", "description": "CSV starts with its header row",
 "input": {"responseStepId": "search-csv"},
 "expectation": {"predicate": "textContains", "value": {"literal": "title,url,content"}}}
```

A body that is not valid UTF-8 fails the check. A value inside a JSON body stays `jsonEquals` with a `jsonPointer`. A
response check does not observe the page, so a browser plan still needs a locator check of the rendered result.

### Nodes of an XML response

An XML answer (RSS, Atom, OpenSearch, a SOAP or sitemap document) is checked node by node with `input.xmlPath`
instead of `jsonPointer`. The path is absolute: element names separated by `/` (a child) or `//` (any descendant),
`*` for any element, `[n]` for the n-th matching sibling, and an optional last step `@name` or `@*` for attributes.
Names match by local name, so `/rss/channel/totalResults` and `/rss/channel/os:totalResults` select the same node
whatever namespace the document declares.

```json
{"id": "four-items", "kind": "assertion", "operation": "assert", "description": "The feed lists four results",
 "input": {"responseStepId": "search-rss", "xmlPath": "/rss/channel/item"},
 "expectation": {"predicate": "countEquals", "value": 4}}
```

`countEquals`, `countAtLeast` and `countAtMost` count the selected nodes; `textEquals` and `textContains` compare the
text of the first one (all its descendant text, entities decoded), so `"/OpenSearchDescription/ShortName"` with
`textEquals "SearXNG"` checks the engine name. A path that selects nothing fails the check, and so does a body that is
not well-formed XML. A DOCTYPE with an internal subset is refused and entities are never expanded. Code generated or
imported for such a test reads the body with the `xml` fixture: `xml.select(await response.text(), path)` returns the
same `{count, text}`.

### `jsonSchema` pointers

A `jsonSchema` assertion cites a source revision and a JSON pointer into the OpenAPI document. Accepted forms:

- inside one operation: `/paths/~1items/get/responses/200/content/application~1json/schema` (escape `/` as `~1`);
- a document-level schema: `/components/schemas/Item` (OpenAPI 3) or `/definitions/Item` (Swagger 2).

A schema that still holds recursive references is bundled so it validates on its own. An empty pointer, a
pointer outside `/paths`, `/components` and `/definitions`, or one that reaches nothing is unresolved: the project-aware
plan validation (`POST /projects/{id}/plan-validations`) reports `schema_pointer_unresolved` at the step, and saving the
plan as a test or revision, or editing a proposal with it, is refused with the same reason code. `validate_document`
checks the contract only and does not resolve pointers.

A pointer that resolves to a schema the validator cannot compile (for example an unknown keyword) is reported before the run: plan validation returns `schema_uncompilable` at the step with the compile error, and saving the plan is refused with `source_schema_uncompilable`. Schemas that list `required` names only inside `not`, `anyOf`, `oneOf`, `allOf` or `then` compile and validate normally.

Archiving a source (`source archive`, `testmaster_archive_source`) removes it from plan generation and operation coverage, but its revisions stay readable: a `jsonSchema` assertion that cites one keeps resolving and running.

### Inline schemas (`jsonConforms`)

A `jsonSchema` assertion verifies only what the cited schema declares. When the specification leaves a field untyped (an
object with `additionalProperties: true`, list items `{}`) or a criterion states a bound it does not, write the criterion
as an inline JSON Schema (draft 2020-12, validated by Ajv's 2020 validator, so `prefixItems`, `const`, `contains` and
`$defs` work) instead of adding a source:

```json
{
  "id": "manifest_fields",
  "kind": "assertion",
  "operation": "assert",
  "description": "manifest_version is an integer of at least 1 and ui is an object",
  "input": { "responseStepId": "get_manifest" },
  "expectation": {
    "predicate": "jsonConforms",
    "schema": {
      "type": "object",
      "required": ["manifest_version", "ui"],
      "properties": { "manifest_version": { "type": "integer", "minimum": 1 }, "ui": { "type": "object" } }
    }
  }
}
```

`input.jsonPointer` narrows the check to one value, like `jsonEquals`. Plan validation compiles the schema and refuses one
that does not compile or is empty. Write only what the approved criteria say, never a shape copied from a response. The
step does not count toward operation coverage, and `test export` refuses it (exported code has no JSON Schema validator).
Operation coverage counts an operation's response only when a passed `jsonSchema` step of a declarative plan checked it
with a `statusIn` of the same status; code revisions (exported or authored Playwright, Python) carry no plan steps and
never count, even when their own code validates the schema. Route coverage likewise lists the targets of `navigate`
steps of declarative browser plans that ran: the navigation a code revision makes is not recorded, so code tests never
add routes to it.

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

#### Ignored origins

Some pages load a third-party script you never want a test to reach, such as a payment widget. List it as an
ignored origin instead of an additional one:

```bash
testmaster env update "$ENV_ID" --expected-version 3 --ignored-origin https://js.stripe.com
testmaster env update "$ENV_ID" --expected-version 4 --clear-ignored-origins
```

`--ignored-origin` replaces the whole list (`ignoredOrigins` in the API and MCP; at most 32 exact `http(s)`
origins, no wildcard, path, query or credentials, disjoint from the `baseUrl` and the additional origins). A
request to an ignored origin is aborted before it leaves the browser, whatever its type (script, `fetch`, XHR,
document, WebSocket), and recorded as an `egress.denied` event with disposition `ignored` and reason
`origin_ignored` in `logs/egress.ndjson`. It never fails the run, so a plan or imported test that only reaches
that origin through a script that is allowed to fail passes. Nothing is sent to the origin: it is never added to
the allowlist, and the list applies under every network profile, offline ones too. A request whose URL cannot be
read unambiguously is never ignored; it stays a fatal denial.

Without the entry, an unapproved script is a fatal denial (`blocked/egress_denied`); only passive images, fonts,
stylesheets and media are aborted without failing the run. Imported Playwright and pytest code follow the same
rule through the pages of the `page` and `context` fixtures. A context a test builds itself with
`browser.newContext()`, and the `request` fixtures, rely on the egress proxy alone: they cannot reach an
unapproved origin, but they are neither ignored nor reported by origin.

The proxy also removes the forwarding and proxy headers a page or runner request carries (`X-Forwarded-*`,
`Forwarded`, `Via`, `Proxy-*`) before the request reaches the target, like a reverse proxy that drops
client-supplied forwarding headers, and records only their names (`removedHeaders` on the `allow` entry of
`logs/egress.ndjson`). A target that trusts a header such as `X-Forwarded-Email` from its own proxy therefore never
sees it from a test; sign in through an auth profile instead. Plan validation refuses a request header with one of
these names, and the HTTP runner refuses an auth-profile header with one when it sends the request.

### Server log

A 500 says only that the server failed; the reason is in the application's own log. When the application runs in a
docker container on the same host, an environment can opt in to reading that log:

```bash
testmaster env update "$ENV_ID" --expected-version 3 --server-log-container searxng-tm-app
testmaster env update "$ENV_ID" --expected-version 4 --clear-server-log
```

Each attempt then stores the lines the container wrote while the runner ran (`docker logs --since/--until`, both
streams in timestamp order, at most `limits.logBytes`, the newest kept) as the evidence `logs/server.log`, with secrets
masked like every other artifact: the attempt's secrets, the host's secret-named environment variables and the
default patterns. TestMaster never writes to the container and passes the name only after checking docker's name
grammar. A log that cannot be read (no such container, no docker) is stored as one `testmaster: server log
unavailable` line with the reason and never changes the outcome. `testmaster run analyze` cites the error lines
written while the failed step ran (tracebacks, `…Error:`/`…Exception:` lines, `ERROR`, `CRITICAL`, `FATAL`, `panic:`);
a required `statusIn` assertion that saw a 5xx while the log recorded such a line becomes a `product_bug` with the
line in the hypothesis. The container's log is shared by every run against it: when another run of an environment
reading the same container had an attempt overlapping this one (`concurrency` above 1), the analysis names those runs,
adds a limitation and attributes no line to this run, so it never concludes `product_bug` from the log. Set
`execution.concurrency` to 1 in `testmaster.config.json` when the log should explain each failure. The CLI reads the
file on every command; a running `testmaster mcp serve` or `testmaster worker start` read it when it started, so
restart the worker and the MCP server (in an agent, reload its MCP connection) after the edit. MCP:
`testmaster_update_environment {serverLog: {kind: "docker", container}}`, `null` stops it.

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

To attach hand-corrected code to a test that already exists, give `--test`:

```bash
testmaster test import --test "$TEST_ID" --path tests/login.fixed.spec.ts --format playwright
testmaster test import --test "$TEST_ID" --parent "$REVISION_ID" --path tests/login.fixed.spec.ts --format playwright
```

The code goes through the same checks and becomes a new revision of that test (origin `imported`), never the
active one: runs keep using the active revision until you promote it. Like `test revision create`, the receipt
says `active: false` and gives the exact `testmaster test revision promote <revisionId> --expected-version <n>`
command (stderr in text mode). `--parent` (only with `--test`) names the revision the candidate descends from;
it defaults to the test's active revision, so a fix of a generated or plan revision keeps its lineage, and a
revision of another test is refused. `--name` belongs to a new test and is refused together with `--test`.
Over MCP, `testmaster_import_code` does the same with `{projectId | testId, path, format, name?, parentRevisionId?}`:
the path must be inside the project root, a refusal of the code is `INVALID_ARGUMENT` naming the rule and the line,
and a candidate's result lists the `testmaster_run_tests` (with `revisionId`) and `testmaster_promote_revision`
calls. Code imported as a revision of a test may check a response with
`sourceSchemas.violations(sourceRevisionId, pointer, value)` against the schemas that test's plan cites in
`jsonSchema` assertions, as generated code does; any other schema is refused. Every `expect()` takes an observed
value, never a literal: `expect([403, 404]).toContain(status)` is refused, and
`expect(String(status)).toMatch(/^(403|404)$/)` accepts either value.

Code generation runs over MCP only. `testmaster_generate_tests` writes Playwright candidates from accepted proposals
(`proposalIds`) or plan revisions (`revisionIds`). When a candidate fails its run, pass that run alone
(`{runId}`) to repair it instead of regenerating from the plan, which tends to repeat the same mistake. The model gets
the candidate's files, the plan it was generated from and the run's failed steps (error, expected, observed, with
secret values masked), and must keep every assertion of the plan; when the failure is the product's, the assertion
stays. The importer checks the answer like any generated code, and the repaired candidate is a child of the failed one
whose receipt entry carries `repairedFromRunId`. A passed or unfinished run, or a run of a plan revision (heal those
with `testmaster_propose_healing`), is refused before any model call.

An exported imported or generated Playwright project runs with `npm ci && npx playwright install chromium &&
BASE_URL=<target> npm test`: its `testmaster-fixtures/` package keeps the authored `@playwright/test` import
working and provides the `secrets`, `profileRequest`, `profilePage`, `sourceSchemas` and `xml` fixtures. `secrets.get("NAME")` reads
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
received values, and the analysis names the failing test instead of `unmapped`. A failed test that used the
`page` or `profilePage` fixture also leaves a screenshot and a DOM snapshot of its page in the run's evidence
(`browser/code/imported-test-N-failure.png` and `.html`), protected like the declarative runner's: fields,
images and every secret value are blacked out or removed. A passed test leaves none, and a capture that cannot
be taken is a warning in the logs, never a change of verdict. Each step of a code run also records the title the
test framework gave it (the test title for `imported-test-N`, `expect.toHaveURL` or the name of a `test.step`
for `imported-step-N`, the pytest node id or step name for Python), cut at 500 characters and redacted like every
runner event. `testmaster run steps <id>` and the MCP `testmaster://runs/{id}/steps` resource show it as `title`,
and the analysis quotes it: `Step imported-step-3 (playwright_step: expect.toHaveURL) failed: ...`.

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

Register the server with the client's request timeout turned off. A model call has no deadline, so
`testmaster_normalize_requirements`, `testmaster_generate_plan`, `testmaster_generate_tests`,
`testmaster_analyze_run` and `testmaster_propose_healing` can take minutes, and a client that gives up
first cancels the call: the server aborts the model call, and a cancellation after the request was sent
leaves the analysis reading stored as an abstention and the Run's healing request final. In omp, set `"timeout": 0` on the server entry of
`mcp.json` (the default is 30 s; `OMP_MCP_TIMEOUT_MS=0` does the same for every server). Start the server in the
initialized repository, or pass `--cwd <repository>` before `mcp serve` (`testmaster --cwd <repository> mcp
serve ...`): the workspace is the directory the command runs in.

An agent with that token can run the whole pipeline through MCP without asking a person for anything:
`testmaster_bootstrap`, `testmaster_analyze_code`, `testmaster_add_source` (a file inside an approved root; an
invalid source is an error that lists its diagnostics), `testmaster_normalize_requirements`,
`testmaster_review_requirements` (edit, adjudicate conflicts, reject with a reason and approve at the snapshot `version`; it returns the
`sourceSnapshotId` that `testmaster_generate_plan` needs), `testmaster_set_secret` (the value comes from a file
inside an approved root or from an environment variable of the MCP process, never from an argument),
`testmaster_rotate_secret` (a new value for a secret whose name is taken: names are unique in the workspace, and
`testmaster_set_secret` refuses a taken one with `details.secretId`),
`testmaster_save_auth_profile` and `testmaster_update_environment` (`authRefs`, `additionalOrigins`, `ignoredOrigins`). Create the
secrets and auth profiles before `testmaster_generate_plan`, because the model is offered only what already exists;
it is told which secrets each auth profile binds to which role, so a browser login fills the profile's account.
Every decision is recorded with the acting principal. `testmaster_review_plan` (accept or reject),
`testmaster_review_requirements` (edits and approvals; rejections and conflict decisions already carry their own
reason), `testmaster_promote_revision` and `testmaster_approve_healing` take an optional `reason` (1-2000
characters), kept with the reviewer and the time: on each decided proposal, on each edited or approved
requirement (`testmaster://requirements/{projectId}` shows it), on the test (and its history entry) and on the
healing proposal (`testmaster_review_healing` shows it). The CLI flag is `--reason` on `plan accept|reject`,
`requirement approve|update`, `test revision promote` and `heal approve`. The `testmaster_review_plan` receipt
lists `acceptedProposals`, one `{proposalId, testId, revisionId}` per accepted proposal, so no tests listing is
needed to tell which proposal produced which test.

The same token covers authoring, execution and approvals. `testmaster_edit_plan` changes a still-proposed plan
at the proposal's `expectedVersion` and reports `batchVersion`, the version `testmaster_review_plan` takes (every
edit raises it); `testmaster_save_test` stores a plan as a new test (`projectId`) or as a new candidate
revision (`testId`), and its receipt says that the candidate is not active yet and which calls replay and promote
it. `testmaster_run_tests` with `revisionId` replays that exact revision of one test, and
`testmaster_promote_revision` (at the test's `expectedVersion`) makes it active; a generated candidate needs a
passing replay first. `testmaster_archive_test` archives a test at its `expectedVersion` (history and evidence
stay; there is no unarchive) with an optional `reason`, kept on the test with the actor and the time
(`test archive --reason`, `DELETE /v1/tests/{id}` with a `{reason}` body). `testmaster_archive_source` archives a
source at its `expectedVersion` like `source archive`: an archived API specification is no longer offered to plan
generation nor counted in operation coverage, and a new revision of it through `testmaster_add_source` reactivates
it. `testmaster_save_suite` creates a list or adds and removes members at its
`expectedVersion`. When a production run is refused with `approval_required`, copy `details.binding` into
`testmaster_approve_execution`, add a reason and repeat the run: the approval is single use and recorded with
the acting principal. `testmaster_get_evidence` reports `staleReasons` next to `freshness`; a candidate
revision's own run is current until it is superseded. A generated candidate verifies requirements only after a
passing deterministic replay and its promotion to the test's active revision (reports list it as a candidate
until then); a test has one active revision, so a promoted code revision is repaired with `testmaster_save_test`,
not healing.

`testmaster_generate_plan` returns the batch without its proposals plus `resource`
(`testmaster://plan-batches/{batchId}`): read the proposals there. A healing proposal is decided with
`testmaster_approve_healing` or `testmaster_reject_healing` (`proposalId` and a required `reason`, like
`heal reject --reason`; nothing is applied and the reason stays on the proposal) after `testmaster_review_healing`.
Artifact and code-file resources take the path with plain slashes
(`testmaster://runs/{id}/artifacts/browser/steps/x.json`, `testmaster://revisions/{id}/code/tests/a.spec.ts`)
or with each slash encoded as `%2F`; both read the same bytes.

Agent skill files are written atomically inside managed markers, with backups under
`.testmaster/agent-backups/`; edited managed blocks are reported as drift, never overwritten. The skill is
a tree (`SKILL.md` plus the files below it, such as `references/*.md`) installed into the agent's skill
directory with a `.testmaster-manifest.json` recording the SHA-256 and size of every installed file. The
preview (`plan.files` in the JSON envelope) lists each file as `create`, `update`, `unchanged`, `remove` or
`keep`; install refuses a reference file edited since installation and names it, and `remove` deletes the
files that still match, keeps an edited one and reports it, and removes the directories it emptied.

The installed skill is version 2.4.0 and documents one route, the CLI, for agents with a shell: `SKILL.md` (authority, the commands that read state, the nine-step pipeline, exit codes, the three inviolable rules, an index) and `references/` (pipeline, plan authoring, evidence, auth and secrets, healing, approvals), which an agent loads only when the task needs them. Copies installed from an earlier version report `outdated` until `agent install --yes` runs again.

## Not available in M0–M2

Healing, run comparison, CI integration, suites, schedules, tunnels, server multi-user mode, PostgreSQL
runtime, web UI and later features return `CAPABILITY_UNAVAILABLE` (exit 8 / HTTP 422) with their
milestone. `testmaster capabilities` lists every feature and its state.
