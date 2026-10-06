# Quickstart (M0–M2, local single-user)

TestMaster runs approved test revisions deterministically inside a hardened Docker sandbox and keeps
verifiable evidence under `.testmaster/`. Generation with a model is optional and `experimental`.

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

## Model-assisted path (experimental)

Model providers are declared only in the user profile `~/.config/testmaster/profiles.json`, allowed by the
operator policy `~/.config/testmaster/policy.json`, and require explicit consent per project, provider and
data class. Without consent no byte is sent to the provider. Unpriced models additionally require an
explicit unknown-cost grant and a cumulative project token ceiling. The current live validation model
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
          "apiKeyEnv": "QUANTFORGE_API_KEY",
          "models": [{ "id": "qwen3.8-flash", "capabilities": { "structuredJson": true, "toolCalls": true, "contextTokens": 128000, "maxOutputTokens": 8192 } }]
        }
      ]
    }
  }
}
```

```bash
echo '{"allowedModelProviders":["quantforge"]}' > ~/.config/testmaster/policy.json
testmaster consent grant --provider quantforge --data-class documents code_summary requirements plans --allow-unknown-cost
testmaster budget set --tokens 12000000
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
