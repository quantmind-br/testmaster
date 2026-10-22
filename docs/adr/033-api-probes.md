# ADR-033: API probes

- Status: accepted
- Date: 2026-10-22
- Scope: ROADMAP M5-05 (API property and stateful testing: REQ-050, VAL-030, VAL-042).

## Context

REQ-050 requires property-based API tests with Schemathesis for OpenAPI and GraphQL, with seed, reproduction, shrinking and reports, and states that they do not replace business acceptance. VAL-030 requires the Python 3.12 adapter to replay a minimized example against the real API and to report an adapter or dependency failure as `blocked`, never `passed`. VAL-042 requires negative cases, stateful workflows, seed and example replay, authentication boundaries and shrinking, and that a minimized example reproduces without a model. Until M5 a test revision always held a declarative plan (or imported code), so there was no place for a test whose requests are generated from an API description.

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

## Consequences

- A passing probe says the API answered the generated examples as its description documents. It is not business acceptance: a description that documents a wrong answer passes.
- Schemathesis and Hypothesis live in the Python runner image; upgrading them is a reviewed image rebuild, and a different version may generate different examples for the same seed.
- Stateful failures are reported unshrunk, so their sequences can be longer than necessary.
- The probe's generated requests can create data on the target. The `securityProbe` approval names the environment and origins it may reach.
