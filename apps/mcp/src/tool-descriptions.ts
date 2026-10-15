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
    "Create or find the project for an approved root; returns projectId, proposed config, preflight and missing actions. Idempotent per root; never installs or runs the app. Next: testmaster_analyze_code.",
  testmaster_analyze_code:
    "Snapshot the code: whole codebase (no base), base..head, or base..working tree (dirty=true, needs base). Returns snapshot, scanned/skipped files, warnings and, for a diff, changes plus impact.selectedFiles (changed + dependents) and excludedFiles (analyzed, unaffected). Not a plan source.",
  testmaster_normalize_requirements:
    "Normalize source revisions into requirements and conflicts; returns sourceSnapshotId (fingerprint) and version. Slow: pass a progressToken. Humans approve requirements (CLI or portal), then testmaster_generate_plan.",
  testmaster_explore:
    "Run a budgeted browser exploration of features. budget: steps 1..100, modelCalls 1..steps, timeMs 1000..300000; provider/model pick the resolution model; mutationActions approves typed form steps. A failed job's cause: extensions['testmaster:errorMessage']. wait=true blocks; else track jobId.",
  testmaster_generate_plan:
    "Generate plan proposals (candidates, not tests) from the approved requirement snapshot (sourceSnapshotId = its fingerprint). Declined: extensions['testmaster:unsupportedRequirements']; refused: INVALID_ARGUMENT details.refused, or partialGeneration. Next: testmaster_review_plan.",
  testmaster_review_plan:
    "Record accept or reject decisions for a proposal batch at expectedVersion. Unselected proposals stay pending. Next: testmaster_generate_tests.",
  testmaster_generate_tests:
    "Generate executable candidates from accepted proposals or revisions, one project per call; provider/model pick the model. budget.deadlineMs limits each revision's call (default 300000); refused or timed-out revisions go to validationErrors. Not execution evidence; review before testmaster_run_tests.",
  testmaster_run_tests:
    "Run testIds with environmentId, or a list (suiteId, replay only), in the sandbox; returns the batch receipt with live run status. wait=true blocks until timeoutMs (UPSTREAM_TIMEOUT; runs continue), else poll testmaster_get_run. idempotencyKey makes retries safe.",
  testmaster_get_run:
    "Get phase, outcome, gate and analysisStatus. Summary only: if the run did not pass, call testmaster_get_evidence then testmaster_analyze_run before naming a cause.",
  testmaster_get_evidence:
    "Page the evidence manifest (screenshots, DOM, console, network, logs) with resource links. Check integrity and freshness, follow nextCursor; failedOnly narrows. Next: testmaster_analyze_run.",
  testmaster_analyze_run:
    "Diagnose a failed run from recorded evidence. model=true (or a model id; provider optional) adds a model reading; modelStatus says if it was used, abstained or unavailable (analysis then stays source rules). A cause without cited evidence is only a suggestion. Heal only if the advice allows.",
  testmaster_get_analysis:
    "Read the stored analysis without recomputing. NOT_FOUND if never requested; then call testmaster_analyze_run.",
  testmaster_cancel_run:
    "Request cancellation of a run with a reason. A request is not a stop: confirm with testmaster_get_run until the phase is completed.",
  testmaster_compare_runs:
    "Compare two runs, paged by cursor and limit. Example: a failed run against a green baseline, to tell regression from drift.",
  testmaster_propose_healing:
    "Propose a candidate revision for a failed run without changing assertions. Nothing is applied. Next: testmaster_review_healing.",
  testmaster_review_healing:
    "Read the healing diff, risk, assertions-intact check, verification and approval. Next: testmaster_approve_healing with approval.expectedVersion, only after review.",
  testmaster_approve_healing:
    "Approve at expectedVersion; creates the candidate revision and a verification run, healed only when it passes (testmaster_get_run). A bearer token needs a HealingProposal:approve grant; scopes R, W, X, A never imply it.",
  testmaster_open_report:
    "Return the testmaster://runs/{id}/report location of the committed report; read it as a paged blob resource and follow _meta next.",
};
