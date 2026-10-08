# Quickstart (M0–M2, local single-user)

TestMaster runs approved test revisions deterministically inside a hardened Docker sandbox and keeps
verifiable evidence under `.testmaster/`. Generation with a model is optional and `experimental`.

## Install the public experimental runtime

The Linux x64 relocatable prerelease is available at
[runtime-89a7205](https://github.com/quantmind-br/testmaster/releases/tag/runtime-89a7205).
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

`testmaster doctor` refuses execution (exit 9) when Docker, the image lock or the seccomp profile is not
usable. There is no silent fallback to unsandboxed execution; `--unsafe-local` additionally requires
`execution.executor: "process"` and a user-level opt-in, and reports mark the run as not isolated.

## Deterministic path (no model, no internet)

The application under test must already be running (here on `127.0.0.1:3000`).

```bash
testmaster init --mode local --name shop --base-url http://127.0.0.1:3000
testmaster doctor
testmaster test scaffold --type frontend > testmaster_tests/login.plan.json   # or write a plan by hand
testmaster test lint --plan testmaster_tests/login.plan.json                   # offline validation
testmaster test create --plan testmaster_tests/login.plan.json --output json   # immutable revision
testmaster test run "$TEST_ID" --wait --output json                              # replay mode, heal off
testmaster artifact get "$RUN_ID" --out .testmaster/failure                     # verified bundle copy
testmaster report export "$RUN_ID" --format junit --out report.xml              # json|markdown|html|junit|allure
# fix the application outside TestMaster, then replay the same revision
testmaster test rerun "$TEST_ID" --wait --output json
```

- `--output json` (or `--json`) prints exactly one JSON envelope on stdout; diagnostics go to stderr.
- Exit codes follow `specs/05-cli-mcp.md` §3 (0 passed, 1 failed gate, 6 precondition, 7 wait deadline,
  8 capability unavailable, 9 policy/sandbox denied, 130/143 interrupted).
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

Optional enrichment is explicit: grant the provider the `execution_evidence` data class, then use
`testmaster run analyze "$RUN_ID" --model --deadline-ms 180000`. Only sanitized execution summaries
and bounded measurements cross that boundary, not raw trace/video or sensitive captures. Model
refusal/failure retains the factual predecessor and records a limitation in a separate immutable
analysis. Identical requests reuse their stored receipt; interrupted paid calls are not reissued.

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

Model providers are declared only in the user profile `~/.config/testmaster/profiles.json`, allowed by the
operator policy `~/.config/testmaster/policy.json`, and require explicit consent per project, provider and
data class. Without consent no byte is sent to the provider. Unpriced models additionally require an
explicit unknown-cost grant. No token or monetary ceiling applies unless you set one. The current live validation model
is `qwen3.8-flash` on QuantForge, selected explicitly by the operator. Provider availability is checked
at execution time; configuring a model does not authorize data transfer or establish generation quality.

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
applies only to cached input the provider reports. With a price table no unknown-cost grant is needed.

To control reasoning effort, add `"reasoningEffort": "medium"` to the model entry
(alongside `id` and `capabilities`). Supported values: `low`, `medium`, `high`, `xhigh`, `max`.
When omitted, the provider default applies. TestMaster sends `reasoning_effort` only
when configured; it still omits token ceilings, sampling parameters and `enable_thinking`.

```bash
echo '{"allowedModelProviders":["quantforge"]}' > ~/.config/testmaster/policy.json
testmaster consent grant --provider quantforge --data-class documents code_summary requirements plans
testmaster budget set --tokens 12000000                    # optional cumulative project token quota
testmaster source add PRD.md --role prd --format markdown
testmaster source add openapi.yaml --role api --format openapi
testmaster discover --scope codebase                      # or --scope diff --base <ref> --head <ref>
testmaster requirement normalize --source-revision <svr-id> && testmaster requirement list
testmaster requirement approve <requirement-id> --expected-version <n>   # never automatic
testmaster plan generate --type frontend --requirement <requirement-id>
testmaster plan get "$BATCH_ID"
testmaster plan accept "$BATCH_ID" --only <proposal-a>,<proposal-b> --expected-version <n>
testmaster test run "$TEST_ID" --mode agent --wait         # resolves flagged steps into typed actions
testmaster test run "$TEST_ID" --revision "$CANDIDATE" --wait   # deterministic replay of the candidate
testmaster test revision promote "$CANDIDATE" --expected-version <n>
testmaster usage                                           # model calls, tokens, budget; unknown cost stays unknown
```

Exact flags: `testmaster <group> <command> --help`.

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

## Agents: API, MCP and skills

```bash
testmaster server start --port 7331                 # loopback /v1 API, bearer token file 0600
testmaster mcp serve --transport stdio --root "$PWD" # MCP for coding agents
testmaster agent install --target claude             # preview; add --yes to apply
```

Agent skill files are written atomically inside managed markers, with backups under
`.testmaster/agent-backups/`; edited managed blocks are reported as drift, never overwritten.

## Not available in M0–M2

Healing, run comparison, CI integration, suites, schedules, tunnels, server multi-user mode, PostgreSQL
runtime, web UI and later features return `CAPABILITY_UNAVAILABLE` (exit 8 / HTTP 422) with their
milestone. `testmaster capabilities` lists every feature and its state.
