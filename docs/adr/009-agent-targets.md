# ADR-009: Agent skill target verification

- Status: proposed
- Date: 2026-10-05
- Scope: approved M0–M2 implementation plan; later profiles remain capability-gated.

## Context

M2 includes claude, codex, cursor, cline, windsurf, copilot, kiro and antigravity. File locations differ by vendor/version and have not been verified for implementation in Wave 1.

## Decision

Wave 4 must verify each target against current official vendor documentation and record source URLs, version/date and exact locations in this ADR before enabling it. No paths are selected or guessed here. The pending decision is target-specific routing; the accepted installer constraints are namespace testmaster, managed begin/end markers with version/hash, preview, backups preserving mode, confined atomic writes with locks and no-follow checks.

## Consequences

Pending verification is not an enabled capability or successful installer. Unverifiable conventions block shipping that target and must be reported. Duplicate markers and managed drift are conflicts; uninstall removes only owned unmodified content and preserves foreign bytes. J14 must exercise all eight verified targets before release. INT-034–039, SEC-017.

## Authority

[SPEC](../../SPEC.md), [architecture](../../specs/02-architecture.md), [security](../../specs/07-security.md), [roadmap](../../ROADMAP.md). These records describe decisions, not proof that controls have already passed acceptance.
