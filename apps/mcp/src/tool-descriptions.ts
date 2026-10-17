import type { mcpTools } from "@testmaster/contracts";

/**
 * Agent-facing descriptions of the MCP tools. Each one says what the tool does and returns, when to
 * use it (or the key constraint), and the recommended next tool. Kept out of the frozen contract
 * surface on purpose; the exhaustive `Record` makes `tsc` fail when a tool lacks a description.
 */
export const toolDescriptions: Record<keyof typeof mcpTools, string> = {
  testmaster_capabilities:
    "Read versions, enabled features (with the reason a feature is disabled) and limits. Call this first; never emulate a disabled feature.",
  testmaster_validate_document:
    "Validate an ExecutablePlan, ProjectConfig or RunRequest (schema names which) against its contract and plan rules; nothing is stored or run. A jsonSchema sourceRevisionId and pointer are resolved on save: testmaster_save_test and testmaster_edit_plan refuse one that reaches no schema.",
  testmaster_bootstrap:
    "Create or find the project of an approved root; returns projectId, proposedConfig (a config file proposal, never written), environment, preflight, next actions. Adds an environment for the target origin if none exists; never retargets one. Idempotent. Next: testmaster_analyze_code.",
  testmaster_analyze_code:
    "Snapshot the code: whole codebase (no base), base..head, or base..working tree (dirty=true, needs base). Bounded receipt: counts, first 50 skipped files, first 100 features {id, stableKey}, diff impact. Current features by key: testmaster://projects/{projectId}/features?match=. Not a plan source.",
  testmaster_normalize_requirements:
    "Normalize source revisions into requirements (each with a status) and conflicts; returns sourceSnapshotId and version. A PRD section with its criteria is one requirement; API specs need no normalizing. Slow: _meta.progressToken notifies. Next: testmaster_review_requirements.",
  testmaster_explore:
    "Browser exploration. featureIds: testmaster://projects/{projectId}/features?match=. budget: steps 1..100, modelCalls 1..steps, timeMs 1000..300000 (browser time only; a model call is never cut). provider/model pick the model; mutationActions: form steps. Failure: testmaster:errorMessage.",
  testmaster_generate_plan:
    "Generate plan proposals (not tests) from the approved snapshot (sourceSnapshotId); provider/model pick the model. Sees only existing secrets, auth profiles and API-spec sources: add them first. Proposals: read the returned resource (testmaster://plan-batches/{batchId}). Next: testmaster_review_plan.",
  testmaster_review_plan:
    "Accept or reject proposals at expectedVersion = the batch version (batch.version, or batchVersion of an edit); an optional reason is kept on each decided one. Returns acceptedProposals {proposalId, testId, revisionId}. Stale version: details.diff or staleProposals. Next: testmaster_generate_tests.",
  testmaster_generate_tests:
    "Generate candidates from accepted proposals (proposalIds) or revisions (revisionIds), one project per call; provider/model pick the model; no model deadline. Each candidate: id (its revision; testmaster_run_tests revisionId), testId, testName, sourceRevisionId, proposalId. Refused: validationErrors.",
  testmaster_run_tests:
    "Run testIds with environmentId, or a list (suiteId, replay only), in the sandbox; revisionId pins one test's revision (pin several in a testmaster_save_suite list). Mode defaults to replay. jobId re-reads a batch. wait=true blocks until timeoutMs (runs go on), or poll testmaster_get_run.",
  testmaster_get_run:
    "Get phase, outcome, gate, analysisStatus and the run test, revision, environment revision, mode and origin. Summary only: a run that did not pass, or whose gate failed, needs testmaster_get_evidence then testmaster_analyze_run to name a cause; executionError names an error after the steps.",
  testmaster_get_evidence:
    "Page the evidence manifest (screenshots, DOM, console, network, logs) with resource links. Check integrity and freshness (staleReasons says why), follow nextCursor; failedOnly narrows. Unpublished evidence names the run executionError. Next: testmaster_analyze_run.",
  testmaster_analyze_run:
    "Diagnose a failed run, or a pass whose gate failed, from recorded evidence. model=true (or a model id; provider optional) adds a model reading; modelStatus says if it was used or abstained. A cause without cited evidence is only a suggestion. Heal only if the advice allows.",
  testmaster_get_analysis:
    "Read the stored analysis without recomputing. NOT_FOUND if never requested; then call testmaster_analyze_run.",
  testmaster_cancel_run:
    "Request cancellation of a run with a reason. A request is not a stop: confirm with testmaster_get_run until the phase is completed.",
  testmaster_compare_runs:
    "Compare two runs, paged by cursor and limit. Example: a failed run against a green baseline, to tell regression from drift.",
  testmaster_propose_healing:
    "Propose a locator-only candidate for a failed Run of the active plan revision; assertions never change. Next: testmaster_review_healing. abstained: true (reasonCode) = no safe repair. Refused before a model call (PRECONDITION_FAILED): healing_not_indicated, code_revision, revision_not_active.",
  testmaster_review_healing:
    "Read the proposal's status (proposed, approved, verified, rejected), healing diff, risk, assertions-intact check, verification and approval. Next: testmaster_approve_healing with approval.expectedVersion, or testmaster_reject_healing with a reason, only after review.",
  testmaster_approve_healing:
    "Approve at expectedVersion after testmaster_review_healing (reason optional): creates the candidate revision and a verification run, run here when no worker is live (testmaster_get_run wait=true). A pass makes the proposal verified and the candidate the active revision. Write scope; audited.",
  testmaster_reject_healing:
    "Reject a healing proposal after testmaster_review_healing; reason is required and is recorded on the proposal with the reviewer and time. Nothing is applied: no revision or verification run is created. Needs write scope; audited.",
  testmaster_edit_plan:
    "Replace the plan of a still-proposed proposal at its expectedVersion (validated; requirement and evidence references kept). Returns the Proposal itself, not wrapped, plus batchVersion, which testmaster_review_plan takes: every edit raises it. Next: testmaster_review_plan.",
  testmaster_save_test:
    "Store a plan as a new test (projectId) or a candidate revision of a test (testId); plan.requirementRefs is required ([] if none). Returns test, revision, active and nextActions. A new test's first revision is active at once; a testId revision stays a candidate until testmaster_promote_revision.",
  testmaster_promote_revision:
    "Make a candidate revision the active one of its test at expectedVersion (test.version); an optional reason is recorded. A generated candidate needs a passing replay first: testmaster_run_tests with revisionId. Healed revisions go through testmaster_approve_healing.",
  testmaster_archive_test:
    "Archive a test at expectedVersion (test.version): it leaves active use, its history and evidence stay, and no unarchive exists. An optional reason is recorded on the test with the actor and time. Returns the archived test.",
  testmaster_save_suite:
    "Create a list, or change one at expectedVersion: replace the selection, addMembers or removeMembers of a fixed list. Run it with testmaster_run_tests suiteId (replay only). Reports verify by active revision: a never-promoted pinned revision is a candidate (not stale, verifies nothing).",
  testmaster_approve_execution:
    "Approve risky production actions your run was refused for (approval_required): copy details.binding, add a reason, then repeat testmaster_run_tests. Bound to that revision, environment revision, origins and policy; expires in 30 minutes; used once.",
  testmaster_open_report:
    "Locate a committed report: runId for one run, batchId (run_tests batchId/jobId) for its member runs. Returns location (JSON) and formats {json, markdown, html, junit}, ready URIs. Read one as a paged text resource; follow _meta next and concatenate the pages.",
  testmaster_add_source:
    "Import a PRD, OpenAPI, GraphQL, Postman or text file inside an approved root as a source revision; returns status and diagnostics (invalid source: an error). A revision whose cited text changed lists the reset requirements in requirementsReset. Next: testmaster_normalize_requirements.",
  testmaster_archive_source:
    "Archive a source at expectedVersion (testmaster://projects/{projectId}/sources lists it): with no active revision, plan generation stops offering its API operations and coverage stops counting them. Its revisions, requirements and tests stay; testmaster_add_source with sourceId reactivates it.",
  testmaster_review_requirements:
    "Edit, adjudicate conflicts, reject (reason required; final) and approve requirements at the snapshot expectedVersion, in that order; an optional reason is kept on each edited or approved one. Returns per-item results and the new sourceSnapshotId. Next: testmaster_generate_plan.",
  testmaster_set_secret:
    "Register a secret from valueFile or fromEnv (never an argument; one trailing newline trimmed) with its allowedOrigins; returns metadata only. Secrets and auth profiles must exist before testmaster_generate_plan. Next: testmaster_save_auth_profile.",
  testmaster_save_auth_profile:
    "Create (projectId, name, kind, originBindings, secrets, config) or update (profileId, expectedVersion, top-level fields to change) an auth profile; secrets are secret ids, username may be plain (unmasked); config keys per kind: input schema. Returns the view. Next: testmaster_update_environment.",
  testmaster_update_environment:
    "Change an environment at expectedVersion; give only the fields to change, at top level next to environmentId: authRefs (profiles bound to the target origin), additionalOrigins, baseUrl, networkProfile, locale, timezone, production, name. Returns the environment and its new active revision.",
  testmaster_test_auth_login:
    "Sign in once with an auth profile bound to an environment and report the outcome (authenticated, failed, blocked, checkpoint_required); saves no draft or revision, never returns credentials. Scope X, like auth-profile test-login.",
};
