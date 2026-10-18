import type { mcpTools } from "@testmaster/contracts";

/**
 * Agent-facing descriptions of the MCP tools, at most 250 characters each: what the tool does and
 * returns, when to use it (or the key constraint), and the recommended next tool. The rules behind
 * them live in `tool-rules.ts`, served at `testmaster://tools/{name}`. Kept out of the frozen
 * contract surface on purpose; the exhaustive `Record` makes `tsc` fail when a tool lacks one.
 */
export const toolDescriptions: Record<keyof typeof mcpTools, string> = {
  testmaster_capabilities:
    "Read versions, enabled features (with the reason a feature is disabled) and limits. Call this first; never emulate a disabled feature.",
  testmaster_validate_document:
    "Validate an ExecutablePlan, ProjectConfig or RunRequest (schema names which) against its contract and plan rules; nothing is stored or run.",
  testmaster_bootstrap:
    "Create or find the project of an approved root; returns projectId, proposedConfig (never written), environment, preflight and next actions. Idempotent. Next: testmaster_analyze_code.",
  testmaster_analyze_code:
    "Snapshot the code: whole codebase (no base), base..head, or base..working tree (dirty=true, needs base). Bounded receipt: counts, skipped files, features {id, stableKey}, diff impact. Not a plan source.",
  testmaster_normalize_requirements:
    "Normalize source revisions into requirements (each with a status) and conflicts; returns sourceSnapshotId and version. Slow: _meta.progressToken notifies. Next: testmaster_review_requirements.",
  testmaster_explore:
    "Browser exploration of features (featureIds from testmaster://projects/{projectId}/features?match=) within a budget; provider/model pick the model; a model call is never cut.",
  testmaster_generate_plan:
    "Generate plan proposals (not tests) from the approved snapshot (sourceSnapshotId); provider/model pick the model. Add secrets, auth profiles and API specs first. Proposals: testmaster://plan-batches/{batchId}.",
  testmaster_trial_plan:
    "Replay proposed plans of a batch against environmentId before review, with no model call; nothing is accepted. Returns per proposal the outcome, gate and the failed steps (expected, observed). Next: testmaster_edit_plan or testmaster_review_plan.",
  testmaster_review_plan:
    "Accept or reject proposals at expectedVersion = the batch version; an optional reason is kept. Returns acceptedProposals {proposalId, testId, revisionId}. Next: testmaster_run_tests.",
  testmaster_generate_tests:
    "Generate code candidates from accepted proposals (proposalIds) or revisions (revisionIds), or repair the candidate of a failed run (runId). Each candidate: id (its revision), testId, testName, code URI. Refused: validationErrors.",
  testmaster_run_tests:
    "Run testIds with environmentId, or a suite (suiteId, replay only), in the sandbox; revisionId pins one test's revision. Mode defaults to replay. wait=true blocks until timeoutMs (runs go on).",
  testmaster_get_run:
    "Get phase, outcome, gate, analysisStatus and the run's test, revision, environment and origin. Summary only: before naming a cause, call testmaster_get_evidence then testmaster_analyze_run.",
  testmaster_get_evidence:
    "Page the evidence manifest (screenshots, DOM, console, network, logs) with resource links; check integrity and freshness, follow nextCursor; failedOnly narrows. Next: testmaster_analyze_run.",
  testmaster_analyze_run:
    "Diagnose a failed run, or a pass whose gate failed, from recorded evidence; model=true (or a model id) adds a model reading, modelStatus says if it was used. Heal only if the advice allows.",
  testmaster_get_analysis:
    "Read the stored analysis without recomputing. NOT_FOUND if never requested; then call testmaster_analyze_run.",
  testmaster_cancel_run:
    "Request cancellation of a run with a reason. A request is not a stop: confirm with testmaster_get_run until the phase is completed.",
  testmaster_compare_runs:
    "Compare two runs: whether they are comparable, why, and each differing field (outcome, steps, artifacts, provenance), paged by cursor and limit. It lists differences; it never judges a regression.",
  testmaster_propose_healing:
    "Propose a candidate changing only the locator of a failed action step of the active plan revision; assertions are never healed. abstained = no safe repair. Next: testmaster_review_healing.",
  testmaster_review_healing:
    "Read a healing proposal: status, diff, risk, preservedAssertions.intact, verification and approval. Next, after review: testmaster_approve_healing or testmaster_reject_healing.",
  testmaster_approve_healing:
    "Approve a reviewed healing proposal at expectedVersion: creates the candidate revision and a verification run (run here when no worker is live); a pass makes it active. Write scope; audited.",
  testmaster_reject_healing:
    "Reject a reviewed healing proposal with a required reason, recorded with the reviewer and time; nothing is applied. Write scope; audited.",
  testmaster_edit_plan:
    "Replace the plan (ExecutablePlan, schema at testmaster://schemas/ExecutablePlan) of a still-proposed proposal at its expectedVersion (validated; references kept). Returns the Proposal plus batchVersion, which testmaster_review_plan takes.",
  testmaster_save_test:
    "Store a plan (ExecutablePlan, schema at testmaster://schemas/ExecutablePlan) as a new test (projectId) or a candidate revision of a test (testId); requirementRefs is required ([] if none). A new test is active at once; a candidate needs promotion.",
  testmaster_import_code:
    "Import Playwright (.ts) or pytest (.py) code as a new test (projectId) or a candidate code revision of a test (testId), checked like `test import`. A candidate needs a passing replay, then promotion.",
  testmaster_promote_revision:
    "Make a candidate revision active at expectedVersion (testVersion of testmaster://tests/{id}/revisions); an optional reason is recorded. A generated candidate needs a passing replay first; healed: testmaster_approve_healing.",
  testmaster_archive_test:
    "Archive a test at expectedVersion (test.version): it leaves active use, its history and evidence stay, no unarchive exists; an optional reason is recorded.",
  testmaster_save_suite:
    "Create a test list, or change one at expectedVersion (selection, addMembers, removeMembers). Run it with testmaster_run_tests suiteId (replay only).",
  testmaster_approve_execution:
    "Approve risky production actions a run was refused for (approval_required): copy details.binding, add a reason, repeat testmaster_run_tests. Bound to that run's inputs; 30 minutes; single use.",
  testmaster_open_report:
    "Locate a committed report of a run (runId) or a run_tests batch (batchId): location, format URIs and sizes in bytes. A read is one page: read offset=0, then add the page's bytes, until sizes[format]; concatenate before parsing.",
  testmaster_add_source:
    "Import a PRD, OpenAPI, GraphQL, Postman or text file inside an approved root as a source revision; returns status, diagnostics and requirementsReset. Next: testmaster_normalize_requirements.",
  testmaster_archive_source:
    "Archive a source at expectedVersion: plan generation and coverage stop using its API operations; its revisions, requirements and tests stay. testmaster_add_source with sourceId reactivates it.",
  testmaster_review_requirements:
    "Edit, adjudicate conflicts, reject (reason required; final) and approve requirements at snapshot expectedVersion, in that order; any list may be empty. Returns per-item results and sourceSnapshotId.",
  testmaster_set_secret:
    "Register a secret from valueFile or fromEnv (never inline) with allowedOrigins; returns metadata only (locator = name). Taken name: testmaster_rotate_secret. Add secrets before plan generation.",
  testmaster_rotate_secret:
    "Store a new value for an existing secret (id or name) from valueFile or fromEnv; the id, name and allowedOrigins stay, secretVersion goes up, and its users get the new value. Returns metadata only.",
  testmaster_save_auth_profile:
    "Create (projectId, name, kind, originBindings, secrets, config) or update (profileId, expectedVersion, fields) an auth profile; secrets are secret ids, username may be plain (unmasked).",
  testmaster_update_environment:
    "Change an environment at expectedVersion; give only the fields to change at top level (authRefs, additionalOrigins, baseUrl, networkProfile, locale, timezone, production, name, serverLog).",
  testmaster_test_auth_login:
    "Sign in once with an auth profile bound to an environment and report the outcome (authenticated, failed, blocked, checkpoint_required); saves nothing, never returns credentials. Scope X.",
};
