# ADR-003: Rootful hardened Docker deviation

- Status: accepted
- Date: 2026-10-05
- Scope: approved M0–M2 implementation plan; later profiles remain capability-gated.

## Context

The normative reference profile is rootless Linux Docker (spec 02 section 4 and ROADMAP M1). The available Docker 29.8.2 daemon is rootful; this is an explicit implementation-profile deviation approved for M0–M2, not rootless validation.

## Decision

Validate the single-user Linux x64 rootful hardened profile. One fresh container per Attempt uses network none, read-only rootfs, non-root UID, cap-drop ALL, no-new-privileges, init, bounded tmpfs/shm and CPU/RAM/PID limits, and a pinned Playwright image plus vendored browser-compatible seccomp. Chromium sandbox stays enabled. No privileged/host-network/host-PID/device/Docker-socket mounts or writable host bind. Inspect actual runtime facts into evidence. Refuse admission when the required boundary is unavailable.

## Consequences

Docker group access is effectively host-admin authority and belongs only to the trusted supervisor/operator. Rootless remains not yet validated. A shared-kernel container is not a VM and is not sufficient for hostile multi-tenant execution. Process executor requires all three explicit unsafe-local opt-ins and reports no isolation; never auto-fallback. SEC-002/012/014/016, [support matrix](../support-matrix.md).

## Authority

[SPEC](../../SPEC.md), [architecture](../../specs/02-architecture.md), [security](../../specs/07-security.md), [roadmap](../../ROADMAP.md). These records describe decisions, not proof that controls have already passed acceptance.
