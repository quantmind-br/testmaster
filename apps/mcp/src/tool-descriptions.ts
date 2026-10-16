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
    "Validate an ExecutablePlan, ProjectConfig or RunRequest without storing or running it. Use before creating or running one.",
  testmaster_bootstrap:
    "Create or find the project for an approved root; returns projectId, config, environment, preflight, next actions. Adds an environment for the target origin when none exists; never retargets one (preflight says). Idempotent per root; never installs or runs the app. Next: testmaster_analyze_code.",
  testmaster_analyze_code:
    "Snapshot the code: whole codebase (no base), base..head, or base..working tree (dirty=true, needs base). Bounded receipt: counts, first 50 skipped files, first 100 features {id, stableKey}, diff impact. All features by key: testmaster://projects/{projectId}/features?match=. Not a plan source.",
  testmaster_normalize_requirements:
    "Normalize source revisions into requirements and conflicts (id, reason, requirementIds); returns sourceSnapshotId and version. provider/model pick the model. Slow: _meta.progressToken gets progress notifications. Next: testmaster_review_requirements.",
  testmaster_explore:
    "Browser exploration. featureIds: testmaster://projects/{projectId}/features?match=. budget: steps 1..100, modelCalls 1..steps, timeMs 1000..300000 (browser time only; a model call is never cut). provider/model pick the model; mutationActions: form steps. Failure: testmaster:errorMessage.",
  testmaster_generate_plan:
    "Generate plan proposals (not tests) from the approved snapshot (sourceSnapshotId from testmaster_review_requirements); provider/model pick the model. The model sees only existing secrets and auth profiles (testmaster_set_secret, testmaster_save_auth_profile first). Next: testmaster_review_plan.",
  testmaster_review_plan:
    "Record accept or reject decisions for a proposal batch at expectedVersion. Unselected proposals stay pending. Accepting refuses only the proposals whose cited requirements changed since generation (details.staleProposals). Next: testmaster_generate_tests.",
  testmaster_generate_tests:
    "Generate executable candidates from accepted proposals (proposalIds) or revisions (revisionIds), at least one, one project per call; provider/model pick the model; a model call has no deadline. Refused revisions go to validationErrors. Not execution evidence; review before testmaster_run_tests.",
  testmaster_run_tests:
    "Run testIds with environmentId (revisionId: exact candidate or healed revision) or a list (suiteId) in the sandbox; mode defaults to replay (lists: replay only). jobId re-reads a batch. wait=true blocks until timeoutMs (runs continue), or poll testmaster_get_run. idempotencyKey makes retries safe.",
  testmaster_get_run:
    "Get phase, outcome, gate and analysisStatus. Summary only: if the run did not pass, call testmaster_get_evidence then testmaster_analyze_run before naming a cause.",
  testmaster_get_evidence:
    "Page the evidence manifest (screenshots, DOM, console, network, logs) with resource links. Check integrity and freshness (staleReasons says why), follow nextCursor; failedOnly narrows. Next: testmaster_analyze_run.",
  testmaster_analyze_run:
    "Diagnose a failed run from recorded evidence. model=true (or a model id; provider optional) adds a model reading; modelStatus says if it was used, abstained or unavailable (analysis then stays source rules). A cause without cited evidence is only a suggestion. Heal only if the advice allows.",
  testmaster_get_analysis:
    "Read the stored analysis without recomputing. NOT_FOUND if never requested; then call testmaster_analyze_run.",
  testmaster_cancel_run:
    "Request cancellation of a run with a reason. A request is not a stop: confirm with testmaster_get_run until the phase is completed.",
  testmaster_compare_runs:
    "Compare two runs, paged by cursor and limit. Example: a failed run against a green baseline, to tell regression from drift.",
  testmaster_propose_healing:
    "Propose a candidate revision for a failed run without changing assertions; nothing is applied. Next: testmaster_review_healing. A normal abstained: true result (reasonCode, reason) means no safe repair; healing_not_indicated refuses before any model call.",
  testmaster_review_healing:
    "Read the healing diff, risk, assertions-intact check, verification and approval. Next: testmaster_approve_healing with approval.expectedVersion, only after review.",
  testmaster_approve_healing:
    "Approve at expectedVersion after testmaster_review_healing; creates the candidate revision and a verification run, healed only when it passes (testmaster_get_run). Needs write scope; the decision is recorded with your principal.",
  testmaster_edit_plan:
    "Replace the plan of a still-proposed proposal at expectedVersion (validated; its requirement and evidence references are kept). Returns the proposal with its new version. Next: testmaster_review_plan.",
  testmaster_save_test:
    "Store a plan as a new test (projectId) or a new candidate revision of a test (testId). Returns test, revision, active and nextActions: a new revision is not active until testmaster_promote_revision.",
  testmaster_promote_revision:
    "Make a candidate revision the active one of its test at expectedVersion (test.version). A generated candidate needs a passing replay first: testmaster_run_tests with revisionId. Healed revisions go through testmaster_approve_healing.",
  testmaster_save_suite:
    "Create a list, or change one at expectedVersion: replace the selection, addMembers or removeMembers of a fixed list. Run it with testmaster_run_tests suiteId (replay only).",
  testmaster_approve_execution:
    "Approve risky production actions your run was refused for (approval_required): copy details.binding, add a reason, then repeat testmaster_run_tests. Bound to that revision, environment revision, origins and policy; expires in 30 minutes; used once.",
  testmaster_open_report:
    "Return the testmaster://runs/{id}/report location of the committed report; read it as a paged text resource (JSON by default, ?format=junit|markdown|html) and follow _meta next, then concatenate the pages and parse.",
  testmaster_add_source:
    "Import a PRD, OpenAPI, GraphQL, Postman or text file inside an approved root as a source revision; returns its status and diagnostics. An invalid source (e.g. unsupported OpenAPI) is an error with its diagnostics. Next: testmaster_normalize_requirements.",
  testmaster_review_requirements:
    "Edit, adjudicate conflicts, reject (reason required; final, never planned) and approve requirements at the snapshot expectedVersion, applied in that order; an audited decision of the caller. Returns per-item results and the new sourceSnapshotId. Next: testmaster_generate_plan.",
  testmaster_set_secret:
    "Register a secret from valueFile or fromEnv (never an argument; one trailing newline trimmed) with its allowedOrigins; returns metadata only. Secrets and auth profiles must exist before testmaster_generate_plan. Next: testmaster_save_auth_profile.",
  testmaster_save_auth_profile:
    "Create (projectId, name, kind, originBindings, secrets, config) or update (profileId, expectedVersion, patch) an auth profile from secret ids; returns the view, never credentials. Next: testmaster_update_environment authRefs.",
  testmaster_update_environment:
    "Patch an environment at expectedVersion: authRefs (profiles bound to the target origin), additionalOrigins, baseUrl, networkProfile, locale, timezone, production, name. Returns the environment and its new active revision.",
  testmaster_test_auth_login:
    "Sign in once with an auth profile bound to an environment and report the outcome (authenticated, failed, blocked, checkpoint_required); saves no draft or revision, never returns credentials. Scope X, like auth-profile test-login.",
};
