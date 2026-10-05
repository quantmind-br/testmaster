# ADR-010: License recommendation pending maintainer decision

- Status: proposed
- Date: 2026-10-05
- Scope: approved M0–M2 implementation plan; later profiles remain capability-gated.

## Context

SPEC section 2.7 and architecture ADR-011 recommend an OSS license but reserve the final choice to the maintainer. Public availability of competitor materials does not grant reuse rights.

## Decision

Recommend Apache-2.0 for explicit patent terms and broad compatibility. No project license is selected by implementation: manifests remain private and UNLICENSED, and no LICENSE file is created. Maintainer must record final license and transitive compatibility before public release.

## Consequences

Implementation is clean-room from licensed/public behavioral evidence, with provenance and dependency notices. Never copy proprietary code/assets/prompts or use private TestSprite endpoints/credentials. Publication is blocked pending final legal/license decision, inventory/SBOM and release notices. SEC-045/046, NFR-011, M0-05/M6-05.

## Authority

[SPEC](../../SPEC.md), [architecture](../../specs/02-architecture.md), [security](../../specs/07-security.md), [roadmap](../../ROADMAP.md). These records describe decisions, not proof that controls have already passed acceptance.
