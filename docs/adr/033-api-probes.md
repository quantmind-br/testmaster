# ADR-033: API and security probes

- Status: accepted
- Date: 2026-10-22
- Scope: ROADMAP M5-05 (API property and stateful testing: REQ-050, VAL-030, VAL-042) and M5-06 (DAST, access control and load: REQ-048, REQ-049, VAL-043, VAL-044).

## Context

REQ-050 requires property-based API tests with Schemathesis for OpenAPI and GraphQL, with seed, reproduction, shrinking and reports, and states that they do not replace business acceptance. VAL-030 requires the Python 3.12 adapter to replay a minimized example against the real API and to report an adapter or dependency failure as `blocked`, never `passed`. VAL-042 requires negative cases, stateful workflows, seed and example replay, authentication boundaries and shrinking, and that a minimized example reproduces without a model. Until M5 a test revision always held a declarative plan (or imported code), so there was no place for a test whose requests are generated from an API description.

REQ-048 requires authentication, IDOR and input-contract checks plus an opt-in DAST adapter against an authorized target, without promising a universal pentest; REQ-049 requires request and latency budgets and load through an adapter, with authorization and metrics from a controlled environment. VAL-043 requires security probes to have scope, allowlist, approval, isolation, redaction and an independent oracle, and to refuse a destructive or external scan without explicit authorization; VAL-044 requires load tests to separate platform from target, to have ramp, concurrency, rate, duration, budget and stop conditions, not to bring the host down past the defined limit, and to report hardware, dataset and errors without fictitious throughput. These are the same kind of test as a property probe: no plan, requests generated from a description, and traffic an operator approves per Run.

## Decision

### Probe revisions

- A test revision may hold a `probe` instead of a plan. A property probe names an imported OpenAPI or GraphQL source revision (`svr_`), optional OpenAPI `METHOD /path` operations or GraphQL root fields (absent means all), `stateful` (OpenAPI links), `maxExamples` (1 to 1000, default 100), optional `checks` and optional `credentials` (`{header, secretRef}`; the secret holds the whole header value). Creation freezes the defaults into the revision (`normalizeProbe`), so equal probes hash and compare alike, and refuses a source of another project or API kind, an operation the description does not declare, OpenAPI-only options on GraphQL and an unknown secret.
- The revision's runner kind is `probe` (migration `0027_probe_runner` extends the CHECK); it has no plan, no code and no parent. Code export and healing refuse it (`PRECONDITION_FAILED`), as they refuse any revision without a declarative plan; the portal shows the probe read-only.
- The checks are Schemathesis's `not_a_server_error`, `status_code_conformance`, `content_type_conformance`, `response_schema_conformance` and `ignored_auth`. The default is all of them, without `ignored_auth` when the probe has no credentials. GraphQL runs `not_a_server_error` only, the check Schemathesis defines for GraphQL; the GraphQL capability (`graphql-property`) is separate from the REST one (`api-property`).
- A probe sends generated requests, including unexpected and invalid ones, so it is a security probe: every probe Run needs a current bound `securityProbe` approval for its revision, environment, policy and origins, in every environment, and one approval is consumed by one Run. A probe runs only in the Docker sandbox; the process executor refuses it (`PRECONDITION_FAILED`).

### Execution

- The Python runner image runs the probe with Schemathesis 4.32.3, a pinned dependency of the image. A missing dependency ends the Run `blocked` (`property_dependency_missing`) and an unreadable description or an operation it does not declare `blocked` (`property_schema_invalid`). Neither is ever `passed`.
- The Attempt stages the description's bytes into the input mount only after they hash to the source revision's content hash, so the probe tests the description admission bound. The probe's own requests go through the egress proxy like any other Run.
- Hypothesis is seeded with the Run's frozen seed, its example database is off and the deadline is off, so the same seed and description generate the same requests. Each operation is one required assertion step (`property:<METHOD> <path>`, GraphQL `property:<field>`), stateful sequences are `property:stateful`, and an aggregate `property` step carries the Run's verdict. A failed step names the failing check as its error code.
- A failing stateless example is shrunk by Hypothesis before it is reported. Stateful scenarios run Hypothesis's generation phase only, as Schemathesis runs its state machines: a scenario depends on server state that moved on, so a shrinking or replay pass cannot reproduce it. The reported sequence is the scenario as it ran. A replay divergence after every check held, with at least one completed scenario, is a pass; no completed scenario is `inconclusive`.
- A GraphQL environment URL without a path means the conventional `/graphql` endpoint; a URL with a path is the endpoint itself.

### Reproduction

- Each failure writes `property/<n>-reproduction.json` (the request or sequence, the check, the message and the seed) and, when every request uses a method the HTTP runner supports, `property/<n>-replay.plan.json`: an ordinary HTTP plan whose last step asserts what the check demands (`statusIn` documented statuses, `jsonSchema` with the source revision and a JSON pointer to the documented response schema, `headerMatches` on documented media types, or `statusIn [401, 403]` for `ignored_auth`, replayed without credentials).
- Credential headers appear in both artifacts as `{secretRef}`, never as values. The runner redacts secret values in everything it writes and refuses to publish an artifact that still contains one.
- `run reproduce <runId> --artifact property/<n>-replay.plan.json` (`POST /runs/{id}/reproductions`) creates one test from a stored replay plan and admits it in replay mode with the probe Run's seed and environment. A retried request reuses the same test. The reproduction needs no model and no Schemathesis: it is a deterministic HTTP Run.

