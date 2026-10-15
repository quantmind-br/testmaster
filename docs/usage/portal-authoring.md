# Authoring in the portal

The portal (milestone M4) reviews generated proposals and edits tests with the same `/v1` routes the CLI and
MCP use. Nothing here is a private endpoint: the network log of the authoring journey is checked against the
route catalog. Text from sources, models, plans, DOM and reports is always rendered as escaped text.

## Generating and resuming

- **Proposals** (`/projects/:projectId/proposals`) shows the approved requirements, the project's token
  budget (or "No limit set"), the number of model calls so far and the batches of the project.
- **Generate proposals** needs approved requirements and a model provider the operator policy allows. Cancelling closes the request; the
  server cancels the model call when the connection drops, and nothing is stored. Sources and requirements
  prepared earlier stay as they were. **Resume generation** repeats the request with the same idempotency
  key, so a generation that finished before the cancel arrived is returned instead of billed twice.
- A batch whose source or approved requirements changed after generation is shown as **Stale source** with
  the reason. Its proposals cannot be selected; regenerate or review the sources. A new source never
  silently invalidates or silently keeps an old proposal.

## Reviewing a batch

`/proposal-batches/:proposalBatchId` lists the proposals with provenance (model call, human edits, refinement
origin), validation, the revision acceptance would create, an estimate of the duration and similar tests.

- **Selection is explicit.** `POST /v1/proposal-batches/{id}/preview` returns what each selected proposal
  would create. Invalid, already decided or stale proposals are shown with the issue and cannot be selected.
- **Partial accept is atomic and idempotent.** Accepting A and B of A/B/C creates both tests or neither;
  C stays pending. Repeating the request with the same key returns the original receipt and changes
  nothing.
- **Duplicates.** A proposal with the same runner, the same ordered steps and an overlapping requirement as
  an existing test or another selected proposal is an exact duplicate. Accepting it needs
  `acknowledgedDuplicates` (the page asks for an explicit decision and the audit trail records
  `proposal.duplicate_acknowledged`); without it the server answers `PRECONDITION_FAILED`
  `duplicate_decision_required`. Similar proposals (score at least 0.5) only show a warning.
- **A proposal that is not valid never becomes a test**, even when the model provider is unavailable:
  accepting a stored, valid proposal does not call a model.

### Who may accept (UX-019)

Accepting makes a test active, so it is an interactive act by an enabled human principal: a person with a
browser session, or the host's local token. API tokens (`tm_api_`), worker and operator credentials, service
accounts and controller scopes are refused with `POLICY_DENIED` and `details.reason`
`interactive_acceptance_required` or `human_acceptance_required`. An acceptance given in an interactive session
is not inherited by CI or other automation. The preview states this in `policy`; a role without write
permission is reported with `write_permission_required` and the page disables the action with the reason.

## Editing a test

`/tests/:testId` shows the immutable revisions. A revision is never modified; each state is derived from
facts: **Current** (the active revision), **Candidate** (awaiting promotion), **Accepted**, **Superseded**
and **Executed** (at least one Run used it). A Run keeps the revision it started with: after revision B is
saved, a Run of A still shows A and *Download revision* returns A's plan.

- **Validation before running** (`POST /v1/projects/{id}/plan-validations`). The editor checks structure,
  step sequence, types, references, assertions, dependencies, secrets and permissions. Each issue names the
  JSON pointer and the step. **Run revision** is offered only when every check passes and the caller may
  execute in the project; a missing secret or a dependency cycle blocks it.
- **Drafts** (`GET|PUT|DELETE /v1/tests/{id}/draft`). The editor autosaves a per-principal draft on the
  server. A draft never changes a published revision; it survives a reload, is flagged when the test has a
  newer revision than the draft's base, and is discarded explicitly. `PUT` with a stale `expectedVersion`
  answers `REVISION_CONFLICT`.
- **Local undo** restores the previous text of the editor; **Review and publish** shows the diff between the
  base revision and the edit and asks for a justification before saving a new revision.
- **Conflicts.** Saving with an out-of-date `If-Match` answers `REVISION_CONFLICT` with a diff of the current
  stored plan. The page shows both versions and keeps the edit; nothing is overwritten.

## History (UX-024)

`GET /v1/tests/{id}/history` lists each revision with author, timestamp, justification, origin
(manual/generated/healed/imported) and the kinds of change. The kinds are `intent_assertion`, `operational`
and `source_model` (plus `initial`). They are computed from the plans: an assertion diff is never labelled
only as healing. Promoting a revision records `revision.promoted` in the audit trail with the justification.

## Refinement chat (REQ-054)

`POST /v1/proposals/{id}/refinements` and `POST /v1/tests/{id}/refinements` send a message to the model through
the normal `ModelService` (provider allowlist, budget and the usage ledger apply). The answer is a **new proposal**
with its own batch (`origin: refinement`), reviewed and accepted like any other; it never edits a revision.
The refinement may add assertions, but it may not remove or weaken a required one (`assertion_weakened`) and
a reply that changes nothing is refused (`no_change`). Turns are stored append-only; text in the chat is data
and cannot change those invariants.

## Operational notes

- State-changing requests are rate limited per principal (20 burst, 1/s). The preview and plan-validation
  calls are `POST`s, so a busy review page spends the same budget as an edit; the pages debounce them.
- The refinement and generation routes return `201`; cancellation of a model call is by closing the
  connection, there is no separate cancel route.
- Migration `0013_authoring_portal` (M4 integration target number 0020) adds `test_drafts` and
  `refinement_turns`; both tables have tenant row-level security on PostgreSQL.
