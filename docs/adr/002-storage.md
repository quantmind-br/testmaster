# ADR-002: SQLite runtime and PostgreSQL conformance mirror

- Status: accepted
- Date: 2026-10-05
- Scope: approved M0–M2 implementation plan; later profiles remain capability-gated.

## Context

A single-user local profile must not require a remote database. A future server profile must preserve constraints rather than invent different semantics.

## Decision

Use Node 24 node:sqlite with SQLite WAL, foreign keys enabled and busy_timeout 5 seconds on local compatible filesystems. Writes use transactions and fencing/CAS for ownership; state and outbox commit together. Applied migrations are immutable and checksummed. Mirror DDL in PostgreSQL and run the same constraint fixtures against postgres:17-alpine with its resolved digest recorded. PostgreSQL runtime remains an M4 disabled capability.

## Consequences

Local metadata is under a private .testmaster directory; online SQLite backup includes committed WAL state and restore uses an isolated directory without starting effects. Do not advertise PostgreSQL runtime support based on DDL tests alone. DATA-002/004, OPS-005/006/024/025.

## Authority

[SPEC](../../SPEC.md), [architecture](../../specs/02-architecture.md), [security](../../specs/07-security.md), [roadmap](../../ROADMAP.md). These records describe decisions, not proof that controls have already passed acceptance.
