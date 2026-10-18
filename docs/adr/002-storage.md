# ADR-002: SQLite runtime and PostgreSQL conformance mirror

- Status: accepted
- Date: 2026-10-05
- Scope: approved M0–M2 implementation plan; later profiles remain capability-gated.

## Context

A single-user local profile must not require a remote database. A future server profile must preserve constraints rather than invent different semantics.

## Decision

Use Node 24 node:sqlite with SQLite WAL and foreign keys enabled on local compatible filesystems. The wait inside SQLite for another connection's writer lock blocks the whole process because node:sqlite is synchronous. A synchronous caller (CLI command, HTTP or MCP request) waits up to `sqliteBusyTimeoutMs` (5 s): long enough to absorb another process's ordinary short transactions, bounded because runs executing in the same process renew their attempt lease every 10 s on that event loop. Past it the caller gets the typed retryable `UNAVAILABLE`/`writer_contention` refusal (HTTP answers 503). Long-lived loops (worker, MCP error audit) run each attempt inside `withYieldingWriterWait`, whose transactions wait only `sqliteYieldingBusyTimeoutMs` (50 ms), then wait asynchronously with full-jitter backoff capped at 1 s, with no total deadline, ending only on the caller's cancellation. Migrations keep their own fail-fast `BEGIN EXCLUSIVE`. Writes use transactions and fencing/CAS for ownership; state and outbox commit together. Applied migrations are immutable and checksummed. Mirror DDL in PostgreSQL and run the same constraint fixtures against postgres:17-alpine with its resolved digest recorded. PostgreSQL runtime remains an M4 disabled capability.

## Consequences

Local metadata is under a private .testmaster directory; online SQLite backup includes committed WAL state and restore uses an isolated directory without starting effects. Do not advertise PostgreSQL runtime support based on DDL tests alone. DATA-002/004, OPS-005/006/024/025.

## Authority

[SPEC](../../SPEC.md), [architecture](../../specs/02-architecture.md), [security](../../specs/07-security.md), [roadmap](../../ROADMAP.md). These records describe decisions, not proof that controls have already passed acceptance.
