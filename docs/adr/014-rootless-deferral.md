# ADR-014: Rootless Docker validation deferred to M4

- Status: superseded by [ADR-016](016-server-profile.md) for the server profile (rootless Docker validated in M4); still the record for the M0–M3 local profile
- Date: 2026-10-12
- Scope: the isolation profile claimed through M3. Extends [ADR-003](003-rootful-docker.md).

## Context

The normative reference profile is rootless Linux Docker (spec 02 section 4, ROADMAP M1). ADR-003 approved a rootful hardened deviation for M0–M2. The available daemon is still rootful and no rootless run has been recorded.

## Decision

Rootless Docker validation is deferred to M4: ADR-003's rootful hardened deviation is extended through M3, and rootless remains unvalidated until an M4 acceptance run records independent rootless smoke and isolation evidence.

## Consequences

Everything verified through M3 describes the single-user rootful hardened profile only. Documentation and release notes must not claim rootless support. Items whose clauses require the rootless profile (OPS-001) carry a `deferred` M4 entry quoting this decision, so the M4 gate stays blocked until rootless evidence exists.
