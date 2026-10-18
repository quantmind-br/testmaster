# ADR-023: pi and oh-my-pi agent skill targets

- Status: accepted
- Date: 2026-10-13
- Amends: [ADR-009](009-agent-targets.md)

## Context

Two further coding agents are supported by `testmaster agent list|status|install|remove --target <name>`:

- **pi coding agent** 1.2.0 (`@earendil-works/pi-coding-agent`), conventions read from its installed package and the official documentation.
- **oh-my-pi** 18.10.4 (`omp`), conventions read from its source at commit `687892d104` and the official documentation.

ADR-009 requires every adapter to follow the agent's official project convention and to own paths that no other adapter owns. Managed sections carry no target identity, so two targets sharing a file would let `agent remove --target a` strip the guidance of `b`.

## Decision

| Target / verified surface | Official project instructions convention | Selected instructions | Official project skill convention / selected skill |
| --- | --- | --- | --- |
| `pi` / pi coding agent 1.2.0 | `<cwd>/.pi/APPEND_SYSTEM.md` is appended to the system prompt; loaded only after the project is trusted; a project file replaces `~/.pi/agent/APPEND_SYSTEM.md` | `.pi/APPEND_SYSTEM.md` | `.pi/skills/<name>/SKILL.md`, loaded only after project trust → `.pi/skills/testmaster/SKILL.md` |
| `omp` / oh-my-pi 18.10.4 | `.omp/RULES.md` is a sticky always-apply rule rendered into the system prompt; user `~/.omp/agent/RULES.md` and the nearest project `.omp/RULES.md` both apply | `.omp/RULES.md` | `.omp/skills/<name>/SKILL.md`, found from the cwd through its ancestors; needs `name` and `description` → `.omp/skills/testmaster/SKILL.md` |

The payload (the skill tree `packages/application/skill-content/<AGENT_SKILL_VERSION>/`, ADR-009), `AGENT_SKILL_VERSION` and the installer contract of ADR-009 are unchanged. The new adapters record `accessedAt` `2026-10-13`.

### Rejected paths

- `AGENTS.md`, `CLAUDE.md` and `.agents/skills/` are read by pi, but are already owned by the `codex` and `claude` adapters. Sharing them would let one target's removal strip another's guidance. The installer test "keeps each target's files independent when every target is installed in one workspace" fails when any adapter shares a file (observed with pi temporarily pointed at `AGENTS.md`: after the `codex` removal `pi` reported `outdated`).
- `.omp/AGENTS.md` shadows `<repo>/AGENTS.md` at the same level instead of being concatenated with it, so it would hide the codex-owned file from omp.

## Consequences

- pi loads both files only after the project is trusted and only when launched from the workspace root. An untrusted project sees neither (observed).
- The project `.pi/APPEND_SYSTEM.md` replaces the user's global `~/.pi/agent/APPEND_SYSTEM.md` for that project; the files are not combined.
- omp applies `.omp/RULES.md` only when the root `.omp/` is the nearest project configuration directory from the cwd. There is no project-trust gate.
- Loader discovery is proven by `validation/probes/agent-target-loaders.mjs`, which drives the real pi `DefaultResourceLoader` (trusted and untrusted) and a real `omp --mode rpc` session in a temporary git workspace through install and removal. Result: `validation/results/m4-acceptance/agents/006-agents-loaders/created/validation/results/agent-target-loaders.json` (pi 1.2.0, omp 18.10.4; `passed: true`). Both files are observed only while installed.
- No model request was made. Agent compliance with the instructions is not claimed; pi used an empty temporary agent directory and omp used the operator's `~/.omp` configuration.
- J14 and the per-target installer scenarios now cover ten adapters. INT-034–037, REQ-031 and J14 apply. REQ-031 lists minimum targets and is unchanged.

### Sources (all accessed 2026-10-13)

- pi: [configuration](https://pi.dev/docs/latest/configuration), [skills](https://pi.dev/docs/latest/skills), [security and project trust](https://pi.dev/docs/latest/security).
- oh-my-pi: [context files](https://omp.sh/docs/context-files), [skills](https://omp.sh/docs/skills).
