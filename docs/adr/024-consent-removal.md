# ADR-024: Removal of the consent gates

- Status: accepted
- Date: 2026-10-14
- Amends: [ADR-007](007-structured-output.md) (consent requirement), [ADR-009](009-agent-targets.md) (skill wording)
- Scope: model gateway, settings, integrations, onboarding, agent guidance, restore and the specifications that required consent.

## Context

Earlier specifications and implementations required opt-in "consent" in several unrelated places: per project, provider and data class before any model call (plus a separate unknown-cost grant), per-scope consent when configuring an integration, separate consent for scan, load, security and tunnel at onboarding, and consent wording in the installed agent guidance. The operator decided that none of these gates should exist. The protections they sat next to are independent controls and remain.

## Decision

1. **Model data.** A model-assisted request is gated by the operator's provider allowlist (`allowedModelProviders` in `policy.json`), the minimisation and redaction pipeline, the data that is never sent whatever a request declares (credentials, secrets, environment values, private keys, storage state, raw traces), byte/token ceilings, budget reservation before the call and the absence of silent model or provider fallback (SEC-006, OPS-029, OPS-030). A provider outside the allowlist receives nothing (`POLICY_DENIED`). `dataPolicy.dataClasses` on a request is descriptive metadata for the cache key and audit; it authorizes nothing.
2. **Unknown cost is budget policy, not consent.** A model without a price table is permitted and its cost is recorded as `unknown`, never zero. If the project has a monetary budget, the reservation for an unpriced model is unknown and the call is refused before it is sent with `QUOTA_EXCEEDED` and `reasonCode: "budget_exhausted"`, because the ceiling could not be enforced. Token ceilings keep applying. No flag, option or stored allowance exists.
3. **Removed surfaces.** The CLI `consent grant|revoke|status` group and `--allow-unknown-cost`, `GET`/`PUT /v1/projects/{id}/model-consents[/{provider}]` and the `consents` onboarding choices are removed rather than turned into no-ops. Settings expose a read-only `GET /v1/projects/{id}/model-providers` (endpoint origin, remote flag, models, whether the policy allows the provider); the portal shows the same list.
4. **Integrations.** Configuring an integration needs the administrator scope. The integration keeps the principal that created it as `createdBy` (the identity it acts as, formerly the consent grantor); the adapter `requiredScopes` check and the stored consent record are gone. Revocation stays terminal and still clears secret bindings.
5. **Onboarding and risky operations.** Scan, load, security probes and tunnels are not enabled by an onboarding consent flag. They are governed by environment risk classes, policy and approvals (SEC-038, SEC-039); a tunnel is also an explicit M5 capability.
6. **Agent guidance.** The generated skill and the managed instructions section no longer mention consent; they tell agents to require scopes, a provider the user-level policy allows, and approvals. `AGENT_SKILL_VERSION` is unchanged (`1.0.0`), so installed copies of the earlier text show as `outdated` in `agent status` and are upgraded by a new `agent install`; user-owned installed skills are never rewritten by this change.
7. **Storage.** Migration 19 drops the `consents` table and migration 20 moves each integration's recorded acting principal into `createdBy` (falling back to the actor of its creation audit event) and removes the consent record; lifecycle state is untouched. Unresolvable attribution aborts the migration rather than inventing an owner. Migration 21 removes only `choices.consents` from saved onboarding state so existing wizards remain editable; their version and historical events are preserved. Restore replays revocations of secrets, images, approvals and the other revocation ledgers, no longer consent revocations.

## Consequences

- Operators contain a compromised or unwanted model provider by removing it from `allowedModelProviders`. The policy is read when the application starts, so a running server or worker is restarted.
- Every allowed provider receives the minimised, redacted context of every model-assisted request, with no per-project veto. This is the intended trade-off and is stated in the threat model (B-04).
- Historical evidence is immutable: results under `validation/results`, `evals/results` and `evals/rounds`, earlier changelog entries and applied migrations 1–18 keep their original wording and structure, including the consent tables they created. Registry items and ADR text that describe consent are historical claims and are reconciled in the registry rather than rewritten in the evidence.
- The authenticated-role model, scopes as permissions, the sandbox, budgets, the provider allowlist and destructive-operation approvals (SEC-038/039) are unchanged and are not consent.

## Authority

[SPEC](../../SPEC.md), [security](../../specs/07-security.md), [operations](../../specs/08-operations.md), [web and integrations](../../specs/09-web-and-integrations.md). This record describes a decision, not proof that every control has passed acceptance.
