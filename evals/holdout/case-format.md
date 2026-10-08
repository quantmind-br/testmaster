# External M3 holdout and user-task formats

This directory intentionally contains **no holdout cases**. Cases must be authored outside the team implementing the capability. Validator tests use synthetic controls, not evaluation cases. Regression replay, development smoke, and a structurally valid manifest do not establish generalization or homologate any capability.

## Holdout manifest

Use a JSON object with `schemaVersion: "1.0.0"`, a nonempty `id`, `families`, `driver`, `inputs`, and `cases`.

- `families` is a nonempty array of `{id, description, provenance}`. Family IDs are unique. Provenance contains `authoredBy` (identity declaration), `authoredAt` (ISO timestamp), and `implementationKnowledge: "external" | "implementing-team"`.
- `driver` is a repository-relative module path. `inputs` lists that module and **all** transitive modules, fixtures, source files and data that determine its behavior. Paths and symlink targets must remain inside the repository. Input completeness is the author's responsibility; the tool cannot discover every runtime dependency.
- Each case contains a unique `id`, existing `familyId`, `group` (`healthy`, `bug`, `drift`, `env`, `adversarial`, or supplemental `integration`), validated executable `plan`, driver-specific `variant`, `labels`, and `review`.
- `variant` is a driver-owned object with a required `oracle` string naming its independent oracle. `semanticNegative` is required only for cases eligible for automatic or manual healing; cases with eligibility `none` may omit it. Other fields are driver-owned. They are passed intact to the generic harness, also exposed at case top level for compatibility with the existing driver interface.
- `labels.truthKnownToAuthor` contains `{failureKind, mechanism}`; `labels.justifiableFromEvidence` contains `{failureKind, rationale}`. These distinguish internal truth from what the execution evidence justifies. Supported failure kinds are `product_bug`, `contract_violation`, `test_fragility`, `environment`, `security_policy`, and `unknown`.
- Utility labels contain nonempty `correctActions`, possibly empty `acceptableActions` and `dangerousActions` (all unique strings), `expectedHealingAdvice` (`not_indicated`, `proposal_possible`, `manual_review_only`), and `healingEligibility` (`automatic`, `manual`, `none`). Dangerous actions must not overlap correct or acceptable actions. Declare labels, especially eligibility, **before** sealing; never derive labels from evaluated output.
- `review` contains `status: "pending-independent-review" | "independently-reviewed" | "disputed"` and unique `reviewers` identity strings. Reviewers cannot include the family author. Independent review requires at least one reviewer.

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

Sealing validates all required labels and writes a new file exclusively. `seal` records `sealedAt`, SHA-256 of canonical manifest content excluding the seal, and SHA-256 of every declared input. Checking rejects altered labels, missing inputs, changed input bytes, traversal, authorship after sealing, and self-review. To revise any label, review or input, author and seal a new manifest rather than mutating the old one. Historical registrations are immutable and unchanged.

`--homologation` additionally requires every case independently reviewed and every family declared external to the implementing team. The result explicitly reports `provenanceVerified: false`: authorship, reviewer identities and implementation knowledge are declarations, not machine-verifiable facts. This check is only a prerequisite for capability evidence; it does not measure utility or approve release.

## Offline replay and limited model smoke

```sh
node tools/dist/evals/m3.js replay RESULTS_DIR OUT_LABEL [CASE_ID ...]
node tools/dist/evals/m3.js replay RESULTS_DIR OUT_LABEL --model CASE_ID ...
```

Each retained workspace (both `repo/` and `home/`) is copied to a fresh temporary directory, opened with copy-local cwd/home/data/config environment, and removed even on failure. Only the copy is analyzed; no execution worker or Docker is invoked. Symbolic links in retained workspaces are rejected rather than allowed to escape the copy. Missing transformed runs are reported explicitly; no run is invented. Outputs under `evals/results/dev-replay-*` carry `development: true`, `registered: false`, and `holdout: false`, plus rules/model observations, shared arm scoring and limitations.

The optional model arm is development smoke only and requires separate operator authorization. It allows at most four selected cases, Qwen `qwen3.8-flash` with `medium` reasoning only, at most eight generation requests (including repair and retry requests), and 200,000 conservative tokens. Inventory requests are reported separately from generation calls and consume no token reservation. An isolated copied profile uses a local admission forwarder. Before forwarding each completion it reserves the gateway's exact full canonical request UTF-8 byte count plus 8,192 output tokens. Reservations are cumulative and never refunded from provider-reported usage. It stops on the first inventory, transport or HTTP provider failure; no substitute model is attempted. Sanitized wire metadata proves model, effort, request bytes, reserved charge and response status without recording keys or prompt content. Global operator profiles and original retained workspaces are never modified. Existing model-call history is excluded from new smoke usage; reuse of a prior model receipt cannot count as a live smoke measurement.

## User-task protocol

Create a JSON study with `schemaVersion: "1.0.0"`, `id`, nonempty `participants`, and completed `sessions`. This protocol is prepared only: no participants or measurements have been created.

Each participant is `{id, consent: true}`. Each session is `{participantId, taskId, order, observations}`. A participant/task pair is unique. `order` contains each of `none`, `rules`, and `model` exactly once. Counterbalance order across sessions so each arm's count at each position differs by no more than one, with at least two distinct orders. Every declared participant needs a completed session.

Observations appear in the declared order and contain `{arm, decision, decisionCorrect, decisionSafe, startedAt, decidedAt, elapsedMs, manualWorkMs, manualActions}`. The decision is a nonempty recorded action; correctness and safety use an independently established task rubric. Timestamps must be valid and nonoverlapping. `elapsedMs` must equal the timestamp difference; manual work is a nonnegative integer no greater than elapsed time; manual actions are a nonnegative integer.

```sh
node tools/dist/evals/m3.js task-check study.json
```

The validator aggregates participants, sessions, per-arm decision time, manual work, manual actions, correctness and safety. Missing participants, consent, observations, unbalanced order or inconsistent timers are rejected. Participant identity, consent and measurement integrity remain declared; aggregation does not demonstrate that a study actually occurred or homologate assisted healing. Real studies need recruited consenting participants, reviewed tasks and preserved observations.
