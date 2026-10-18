# ADR-027: Recovery of the agent skill installer lock

- Status: accepted
- Date: 2026-10-18
- Amends: [ADR-009](009-agent-targets.md) (the interrupted-lock clause of the installer contract)
- Scope: `applyAgentSkills` and every surface that installs or removes agent guidance (`testmaster agent install|remove --yes`).

## Context

ADR-009 left an interrupted `.testmaster/agent-skills.lock` for the operator to investigate, because the lock only held `{pid, startedAt}`, written after the file was created, and could not tell a live owner from a dead one. An installer killed mid-apply, for example by `SIGPIPE` when its output was piped to `head`, then blocked every later install and removal with `lock_busy` until someone deleted the file by hand. Nothing named the file or the cause. The lock protects data integrity, so it stays; what it lacked was a way to recognize a dead owner without guessing.

## Decision

1. **The lock names its owner from its first byte.** An installer writes `{pid, host, token, startedAt}` to a private temporary file, syncs it, and publishes it with an exclusive hard link to `.testmaster/agent-skills.lock`. The link fails with `EEXIST` instead of replacing a lock, so a lock never exists empty or partial.
2. **Only a provably dead owner loses the lock.** A lock is reclaimed only when it names a `pid` on this host that no longer exists. Every other lock is held: a live `pid` (including `EPERM`), another host, a lock without a `pid`, and an empty or unparsable lock, which an earlier installer could leave while still running. Those stay for the operator, as ADR-009 decided. A reused `pid` makes a dead owner look alive, which only keeps the lock.
3. **Reclaim is serialized.** A reclaimer creates `.testmaster/agent-skills.lock.reclaim` exclusively, checks the lock, unlinks it if stale, and removes the guard. While the guard exists no other reclaimer can replace the lock, and no installer can publish one over the stale lock, so the checked lock is the one removed. A reclaimer that finds the guard taken returns `lock_busy`. The guard is held only for the check and the unlink; no timeout or age decides anything.
4. **The owner releases only its own lock.** Release unlinks the lock only while it still carries the owner's `token`.

## Consequences

- An install interrupted by any signal no longer needs manual cleanup on the same host.
- A lock from another host, an empty legacy lock, or a guard left by a reclaimer that died between its check and its unlink still needs the operator to remove the file.
- The installer test covers a dead owner in the old and the new format, a live owner, another host, an empty lock and a reclaim in progress.

## Authority

[SPEC](../../SPEC.md), [security](../../specs/07-security.md), [ADR-009](009-agent-targets.md). This record describes a decision, not proof that every control has passed acceptance.
