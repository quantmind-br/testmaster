import type { mcpTools } from "@testmaster/contracts";

/**
 * The rules of each MCP tool, served at `testmaster://tools/{name}`. A tool description stays a
 * short summary (what, when, next); everything an agent needs to call the tool right lives here,
 * so new rules never have to be squeezed into the description. The exhaustive `Record` makes `tsc`
 * fail when a tool has no rules.
 */
export const toolRules: Record<keyof typeof mcpTools, readonly string[]> = {
  testmaster_capabilities: [
    "Call it first: it lists versions, enabled features (a disabled one carries the reason) and limits.",
    "Never emulate a disabled feature with other tools.",
  ],
  testmaster_validate_document: [
    "`schema` names the contract: ExecutablePlan, ProjectConfig or RunRequest. Nothing is stored or run.",
    "A plan is checked against its contract and the plan rules (predicates per runner, negative checks before render, step references).",
    "A jsonSchema `sourceRevisionId` and pointer are resolved only when the plan is saved: testmaster_save_test and testmaster_edit_plan refuse a pointer that reaches no schema.",
  ],
  testmaster_bootstrap: [
    "Creates or finds the project bound to an approved root; idempotent per root.",
    "Returns projectId, `proposedConfig` (a config file proposal: write it to testmaster.config.json yourself, it is never written), the environment, preflight and next actions.",
    "Adds an environment for the target origin when none exists; never retargets an existing one (use testmaster_update_environment).",
    "Never installs or starts the application. Next: testmaster_analyze_code.",
  ],
  testmaster_analyze_code: [
    "Modes: whole codebase (no `base`), `base`..`head`, or `base`..working tree (`dirty: true`, needs `base`).",
    "The receipt is bounded: counts, the first 50 skipped files, the first 100 features `{id, stableKey}` and the diff impact.",
    "Current features by key: testmaster://projects/{projectId}/features?match= (up to 100 a page within 32 KiB).",
    "Code analysis is not a plan source: plans come from approved requirements and API-spec sources. Documentation files (.md, .rst) are skipped here; add them with testmaster_add_source.",
  ],
  testmaster_normalize_requirements: [
    "Turns source revisions into requirements (each with a `status`: pending, approved, rejected, superseded) and conflicts; returns `sourceSnapshotId` and `version`.",
    "A PRD section (heading, statement, acceptance criteria) normalizes to one requirement whose criteria are the list items under it. API specifications need no normalizing: testmaster_generate_plan reads them directly.",
    "`provider`/`model` pick the model (absent: the first allowed provider and its first capable model). A model call has no deadline; only your cancellation stops it.",
    "Slow: send `_meta.progressToken` to get progress notifications. Next: testmaster_review_requirements.",
  ],
  testmaster_explore: [
    "Browser exploration of features: take `featureIds` from testmaster://projects/{projectId}/features?match=.",
    "`budget`: steps 1..100, modelCalls 1..steps, timeMs 1000..300000. timeMs bounds browser time only; a model call is never cut.",
    "`provider`/`model` pick the model; `mutationActions` are approved form steps the exploration may perform.",
    "A failed exploration names its cause in `testmaster:errorMessage`.",
  ],
  testmaster_generate_plan: [
    "Generates plan proposals (candidates, not tests) from the approved requirement snapshot; `sourceSnapshotId` is its fingerprint (testmaster://requirements/{projectId}).",
    "The model sees only secrets, auth profiles and API-spec sources that already exist: add them first.",
    "The batch result carries no proposals: read them at testmaster://plan-batches/{batchId}, up to 10 a page within 32 KiB. A proposal larger than that gets a page of its own whose first field, `textPages`, says how to read it as byte pages with `offset`.",
    "Requirements HTTP or browser tests cannot observe are declined and listed in `extensions['testmaster:unsupportedRequirements']`.",
    "A proposal that fails a semantic check is repaired up to twice; if any still fails the whole batch is refused unless `partialGeneration: true`.",
    "Next: testmaster_trial_plan to replay the proposals against an environment, then testmaster_edit_plan for a proposal whose trial failed on a wrong pointer or value, then testmaster_review_plan.",
  ],
  testmaster_trial_plan: [
    "Runs the plan of each selected proposal (default: every proposal of the batch) in the sandbox exactly like a replay run, healing off, origin `trial`; no model is called and no proposal or batch version changes.",
    "Only `proposed` proposals with a valid executable plan are tried; the others come back `tried: false` with the `reason` (accepted, rejected, invalid, intent plan, depends on another test's captures, refused admission).",
    "Each tried proposal returns `runId`, `outcome`, `reasonCode` and `failedSteps` `{stepId, status, reasonCode, message, expected, observed}` of the last attempt; read the run with testmaster_get_evidence or testmaster_analyze_run like any run.",
    "A failed trial is a question, not a verdict: a wrong JSON pointer or value is a plan defect (fix it with testmaster_edit_plan and try again), a failure the requirement predicts is a product defect (keep the plan).",
    "The call returns when the runs completed. Trial runs live on a hidden test per proposal that never appears in test listings, suites, selection, coverage or the feature map and cannot be run otherwise; accepting the proposal creates the real test.",
  ],
  testmaster_review_plan: [
    "Accepts or rejects proposals at `expectedVersion` = the batch version (`batch.version` of the batch resource, or the `batchVersion` of the last testmaster_edit_plan or testmaster_review_plan).",
    "Before accepting, testmaster_trial_plan replays the proposals against an environment with no model call, so a wrong pointer or value is fixed before it becomes a test.",
    "Unselected proposals stay pending. An optional `reason` is kept on each decided proposal.",
    "Returns `acceptedProposals` `{proposalId, testId, revisionId}`: the test and revision each accepted proposal produced, and `batchVersion`, which the next review of the batch (for example a group with another reason) takes.",
    "A stale version is REVISION_CONFLICT with `details.diff`; a cited requirement that changed refuses the accept with `staleProposals`.",
    "Next: testmaster_run_tests on the accepted tests, or testmaster_generate_tests for code candidates.",
  ],
  testmaster_generate_tests: [
    "Generates executable code candidates from accepted proposals (`proposalIds`) or existing revisions (`revisionIds`), at least one, all from one project.",
    "`runId` alone (never with `proposalIds`/`revisionIds`) repairs the code candidate a completed, failed run (outcome or gate failed) ran: the model gets the candidate's files, the plan it came from and the run's failed steps (error, expected, observed), and keeps every assertion of that plan. A passed or unfinished run, or a run of a plan revision (use testmaster_propose_healing or testmaster_save_test), is PRECONDITION_FAILED with `details.reasonCode` before any model call.",
    "`provider`/`model` pick the model and are validated before any call; a model call has no deadline.",
    "Each candidate: `id` (its revision: run it with testmaster_run_tests `revisionId`), `testId`, `testName`, `sourceRevisionId` (for a repair, the failed candidate), `proposalId` when it came from a proposal, `repairedFromRunId` for a repair, and `code`, the testmaster://revisions/{id}/code URI of its files. The result also links each candidate's code.",
    "The importer's rules are part of the prompt and the importer checks every answer: a refused candidate is repaired up to twice, then listed in `validationErrors`.",
    "A candidate is never active: run it, then promote it with testmaster_promote_revision after a passing replay.",
  ],
  testmaster_run_tests: [
    "Runs `testIds` with `environmentId`, or a suite (`suiteId`, replay only), in the sandbox; `mode` defaults to replay.",
    "`revisionId` runs that exact revision (a candidate, generated or healed) of the single test in `testIds`; pin several revisions in a testmaster_save_suite list.",
    "`jobId` re-reads an existing batch and needs no other argument.",
    "`wait: true` blocks until `timeoutMs`; reaching it is UPSTREAM_TIMEOUT with `details.runsContinue`: the runs go on, poll testmaster_get_run.",
    "`limits.stepTimeoutMs` only shortens steps, never lengthens one.",
  ],
  testmaster_get_run: [
    "Returns phase, outcome, gate, `analysisStatus`, `reasonCode` and the run's test, revision, environment revision, mode and origin.",
    "Summary only: for a run that did not pass, or a pass whose gate failed, call testmaster_get_evidence and then testmaster_analyze_run before naming a cause.",
    "`executionError` names an error recorded after the steps (for example evidence that could not be published); `unavailableEvidence` lists evidence a gate missed.",
    "Step records: testmaster://runs/{id}/steps.",
  ],
  testmaster_get_evidence: [
    "Pages the evidence manifest (screenshots, DOM, console, network, logs) with a resource link per artifact, each with the artifact's own media type.",
    "Check `integrity` and `freshness` (`staleReasons` says why evidence is stale); follow `nextCursor`; `failedOnly` narrows to failed steps.",
    "Unpublished evidence names the run's `executionError`. Next: testmaster_analyze_run.",
  ],
  testmaster_analyze_run: [
    "Diagnoses a failed run, or a pass whose gate failed, from recorded evidence; rules always run.",
    "`model: true` (or a model id, with an optional `provider`) adds a model reading; `modelStatus` says if it was used, abstained or unavailable.",
    "A cause without cited evidence is only a suggestion. A failed step whose record holds no compared value cites the runner's message.",
    "Heal only when `healing.advice` allows it; otherwise fix the test (testmaster_save_test) or the application.",
  ],
  testmaster_get_analysis: [
    "Reads the stored analysis without recomputing it.",
    "NOT_FOUND when the run was never analyzed: call testmaster_analyze_run.",
  ],
  testmaster_cancel_run: [
    "Requests cancellation of a run with a reason.",
    "A request is not a stop: confirm with testmaster_get_run until the phase is completed.",
  ],
  testmaster_compare_runs: [
    "Compares two runs, paged by `cursor` and `limit`: `comparability` (comparable, partially_comparable, incomparable) with its `reasons`, and `differences`, one entry per differing field.",
    "A field is compared whole: `steps` and `artifacts` differences carry both sides' complete lists, so compare `status`, `reasonCode`, `expected` and `observed` per `planStepId` yourself.",
    "It lists differences and never judges a regression: a failed run against a green baseline of the same revision and environment is the closest it comes to telling a product change from drift.",
  ],
  testmaster_propose_healing: [
    "Proposes a candidate revision that changes only the locator of a failed action step of the test's active plan revision. Nothing is applied.",
    "Assertions are never healed: a wrong expected value or a failed check is fixed with testmaster_save_test (a candidate revision) and testmaster_promote_revision.",
    "Refused before any model call (PRECONDITION_FAILED): `healing_not_indicated` (the analysis advises no test-only repair), `code_revision` (code is not healed), `revision_not_active`.",
    "`abstained: true` with a `reasonCode` means no safe repair exists. Next: testmaster_review_healing.",
  ],
  testmaster_review_healing: [
    "Reads a proposal: status (proposed, approved, verified, rejected), healing diff, risk, the assertions check (`preservedAssertions.intact`), verification and approval.",
    "`risk` is the highest class of the candidate plan's steps, so a login form test is `write`.",
    "Next, only after review: testmaster_approve_healing with `approval.expectedVersion`, or testmaster_reject_healing with a reason.",
  ],
  testmaster_approve_healing: [
    "Approves a reviewed proposal at `expectedVersion` (reason optional): creates the candidate revision and a verification run.",
    "The verification runs in this process when no worker is live: follow it with testmaster_get_run `wait: true`.",
    "A passing verification makes the proposal verified and the candidate the active revision. Write scope; audited.",
  ],
  testmaster_reject_healing: [
    "Rejects a reviewed proposal; `reason` is required and recorded with the reviewer and time.",
    "Nothing is applied: no revision or verification run is created. Write scope; audited.",
  ],
  testmaster_edit_plan: [
    "Replaces the plan of a still-proposed proposal at the proposal's own `expectedVersion`; the plan is validated and the requirement and evidence references stay.",
    "Returns the Proposal itself (read `result.version`, not `result.proposal.version`) plus `batchVersion`: every edit raises it, and testmaster_review_plan takes it.",
    "A stale version is REVISION_CONFLICT with the current plan and both versions.",
  ],
  testmaster_save_test: [
    "Stores a plan as a new test (`projectId`) or as a candidate revision of a test (`testId`, optional `parentRevisionId`).",
    "`plan.requirementRefs` is required (`[]` when none); the plan is linted like `test create`.",
    "A new test's first revision is active at once; a `testId` revision stays a candidate (`active: false`) and `nextActions` names the run and promote calls.",
  ],
  testmaster_import_code: [
    "Imports one entry file and the local files it imports, inside an approved root and the project root (symlinks are refused); `format` is `playwright` (.ts) or `pytest` (.py).",
    "The code is checked exactly like `test import`: allowed modules only, secrets only through `secrets.get` of a registered secret, at least one assertion; a refusal is `INVALID_ARGUMENT` naming the rule and the line (a path outside the project root or through a symlink is `POLICY_DENIED`).",
    "With `projectId` a new test is created with the code active (`name` defaults to the first test title); with `testId` the code becomes a candidate revision (`active: false`, parent `parentRevisionId` or the active revision) and `nextActions` names the testmaster_run_tests call with `revisionId` and the testmaster_promote_revision call.",
    "Every `expect()` takes the observed value, never a literal (`expect([403, 404]).toContain(...)` is refused; write `expect(String(status)).toMatch(/^(403|404)$/)`). With `testId`, `sourceSchemas.violations(revision, pointer, value)` may check the schemas the test's plan cites in `jsonSchema` assertions.",
    "Use it to fix a failed generated candidate by hand: read its files at testmaster://revisions/{id}/code, write the corrected file in the project, import it with `testId`, replay, promote.",
  ],
  testmaster_promote_revision: [
    "Makes a candidate revision active at `expectedVersion` (the test's `version`); an optional reason is recorded.",
    "A generated candidate needs a passing deterministic replay first (testmaster_run_tests with `revisionId`); a healed one is promoted by testmaster_approve_healing.",
    "A test still named after its replaced active plan takes the promoted plan's name.",
  ],
  testmaster_archive_test: [
    "Archives a test at `expectedVersion` (the test's `version`): it leaves active use; its history, revisions and evidence stay; there is no unarchive.",
    "An optional reason is recorded on the test with the actor and time. Runs raise the test version: read it fresh.",
  ],
  testmaster_save_suite: [
    "Creates a test list, or changes one at `expectedVersion`: replace the `selection`, or `addMembers`/`removeMembers` of a fixed list (removals first).",
    "Run it with testmaster_run_tests `suiteId` (replay only).",
    "Reports judge each test by its active revision: a pinned revision never promoted is a candidate (not stale, verifies nothing).",
  ],
  testmaster_approve_execution: [
    "Approves the risky production actions a run was refused for (`approval_required`): copy `details.binding`, add a reason, then repeat testmaster_run_tests.",
    "Bound to that revision, environment revision, origins, actions and policy; expires in at most 30 minutes; used once.",
  ],
  testmaster_open_report: [
    "Locates a committed report: `runId` for one run, `batchId` (the run_tests batchId/jobId) for every member run.",
    "Returns `location` (JSON), `formats` `{json, markdown, html, junit}` (ready URIs), `sizes` (each format's whole length in UTF-8 bytes) and `paging` (`pageBytes`, `rule`).",
    "A report read is one page of at most `pageBytes`, and a page of a larger report looks like a whole document (JSON and JUnit stop mid-element): read `offset=0`, then add the UTF-8 byte length of the page read to `offset`, until `offset` equals `sizes[format]`, and concatenate the pages before parsing. `_meta` testmaster:next and testmaster:sha256 (of the whole text) repeat this for clients that show `_meta`.",
  ],
  testmaster_add_source: [
    "Imports a PRD, OpenAPI (3.0, 3.1, 3.2, Swagger 2.0), GraphQL, Postman or text file inside an approved root as a source revision; returns status and diagnostics.",
    "An invalid source is an error with `details.reasonCode` and `details.diagnostics`.",
    "A new revision whose cited text changed resets the requirements citing it and lists them in `requirementsReset`.",
    "Next: testmaster_normalize_requirements (API specs need no normalizing).",
  ],
  testmaster_archive_source: [
    "Archives a source at `expectedVersion` (testmaster://projects/{projectId}/sources lists it).",
    "With no active revision, plan generation stops offering its API operations and coverage stops counting them; its revisions, requirements and tests stay.",
    "testmaster_add_source with `sourceId` makes it active again.",
  ],
  testmaster_review_requirements: [
    "Applies, at the snapshot `expectedVersion`, in order: edits (`update`), conflict decisions (`adjudicate`), rejections (`reject`, reason required; final) and approvals (`approve`). Every list is optional and may be empty.",
    "An optional top-level `reason` is kept on each edited or approved requirement.",
    "Returns per-item `results` (a refused item does not stop the others), the new `sourceSnapshotId`, `version`, `pendingApprovalIds` and `unresolvedConflictIds`.",
    "Approving a requirement whose conflict is undecided is refused (`requirement_conflict_unresolved`). Next: testmaster_generate_plan with the new sourceSnapshotId.",
  ],
  testmaster_set_secret: [
    "Registers a secret from `valueFile` (inside an approved root) or `fromEnv` (a variable of the server process), never inline; one trailing newline of a file is removed.",
    "`allowedOrigins` is required. Returns metadata only; the `locator` is the secret's name.",
    "A taken name is REVISION_CONFLICT with `details.secretId`: use testmaster_rotate_secret.",
    "Secrets and auth profiles must exist before testmaster_generate_plan so plans can cite them.",
  ],
  testmaster_rotate_secret: [
    "Stores a new value for an existing secret (id or name) from `valueFile` or `fromEnv`.",
    "The id, name and `allowedOrigins` stay, `secretVersion` goes up, and auth profiles and plans that cite it use the new value. Returns metadata only.",
  ],
  testmaster_save_auth_profile: [
    "Create: `projectId`, `name`, `kind`, `originBindings`, `secrets` (role to secret id), `config`. Update: `profileId`, `expectedVersion` and the top-level fields to change.",
    "`username` may be a plain value: it is stored and returned unmasked; every other credential role takes a secret id.",
    "The config keys of each kind are listed in the input schema. Next: testmaster_update_environment to bind the profile (`authRefs`).",
  ],
  testmaster_update_environment: [
    "Changes an environment at `expectedVersion`; give only the fields to change, at top level next to `environmentId`: authRefs, additionalOrigins, baseUrl, networkProfile, locale, timezone, production, name, serverLog.",
    "Returns the environment and its new active revision. A profile not bound to the target origin is PRECONDITION_FAILED.",
    "`serverLog: {kind: \"docker\", container}` opts in to reading the application server's docker log: the lines written during each attempt are stored, scrubbed of secrets, as the evidence logs/server.log, and testmaster_analyze_run cites its error lines. `serverLog: null` stops it. TestMaster only reads the log; the container must run on the host's docker.",
  ],
  testmaster_test_auth_login: [
    "Signs in once with an auth profile bound to an environment and reports the outcome: authenticated, failed, blocked or checkpoint_required.",
    "Saves no draft or revision and never returns credentials. Scope X, like `auth-profile test-login`.",
  ],
};
