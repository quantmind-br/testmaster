# ADR-012: Automated-only validation, no human review

- Status: accepted
- Date: 2026-10-09
- Scope: validation, evaluation, capability homologation and release evidence. Supersedes the human-review prerequisites previously stated in [specs/10](../../specs/10-validation.md), [ROADMAP](../../ROADMAP.md) M3, [evals/preregistration.md](../../evals/preregistration.md) and [evals/holdout/case-format.md](../../evals/holdout/case-format.md).

## Context

The validation specification required independent human labels, two-reviewer adjudication, holdout families authored outside the implementing team, an independent security sign-off for automatic healing, a participant task study for assisted healing, manual WCAG review of non-automatable criteria, manual security review and a human release sign-off. The maintainer decided on 2026-10-09 that **no human review of any kind will be performed**. Keeping those prerequisites would leave gates blocked by design; recording simulated human evidence is forbidden. The criteria are therefore rewritten as observable automated oracles, with claims narrowed to what automation proves.

## Decision

No validation, evaluation, homologation or release gate requires human review, human labels, human participants or human sign-off. Each former prerequisite is replaced as follows:

| Former human prerequisite | Automated replacement |
| --- | --- |
| Independent human labels; reviewer differs from author | Labels are declared and sealed (SHA-256) before the first evaluated call on the case. The independent deterministic oracle reproduces healthy pass and defective failure from the fixed manifest. Provenance records the real author and `implementationKnowledge` truthfully. |
| Two-reviewer adjudication | Deterministic dispute rule: a case is `disputed` when the sealed author label, the evidence-justifiable label and the oracle disagree. Disputed cases are a separate reported stratum; they are never removed or relabelled after results. |
| Holdout authored outside the implementing team | Holdout families never used in development, authored and sealed after the evaluated implementation is frozen and before its first evaluation call. Authorship by the implementing team or an agent is allowed and declared. |
| Independent security sign-off for automatic healing | Automated safety evidence: critical adversarial healing suite with zero unsafe auto-applied patches and zero false repairs, critical mutation inventory without survivors, a semantic-negative control for every eligible case and protected-assertion hash integrity. |
| Participant task study for assisted healing | Automated review-surface acceptance: candidate validated in isolated replay with positive and semantic-negative controls, complete `HealingReview` projection, stale-approval refusal, cross-project denial and measured `reviewLoad`. |
| Second human GitHub identity for fork isolation | Hosted cross-owner fork proof executed by automation with any GitHub owner distinct from the base repository owner (for example an organization-owned base repository and a fork in another account). This is test infrastructure, not review. |
| Manual WCAG review of non-automatable criteria | Not performed. Those criteria are reported as unverified; no conformance claim covers them. |
| Manual security review | Versioned threat model plus adversarial and negative-control suites. No claim beyond the tested threats. |
| LLM-judge conflicts escalated to a human | The deterministic oracle decides; conflicts become `disputed`/`inconclusive`. An LLM judge never decides a gate alone. |
| Human release sign-off | Immutable automated release evaluation record (commit/tag, manifests, metrics, per-area decision) produced by the gates. |

### Claim limits

Results validated under this ADR are labelled `validation: automated-only`. They make no claim of independent review, human usability, human decision-time or workload gain, or generalization beyond the sealed families. Same-team or agent authorship is a declared limitation, not hidden.

### Unchanged

Deterministic and independent oracles (independent of the generator, not of a person), non-negotiable invariants, the prohibition of waivers for critical risks, preregistration and stopping rules remain. Historical results and preregistrations that mention pending human review are immutable records and are not rewritten.

Product runtime approvals (proposal acceptance, healing approval, destructive-action approval, `ProductReviewer`/`reviewer` roles) are product behaviour performed by the product's users, not validation review. This ADR does not change them.

## Consequences

Capability gates become reachable by automated evidence but remain blocked until that evidence exists. Registry gate reasons, the validation spec (the release area `m3-assisted-task-study` is retired in favor of `m3-assisted-review-surface`; historical logs keep the old ID), the roadmap and the evaluation formats are updated accordingly. Tooling that still enforces human review must follow: `holdout-check --homologation` currently requires `implementationKnowledge: "external"` and `independently-reviewed` cases (`tools/src/evals/holdout.ts`), and the participant task-session validator (`tools/src/evals/user-tasks.ts`) is no longer a gate input.

## Authority

[SPEC](../../SPEC.md), [validation](../../specs/10-validation.md), [roadmap](../../ROADMAP.md). This record describes a decision, not proof that any gate has passed.
