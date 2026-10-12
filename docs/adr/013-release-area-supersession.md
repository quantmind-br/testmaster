# ADR-013: Release area scope, supersession and deferred residual scope

- Status: accepted
- Date: 2026-10-12
- Scope: the cumulative milestone gate (`check --milestone-gate Mx`) and its release area register in `traceability/registry.json`. Related: [ADR-012](012-automated-only-validation.md), VAL-054, [ROADMAP](../../ROADMAP.md) gate definitions.

## Context

`check --milestone-gate M3` charged every release area to the cumulative gate: all 19 areas, including the six M2 generation rounds, the GA `public-release` area, and seven failed or blocked qwen3.8 and early Muse M3 rounds that a later sealed round (round 9) re-measured and passed with unchanged targets. A failed historical measurement can never become passed and must not be edited, so the gate was red by construction even though the capability it measured had been re-established. Items whose normative text spans several milestones (`(M1–M4)`) were likewise forced to be either fully verified or fully blocked.

## Decision

1. **Area metadata (additive).** Every release area carries `gate` (`M0`..`M6`, or `claim`) and `series`. A non-passed area may carry `supersededBy`, naming a passed area of the same series that appears later in `release.areas`. `decision`, `observation`, `interval`, `n`, `reason` and `approvedTarget` of historical areas are never changed by this rule.
2. **Gate rule.** An area blocks milestone gate `G` iff `gate !== "claim"`, `gate <= G`, `decision !== "passed"` and it has no valid `supersededBy`. `claim` areas block only the claim they measure (here: the homologated model-generation claim, [ROADMAP](../../ROADMAP.md) M2 note). `public-release` is `M6`: the cumulative M3 gate is not the public-GA gate. Capability gates keep evaluating exactly their `requiredAreas`; a capability gate may not require a superseded area (definition error).
3. **Supersession validity.** `supersededBy` is rejected unless the target exists, belongs to the same series, appears later in the array, has `decision: "passed"` and is not itself superseded, and the superseded area is not passed.
4. **Claim scope.** The superseding area defines the claim scope: model, configuration and sealed family of round 9 (`muse-spark-1.3-contributor`, xhigh). The failed qwen3.8 rounds stay visible as history for their configuration; no claim covers qwen3.8 healing or diagnosis.
5. **Deferred residual scope.** A `verified` item may carry `deferred: [{milestone, scope, specQuote:{path,text}}]` for clauses a later milestone owns. `milestone` must be later than the item's. `specQuote.path` must match `SPEC.md`, `ROADMAP.md`, `specs/*.md` or `docs/adr/*.md`; `text` must occur literally in that file and name the deferred milestone. At gate `G` an item blocks when any entry has `milestone <= G`, so deferral can never pass a later gate.
6. **Hardening.** `verified` together with `blockedReason` is an error in every mode; `code` paths get the same confined existence check as `evidence`; plain `check` runs the release coverage check for every verified item.
7. **Normative tension.** [specs/08-operations.md](../../specs/08-operations.md) section 14 lists OPS-011/022/037 whole under M3, while [ROADMAP](../../ROADMAP.md) keeps webhook scopes in M4/M5. Webhook and notification clauses are deferred to M4 citing the roadmap; the rest is implemented and verified in M3.

## Consequences

The M3 gate can pass only through measured, verified evidence for M3 scope plus explicit, quoted deferrals; nothing historical is rewritten and no target is relaxed. Heading-range deferrals (a quote such as `**OPS-024 — Backup consistente (M1–M4).**` for an item whose heading spans milestones) are a judgment by the maintainer and are listed below so a reviewer can reject any one. Claims after M3 remain limited: failed qwen3.8 rounds, generation quality claim-only, no GA, rootful Docker only ([ADR-014](014-rootless-deferral.md)).
