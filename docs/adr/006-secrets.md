# ADR-006: Secret references and just-in-time release

- Status: accepted
- Date: 2026-10-05
- Scope: approved M0–M2 implementation plan; later profiles remain capability-gated.

## Context

Versioned plans, argv, backups and LLM requests must not contain plaintext credentials; an authorized browser may necessarily receive a target credential in memory.

## Decision

Primary local backend is OS keychain via secret-tool with value on stdin. Fallback is AES-256-GCM encrypted vault (0600) with a separate key file outside the DB and backups (0600). If neither is available refuse persistence; explicit ephemeral mode is memory-only. Store only SecretReference metadata, version and revocation in the DB/snapshot. Release values through the authenticated per-attempt protocol only when declared and authorized; check revocation at release. Runner masks secret locators and scrubs text/DOM/network; supervisor independently canary-scans text artifacts before commit.

## Consequences

Redaction failure withholds artifacts with redaction_failed; never publish raw fallback. Raw trace/video are off by default and restrictedRaw when explicitly authorized. Secret input is from env/file/stdin, never argv. Vault key loss fails restore explicitly; host administrator can read memory and disk. Known-value scrubbing cannot guarantee removal of unknown PII or transformed/encoded secrets. SEC-020–022/025/032–036.

## Authority

[SPEC](../../SPEC.md), [architecture](../../specs/02-architecture.md), [security](../../specs/07-security.md), [roadmap](../../ROADMAP.md). These records describe decisions, not proof that controls have already passed acceptance.
