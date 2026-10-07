# ADR-005: Dedicated runner protocol and artifact channel

- Status: accepted
- Date: 2026-10-05
- Scope: approved M0–M2 implementation plan; later profiles remain capability-gated.

## Context

Container stdout is untrusted log output; parsing it as privileged control would allow forgery and unbounded host writes.

## Decision

Use a separate per-attempt protocol.sock, bidirectional NDJSON with protocolVersion 1.0.0, seq strictly +1 from zero, attemptId, type, occurredAt and typed payload. Accept exactly one connection with runner.hello and a per-attempt nonce; trusted harness connects before user code loads. Validate schema/identity/sequence/sizes/paths at the supervisor. secret.request is answered by secret.value only for declared authorized refs with current revocation checks; control.cancel is supervisor-originated. Artifacts use begin/chunk/end with base64 chunks at most 128 KiB raw and 256 KiB lines. Host recomputes SHA-256 and enforces 64 MiB/object and 256 MiB/Attempt quotas.

## Consequences

Events include step/resource/variable/log/runner completion. Missing runner.finished, malformed or regressive events never pass; preserve a protocol diagnostic and inconclusive result subject to previously proven failure. Sensitive values use encrypted refs, not logs. Container stdout/stderr is a bounded 10 MiB ring with dropped count. Harness stops on socket close/deadline; supervisor kills after 10 seconds cancel grace and removes containers. Base64 overhead is accepted for enforceable host-disk quotas. SEC-019/020, OPS-004/008/013.

Playwright replay emits model-free `locator-evidence` JSON artifacts before and after locator actions (including frame children, both drag locators, download triggers and locator waits). Paths are `browser/steps/{stepId}-locator-{index}-{before|after}.json`. Records contain the original locator, frame origin, cardinality, up to 100 sanitized element candidates, semantic fingerprints, completeness status, and bounded wait-state transitions measured relative to the wait start. Input values are never captured; password/sensitive controls have no names or attributes. Secret/default-pattern redaction runs before hashing. Evidence and fingerprint hashes use canonical semantic hashing, not the artifact's byte hash.

Consumers obtain a Run's authorized committed bundle with `ArtifactsService.get`, select available manifest entries of kind `locator-evidence`, and load each bounded JSON record using `ArtifactsService.read(runId, relativePath, { attemptId, maxBytes: 262144 })`. Lower-level consumers use `verifyBundle` then `streamBundleArtifact`; authorization and privacy tombstones remain application responsibilities. The worker publishes these entries through the existing manifest/Artifact path, and step completion lists their evidence paths. Missing/truncated evidence never authorizes safe healing. Planner `assessLocatorEquivalence` proves a unique stable semantic identity with original absence and a provable recorded replacement selector; `waitStateEquivalence` requires the same readiness control and an observed in-deadline visible-to-hidden transition replacing baseline detachment. Scoped/complex selectors, text-only matches, duplicate controls and uncertain readiness remain manual review.

## Authority

[SPEC](../../SPEC.md), [architecture](../../specs/02-architecture.md), [security](../../specs/07-security.md), [roadmap](../../ROADMAP.md). These records describe decisions, not proof that controls have already passed acceptance.