### DAST

- A DAST probe (`kind: "dast"`) names target-relative `startPaths`, a spider bound (`maxDurationMinutes`, `maxChildren`), whether to run an active scan, a scan policy (`default`, or `api-minimal`: SQL injection, reflected and persistent XSS, path traversal, remote file inclusion, command injection, CRLF injection, external redirect and template injection only), the lowest risk that fails the Run (`failOn`) and optional credential headers.
- It runs OWASP ZAP 2.17.0 in the optional image `testmaster-runner-zap`, built from a pinned digest of the official image with a Python adapter (`containers/zap/adapter.py`). The image is optional: an installation without it reports the `dast` capability unavailable (`CAPABILITY_UNAVAILABLE`) and every other runner works. The `dast` executor kind runs with the same hardening as the others (no network, read-only root, all capabilities dropped, the generated seccomp profile) and 2 CPUs, 2 GiB, 512 processes; a worker runs one DAST Attempt at a time unless `pools.dast` says otherwise.
- ZAP listens on the container's loopback with a random API key and reaches the target only through the egress proxy, so the Run's network policy bounds every request it sends. Credentials are ZAP request-header replacer rules set through its API, never argv.
- The spider stops at its own bound; the active scan has no timer and runs until ZAP finishes or the Run is cancelled. Steps are `dast:spider`, `dast:active-scan`, one per risk (`dast:high`, `dast:medium`, `dast:low`, `dast:informational`) and the aggregate `dast`. A risk at or above `failOn` with alerts fails (`dast_alert`); a risk with no alerts after an incomplete scan is `inconclusive`, never `passed`. `dast/alerts.json` lists the alerts without attack bodies and `dast/report.json` is ZAP's report; both are scrubbed of secret values and refused if one remains.

### Access control

- An access probe (`kind: "access"`) lists operations (`METHOD`, target-relative path, optional JSON body), the owner's credentials, the intruder's (empty means anonymous) and the statuses that count as a refusal (`401`, `403`, `404`). The intruder may not hold an owner credential (`INVALID_ARGUMENT`).
- Each operation is sent as the intruder first, then as the owner, and is one step (`access:<METHOD> <path>`). An intruder answered 2xx fails it (`access_granted`), any other unexpected status fails it (`unexpected_status`), and a refusal passes only if the owner is then answered 2xx; a refused owner proves nothing and is `inconclusive` (`owner_refused`). Each failure writes `access/<n>.json` with the operation and both statuses, never a header value.

### Load

- A load probe (`kind: "load"`) sends one request open-loop through up to ten stages (`durationSeconds`, `targetRps`), bounded by `maxConcurrency` in flight; a scheduled request that finds the bound full is not sent and is counted as saturated. A budget (`maxRequests`, `maxDurationSeconds`) ends the test normally; stop conditions (`maxErrorRate`, `maxP95Ms`) evaluated over a rolling five-second window end it early and fail it (`stop_condition`).
- Durations are capped at 900 s, the longest Attempt `ExecutionLimits` allows, and admission refuses a schedule that does not end before the Run's Attempt deadline (`INVALID_ARGUMENT`): the deadline would otherwise cut a test that is making progress.
- `load/summary.json` holds the target's count, errors, error rate, saturated requests and p50/p95/p99 (a percentile with too few samples is `null` with its sample count), the runner's scheduler lag, the hardware, the request and each stage's achieved rate. These percentile helpers live in `@testmaster/domain` and are shared with the server benchmark.

### Production

- DAST and load probes never run against an environment marked `production`, approval or not: admission refuses them with `POLICY_DENIED` and `reasonCode: "production_load_refused"` before any approval is consulted. Access probes send ordinary requests and may run in production under the same `securityProbe` approval as every probe.
- The approval's origins cover every origin the Run reaches. A Run aimed at another target (`--target-url`, `--local`) needs an approval naming that origin; one naming only the environment's origins does not admit it. This holds for every execution approval, not only probes.
- The runner key of a probe revision is `probe` for property probes and `probe:<kind>` otherwise (`probe:dast`, `probe:access`, `probe:load`); a worker advertises the keys its images support and admission requires the one the revision needs.

## Consequences

- A passing probe says the API answered the generated examples as its description documents. It is not business acceptance: a description that documents a wrong answer passes.
- Schemathesis and Hypothesis live in the Python runner image; upgrading them is a reviewed image rebuild, and a different version may generate different examples for the same seed.
- Stateful failures are reported unshrunk, so their sequences can be longer than necessary.
- The probe's generated requests can create data on the target. The `securityProbe` approval names the environment and origins it may reach.
- A DAST pass means ZAP's rules raised no alert at or above `failOn` on what the spider reached. It is not a penetration test: pages the spider cannot reach and defects outside ZAP's rules are not covered.
- The ZAP image is large and carries a Java runtime; a release that ships it is scanned like the other images, and its findings are reviewed with ZAP upgrades.
- Load figures measure the target as seen from the worker's host. A load test on the target's own host measures both together, and the summary says which hardware ran it.
