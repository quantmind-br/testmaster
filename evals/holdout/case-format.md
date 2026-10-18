# External M3 holdout and user-task formats

This directory intentionally contains **no holdout cases**. Cases must use families never used during development, be authored after the evaluated implementation is frozen and be sealed before the first evaluated call; authorship by the implementing team or an agent is allowed and declared truthfully through `implementationKnowledge` ([ADR-012](../../docs/adr/012-automated-only-validation.md)). Labels are sealed, not reviewed; results are labelled `validation: automated-only`. Validator tests use synthetic controls, not evaluation cases. Regression replay, development smoke, and a structurally valid manifest do not establish generalization or homologate any capability.

## Holdout manifest

Use a JSON object with `schemaVersion: "1.0.0"`, a nonempty `id`, `families`, `driver`, `inputs`, `cases` and, for homologation, `implementation`.

- `implementation` is `{commit, frozenAt}`: the full commit hash (40 or 64 hex characters) of the evaluated implementation and the ISO timestamp at which it was frozen. It is optional for structural checks and required by `--homologation`.
- `families` is a nonempty array of `{id, description, provenance}`. Family IDs are unique. Provenance contains `authoredBy` (identity declaration), `authoredAt` (ISO timestamp), `implementationKnowledge: "external" | "implementing-team"` and `developmentUse: "none" | "used"` (whether the family was ever used during development).
- `driver` is a repository-relative module path. `inputs` lists that module and **all** transitive modules, fixtures, source files and data that determine its behavior. Paths and symlink targets must remain inside the repository. Input completeness is the author's responsibility; the tool cannot discover every runtime dependency.
- Each case contains a unique `id`, existing `familyId`, `group` (`healthy`, `bug`, `drift`, `env`, `adversarial`, or supplemental `integration`), validated executable `plan`, driver-specific `variant` and `labels`. A `review` record is rejected: it is superseded by ADR-012.
- `variant` is a driver-owned object with a required `oracle` string naming its independent oracle. `semanticNegative` is required only for cases eligible for automatic or manual healing; cases with eligibility `none` may omit it. Other fields are driver-owned. They are passed intact to the generic harness, also exposed at case top level for compatibility with the existing driver interface.
- `labels.truthKnownToAuthor` contains `{failureKind, mechanism}`; `labels.justifiableFromEvidence` contains `{failureKind, rationale}`. These distinguish internal truth from what the execution evidence justifies. Supported failure kinds are `product_bug`, `contract_violation`, `test_fragility`, `environment`, `security_policy`, and `unknown`.
- Utility labels contain nonempty `correctActions`, possibly empty `acceptableActions` and `dangerousActions` (all unique strings), `expectedHealingAdvice` (`not_indicated`, `proposal_possible`, `manual_review_only`), and `healingEligibility` (`automatic`, `manual`, `none`). Dangerous actions must not overlap correct or acceptable actions. Declare labels, especially eligibility, **before** sealing; never derive labels from evaluated output.
- Dispute rule: the author may declare `labels.labelStatus: "disputed"` **before** sealing when the evidence does not determine a unique justifiable label. Undeclared cases load as `labelStatus: "sealed"`; declaring `"sealed"` or a legacy `reviewStatus` is rejected. A difference between `truthKnownToAuthor` and `justifiableFromEvidence` is expected and is not a dispute. Disputed cases are scored as a separate stratum and are never removed or relabelled after results. When the independent oracle does not reproduce the sealed healthy/defective behaviour, the case fails its reproduction precondition and is reported, not relabelled.

Recommended action vocabulary is shared with layered diagnosis: `collect_more_evidence`, `restore_environment`, `review_security_precondition`, `compare_contract`, `inspect_persistence`, `compare_requirement`, `review_healing_proposal`, and `inspect_locator_candidates`. Dangerous action labels should include the concrete decisions the scenario is intended to catch, such as weakening assertions, hiding a product defect or applying an unapproved change. Labels are authored, not inferred by the validator.

### Driver contract

The module must export the existing `evals/m3/fixture.d.mts` methods:

- `materialize(root, corpus, item, side, canary?)` returns `{directory, digests, transformationHash}`.
- `startCase(root, corpus, item, side, port?, canary?)` returns `{url, dbPath, close, materialized}`.
- `independentOracle(shop, name)` and `executedProductOracle(shop, token)` return `{healthy, defective, observed}`.

The `item` includes the original `variant`, labels and family identity. Drivers may export `caseControls(item)` for explicit unavailable-target, collection-failure, missing-credential, semantic-candidate and integration-workflow controls, and `validateCase(root, corpus, item)` for driver-specific validation. Loading a driver executes its code: only load trusted reviewed modules, not arbitrary downloaded manifests.

### Sealing and checking

From the repository root, after building tools:

```sh
node tools/dist/evals/m3.js holdout-seal authored-manifest.json sealed-manifest.json
node tools/dist/evals/m3.js holdout-check sealed-manifest.json
node tools/dist/evals/m3.js holdout-check sealed-manifest.json --homologation
```

Sealing validates all required labels and writes a new file exclusively. `seal` records `sealedAt`, SHA-256 of canonical manifest content excluding the seal, and SHA-256 of every declared input. Checking rejects altered labels, missing inputs, changed input bytes, traversal and authorship after sealing. To revise any label or input, author and seal a new manifest rather than mutating the old one. Historical registrations are immutable and unchanged.

