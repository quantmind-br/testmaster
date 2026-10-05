# ADR-001: Toolchain

- Status: accepted
- Date: 2026-10-05
- Scope: approved M0–M2 implementation plan; later profiles remain capability-gated.

## Context

Local-first reproducible implementation requires one pinned toolchain; TypeScript 7 build mode and the strict project-reference probe are verified environment facts, not whole-product acceptance.

## Decision

Use Node.js >=24 <25 (host 24.21.0), pnpm 12.9.1, ESM, TypeScript 7.0.2 with strict NodeNext/es2024 project references, noUncheckedIndexedAccess and exactOptionalPropertyTypes. Use Biome 2.5.15 with preset recommended, Vitest 5.0.3 with unit/docker/live projects and source export resolution, fast-check 4.10.2, and Python 3.12 via uv for the isolated adapter. If a concrete TS 7 incompatibility is found, fallback to TypeScript 6.0.3 is a recorded change, not a silent downgrade.

## Consequences

Commit lockfiles; deterministic unit tests need no provider key or external network. Docker/live tests have explicit prerequisites. Compilers and formatters must not hide in-scope contract failures. [Development conventions](../development.md) own commands. NFR-009, M0-05, SEC-045.

## Authority

[SPEC](../../SPEC.md), [architecture](../../specs/02-architecture.md), [security](../../specs/07-security.md), [roadmap](../../ROADMAP.md). These records describe decisions, not proof that controls have already passed acceptance.
