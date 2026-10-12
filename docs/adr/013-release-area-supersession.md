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

The M3 gate can pass only through measured, verified evidence for M3 scope plus explicit, quoted deferrals; nothing historical is rewritten and no target is relaxed. Heading-range deferrals (a quote such as `**OPS-024 — Backup consistente (M1–M4).**` for an item whose heading spans milestones) are a judgment by the maintainer and are listed below so a reviewer can reject any one: every `deferred` entry in the registry, split by the kind of quote it relies on (generated from `traceability/registry.json`; 28 items, 45 entries). Claims after M3 remain limited: failed qwen3.8 rounds, generation quality claim-only, no GA, rootful Docker only ([ADR-014](014-rootless-deferral.md)).

## Deferred scope relying on a heading range or milestone section header

| Item | Deferred | Document | Quote |
| --- | --- | --- | --- |
| NFR-003 | M4 | `specs/07-security.md` | `**SEC-030 — Isolamento multi-tenant (M4–M5).**` |
| OPS-021 | M4 | `specs/08-operations.md` | `OPS-021 — Retention e GC concorrente (M1–M4).` |
| OPS-022 | M4 | `specs/10-validation.md` | `**M4 — self-hosted web/team/schedules/GitHub/auth dinâmica** \| UI/autorização/accessibility; PostgreSQL/S3...` |
| OPS-024 | M4 | `specs/08-operations.md` | `**OPS-024 — Backup consistente (M1–M4).**` |
| OPS-024 | M4 | `specs/08-operations.md` | `**OPS-024 — Backup consistente (M1–M4).**` |
| OPS-027 | M4 | `specs/08-operations.md` | `OPS-027 — Correlação, logs bounded e privacidade (M1–M4).` |
| OPS-035 | M6 | `specs/08-operations.md` | `OPS-035 — Runbooks executáveis e autorização (M1–M6).` |
| OPS-037 | M4 | `specs/10-validation.md` | `**M4 — self-hosted web/team/schedules/GitHub/auth dinâmica** \| UI/autorização/accessibility; PostgreSQL/S3...` |
| REQ-028 | M5 | `specs/10-validation.md` | `**M5 — remote/distributed/matrix/advanced/memory** \| Workers remotos com leases/fencing/partições, tunnels...` |
| SEC-013 | M4 | `specs/07-security.md` | `**SEC-013 — TLS e conteúdo autenticado (M1–M4).**` |
| SEC-022 | M4 | `specs/07-security.md` | `**SEC-030 — Isolamento multi-tenant (M4–M5).**` |
| SEC-036 | M4 | `specs/07-security.md` | `**SEC-036 — Criptografia e gestão de chaves (M1–M4).**` |
| SEC-037 | M4 | `specs/07-security.md` | `SEC-037 — Retenção, exportação e exclusão (M3–M4).` |
| SEC-039 | M4 | `specs/07-security.md` | `**SEC-039 — Aprovação vinculada e sem TOCTOU (M3–M4).**` |
| SEC-047 | M4 | `specs/07-security.md` | `**SEC-047 — Forks e GitHub seguro (M2–M4).**` |
| VAL-007 | M4 | `specs/10-validation.md` | `**M4 — self-hosted web/team/schedules/GitHub/auth dinâmica** \| UI/autorização/accessibility` |
| VAL-035 | M5 | `specs/10-validation.md` | `**M5 — remote/distributed/matrix/advanced/memory** \| Workers remotos com leases/fencing/partições, tunnels...` |
| VAL-035 | M6 | `specs/10-validation.md` | `**M6 — SSO/SCIM/plugins/portability/governance/GA** \| SSO OIDC/SAML/SCIM, import/export nativo/TestSprite ...` |
| VAL-045 | M6 | `specs/10-validation.md` | `**M6 — SSO/SCIM/plugins/portability/governance/GA** \| SSO OIDC/SAML/SCIM, import/export nativo/TestSprite ...` |

## Deferred scope relying on a table row or sentence naming the milestone

| Item | Deferred | Document | Quote |
| --- | --- | --- | --- |
| ARCH-004 | M4 | `ROADMAP.md` | `M4-08 — Notificações e workers de equipe` |
| INV-014 | M4 | `specs/09-web-and-integrations.md` | `\| M4 \| Web self-hosted/team, settings/sources/auth dinâmica, listas cross-project, schedules/notificações...` |
| J05 | M4 | `specs/10-validation.md` | `M3 core/M4 UI` |
| J08 | M5 | `specs/10-validation.md` | `VAL-010–013/040; M3/M5` |
| J12 | M4 | `specs/10-validation.md` | `M3 checks básicos/M4 App e previews` |
| J12 | M5 | `specs/10-validation.md` | `Túnel de INT-024 é variante M5` |
| OPS-001 | M4 | `docs/adr/014-rootless-deferral.md` | `Rootless Docker validation is deferred to M4` |
| OPS-001 | M4 | `specs/08-operations.md` | `M4; multiusuário exige controles SEC` |
| OPS-001 | M5 | `specs/08-operations.md` | `Perfis e preflight (M0–M1/M4/M5)` |
| OPS-005 | M4 | `docs/adr/002-storage.md` | `PostgreSQL runtime remains an M4 disabled capability.` |
| OPS-011 | M4 | `ROADMAP.md` | `VAL-033 webhook scopes remain M4/M5 obligations` |
| OPS-011 | M4 | `ROADMAP.md` | `M4-08 — Notificações e workers de equipe` |
| OPS-025 | M4 | `specs/08-operations.md` | `\| M4 \| OPS-005–007/010–012/015–019/024–028/032–033/035–038: servidor/team/scheduler` |
| OPS-027 | M4 | `specs/08-operations.md` | `M4; multiusuário exige controles SEC` |
| OPS-035 | M4 | `specs/08-operations.md` | `M4 \| OPS-005–007/010–012/015–019/024–028/032–033/035–038` |
| OPS-035 | M5 | `specs/08-operations.md` | `M5 \| OPS-007–012/015/019/028–034/037: workers distribuídos/túneis/matriz/modos avançados/memória` |
| OPS-037 | M4 | `specs/08-operations.md` | ``server` \| API/web/controller/scheduler e pool local segregado de workers \| PostgreSQL + filesystem ou S3...` |
| OPS-037 | M4 | `ROADMAP.md` | `M4-08 — Notificações e workers de equipe` |
| OPS-037 | M4 | `ROADMAP.md` | `VAL-033 webhook scopes remain M4/M5 obligations` |
| OPS-037 | M4 | `ROADMAP.md` | `M4-07 — GitHub App e previews` |
| OPS-038 | M4 | `specs/08-operations.md` | `\| M4 \| OPS-005–007/010–012/015–019/024–028/032–033/035–038: servidor/team/scheduler` |
| SEC-022 | M4 | `specs/07-security.md` | `checkpoint autorizado em M4` |
| SEC-047 | M4 | `specs/07-security.md` | `Integração GitHub App em M4 usa installation token curto e permissions mínimas` |
| VAL-033 | M4 | `specs/10-validation.md` | `VAL-026/027/033–037/041/043/045/052 no escopo M4` |
| VAL-035 | M4 | `specs/10-validation.md` | `VAL-026/027/033–037/041/043/045/052 no escopo M4; J09/J10/J12 App/J13 schedule/J16/J17 server` |
| VAL-045 | M4 | `specs/10-validation.md` | `VAL-026/027/033–037/041/043/045/052 no escopo M4` |