`--homologation` requires the `implementation` freeze, every family declared `developmentUse: "none"` and every family authored at or after `implementation.frozenAt`; same-team or agent authorship is accepted and listed in the result's limitations. The result reports `validation: "automated-only"`, `disputedCases` and `provenanceVerified: false`: authorship, implementation knowledge, development use and the freeze are declarations, not machine-verifiable facts. This check is only a prerequisite for capability evidence; it does not measure utility or approve release.

## Prompt-leakage guard

Labels, mutant names, case identifiers, oracle names and the author's mechanism/rationale prose must never appear in a model request ([VAL-016](../../specs/10-validation.md)). `tools/src/evals/leakage.ts` derives the forbidden set from the sealed manifest at runtime (`sealedLeakageSet`) and provides `startLeakageGuard`, a local OpenAI-compatible boundary: the evaluation profile points at it, every chat-completion body (raw and every decoded string) is scanned before dispatch, a hit is answered with HTTP 451 and never forwarded, only kinds, case IDs and a body hash are retained, and `assertRoundNotInvalidated` turns any hit into a void round. Shared action vocabulary (`collect_more_evidence`, ...) is code-owned diagnosis output and is deliberately not forbidden.

Known limit, reproduced by `tools/src/evals/holdout-leakage.docker.test.ts` (evidence `validation/results/m3-holdout-prompt-leakage-audit.json`): the healing prompt builder sends the whole plan, and the sealed plans are named after their case ID (`cl-drift-02`, which spells the group). The round harness (`executeRound` in `tools/src/evals/m3.ts`) now gives each test an opaque name (`opaquePlanName`) and routes the provider through the guard; a recorded leak stops the round with `stopReason: "leakage"`. Rounds 4-8 predate the guard, their ledgers retain only `promptHash`, and their healing stage is void and not rescored; round 9 is the first guarded round.

## Offline replay and limited model smoke

```sh
node tools/dist/evals/m3.js replay RESULTS_DIR OUT_LABEL [CASE_ID ...]
node tools/dist/evals/m3.js replay RESULTS_DIR OUT_LABEL --model CASE_ID ...
```

Each retained workspace (both `repo/` and `home/`) is copied to a fresh temporary directory, opened with copy-local cwd/home/data/config environment, and removed even on failure. Only the copy is analyzed; no execution worker or Docker is invoked. Symbolic links in retained workspaces are rejected rather than allowed to escape the copy. Missing transformed runs are reported explicitly; no run is invented. Outputs under `evals/results/dev-replay-*` carry `development: true`, `registered: false`, and `holdout: false`, plus rules/model observations, shared arm scoring and limitations.

The optional model arm is development smoke only and requires separate operator authorization. It uses Qwen `qwen3.8-flash` with `medium` reasoning only; no number of cases, generation requests (including repair and retry requests) or tokens limits it. Inventory requests are reported separately from generation calls. An isolated copied profile uses a local forwarder that pins the destination, model and effort of every completion. For each completion it records the gateway's exact full canonical request UTF-8 byte count plus 8,192 output tokens as an estimated charge; the estimate is never refunded from provider-reported usage and never refuses a request. It stops on the first inventory, transport or HTTP provider failure; no substitute model is attempted. Sanitized wire metadata proves model, effort, request bytes, estimated charge and response status without recording keys or prompt content. Global operator profiles and original retained workspaces are never modified. Existing model-call history is excluded from new smoke usage; reuse of a prior model receipt cannot count as a live smoke measurement.

## User-task protocol (superseded)

Under [ADR-012](../../docs/adr/012-automated-only-validation.md) no gate requires a human task study; assisted healing is accepted through automated review-surface acceptance. The format below remains a validator for optional, non-gating studies.

Create a JSON study with `schemaVersion: "1.0.0"`, `id`, nonempty `participants`, and completed `sessions`. This protocol is prepared only: no participants or measurements have been created.

Each participant is `{id, consent: true}`. Each session is `{participantId, taskId, order, observations}`. A participant/task pair is unique. `order` contains each of `none`, `rules`, and `model` exactly once. Counterbalance order across sessions so each arm's count at each position differs by no more than one, with at least two distinct orders. Every declared participant needs a completed session.

Observations appear in the declared order and contain `{arm, decision, decisionCorrect, decisionSafe, startedAt, decidedAt, elapsedMs, manualWorkMs, manualActions}`. The decision is a nonempty recorded action; correctness and safety use an independently established task rubric. Timestamps must be valid and nonoverlapping. `elapsedMs` must equal the timestamp difference; manual work is a nonnegative integer no greater than elapsed time; manual actions are a nonnegative integer.

```sh
node tools/dist/evals/m3.js task-check study.json
```

The validator aggregates participants, sessions, per-arm decision time, manual work, manual actions, correctness and safety. Missing participants, consent, observations, unbalanced order or inconsistent timers are rejected. Participant identity, consent and measurement integrity remain declared; aggregation does not demonstrate that a study actually occurred or homologate assisted healing. Real studies need recruited consenting participants, reviewed tasks and preserved observations.
