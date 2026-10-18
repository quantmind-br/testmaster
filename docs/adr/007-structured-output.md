# ADR-007: JSON object structured output with local validation

- Status: accepted
- Date: 2026-10-05
- Scope: approved M0–M2 implementation plan; later profiles remain capability-gated.
- Amended by: [ADR-024](024-consent-removal.md) (the project/provider/data-class consent requirement below is removed; the provider allowlist stays), [ADR-026](026-budget-removal.md) (the budget reservation below is an accounting record, never a refusal).

## Context

The selected QuantForge deepseek-v4.1-flash model supports json_object but rejects json_schema with HTTP 400 in the verified provider probe. Provider claims do not replace local validation.

## Decision

Use declared/negotiated capabilities and response_format type json_object with the shared strict Ajv 2020-12 TypeBox catalog. Validate locally and allow at most two repair calls, each recorded as ModelCall. Invalid-after-repair never creates an active test. Missing required capability returns CAPABILITY_UNAVAILABLE; never silently switch models. Require project/provider/data-class consent and allowlist before any byte is sent *(historical wording; consent removed by ADR-024, the allowlist remains the gate)*; reserve budget before each call.

Prompt rendering factors byte-identical repeated JSON Schema nodes into local `$defs`/`$ref`
instead of sending the expanded recursive executable-plan catalog. It preserves schema semantics
and keeps bounded requests practical; local validation always uses the original catalog, including
plan semantic validation. Repair messages include sanitized local validation issues, remain capped
at two, and never change model, tools or policy.

## Consequences

Keep provider/model/config/prompt/schema/source/policy/workspace/project in scoped cache keys. Unknown price/usage remains unknown, not zero. One transport retry only without usable response. Generated proposals need deterministic validation and review; evaluation remains experimental until independent holdout evidence exists. Replay does not load model-gateway. AI-002/003/004, SEC-003–006, OPS-029/030.

## Authority

[SPEC](../../SPEC.md), [architecture](../../specs/02-architecture.md), [security](../../specs/07-security.md), [roadmap](../../ROADMAP.md). These records describe decisions, not proof that controls have already passed acceptance.
