# ADR-009: Agent skill target verification

- Status: accepted
- Date: 2026-10-05
- Scope: approved M0–M2 implementation plan; later profiles remain capability-gated.

## Context

M2 includes Claude Code, OpenAI Codex CLI, Cursor, Cline, Windsurf Cascade, GitHub Copilot in VS Code, Kiro and Google Antigravity. Official documentation was accessed on **2026-10-05**. This is a filesystem-format verification, not a claim that eight proprietary clients were launched or that instruction discovery guarantees agent compliance.

## Decision

The project-level adapters below are enabled. All skill files are Markdown with YAML `name: testmaster` and `description`, in a folder named `testmaster`. The versioned payload is `packages/application/skill-content/1.0.0/SKILL.md`. No global installation or MCP configuration mutation is performed.

| Target / verified surface | Official project instructions/rules convention | Selected instructions | Official project skill convention / selected skill |
| --- | --- | --- | --- |
| `claude` / Claude Code | Root `CLAUDE.md` or `.claude/CLAUDE.md`; modular `.claude/rules/*.md`; plain Markdown | `CLAUDE.md` | `.claude/skills/<name>/SKILL.md` → `.claude/skills/testmaster/SKILL.md` |
| `codex` / Codex CLI | Root/nested `AGENTS.md`; `AGENTS.override.md` takes precedence; plain Markdown | `AGENTS.md` | `.agents/skills/<name>/SKILL.md`, searched from cwd to repository root → `.agents/skills/testmaster/SKILL.md` |
| `cursor` / Cursor Agent | `.cursor/rules/*.mdc` with YAML activation; root `AGENTS.md` alternative | `.cursor/rules/testmaster.mdc`, `alwaysApply: true` when created | `.cursor/skills/` and `.agents/skills/` → `.cursor/skills/testmaster/SKILL.md` |
| `cline` / VS Code, Desktop, CLI | `.cline/rules/` and `.clinerules/`; Markdown, no frontmatter needed for unconditional rules | `.cline/rules/testmaster.md` | `.cline/skills/<name>/SKILL.md` recommended → `.cline/skills/testmaster/SKILL.md` |
| `windsurf` / Cascade | `.windsurf/rules/*.md` with YAML `trigger`; root `AGENTS.md` alternative | `.windsurf/rules/testmaster.md`, `trigger: always_on` when created | `.windsurf/skills/<name>/SKILL.md` → `.windsurf/skills/testmaster/SKILL.md` |
| `copilot` / GitHub Copilot in VS Code | `.github/copilot-instructions.md` plain Markdown; `.github/instructions/**/*.instructions.md` supports YAML `applyTo` | `.github/copilot-instructions.md` | `.github/skills/`, `.claude/skills/`, `.agents/skills/` → `.github/skills/testmaster/SKILL.md` |
| `kiro` / Kiro IDE and CLI | `.kiro/steering/*.md` with YAML inclusion mode; root `AGENTS.md` alternative | `.kiro/steering/testmaster.md`, `inclusion: always` when created | `.kiro/skills/<name>/SKILL.md` → `.kiro/skills/testmaster/SKILL.md` |
| `antigravity` / IDE, 2.0 and CLI | Root/nested `GEMINI.md` or `AGENTS.md` plain Markdown; `.agents/rules/*.md` requires YAML `trigger` | `GEMINI.md` | `.agents/skills/<name>/SKILL.md` preferred; `.agent/skills/` explicitly retained for compatibility → `.agent/skills/testmaster/SKILL.md` |

Windsurf documentation currently redirects to the vendor's Devin Desktop documentation. It explicitly retains `.windsurf/rules/` and `.windsurf/skills/` as supported legacy locations (preferred new paths are `.devin/rules/` and `.devin/skills/`). This adapter targets the named **Windsurf Cascade** surface using those verified compatibility locations, not the distinct Devin Local harness. Antigravity likewise explicitly supports `.agent/skills/`; selecting it keeps this target's ownership separate from Codex's `.agents/skills/testmaster`. Existing user frontmatter is never rewritten; previews make activation differences visible. Codex `AGENTS.override.md`, vendor toggles, customized locations and custom Kiro agent resources can affect actual loading and are not modified by installation.

### Sources (all accessed 2026-10-05)

- Claude: [project instructions](https://code.claude.com/docs/en/memory), [skills and project locations](https://code.claude.com/docs/en/skills).
- Codex: [AGENTS.md discovery](https://developers.openai.com/codex/guides/agents-md) (redirects to `learn.chatgpt.com/docs/agent-configuration/agents-md`), [skill locations and manifest](https://developers.openai.com/codex/skills) (redirects to `learn.chatgpt.com/docs/build-skills`).
- Cursor: [rules and MDC activation](https://cursor.com/docs/context/rules) (redirects to `/docs/rules`), [skills](https://cursor.com/docs/context/skills) (redirects to `/docs/skills`).
- Cline: [rules](https://docs.cline.bot/customization/cline-rules), [skills](https://docs.cline.bot/customization/skills). Direct DNS resolution failed in this environment; the official pages' text was retrieved through Jina Reader, retaining the official source URL. Third-party summaries were not used as convention authority.
- Windsurf: [rules](https://docs.windsurf.com/windsurf/cascade/memories) → [current vendor rules documentation](https://docs.devin.ai/desktop/cascade/memories), [skills](https://docs.windsurf.com/windsurf/cascade/skills) → [current vendor skill documentation](https://docs.devin.ai/desktop/cascade/skills).
- Copilot in VS Code: [instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions) → `/docs/agent-customization/custom-instructions`, [skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills) → `/docs/agent-customization/agent-skills`.
- Kiro: [steering and inclusion modes](https://kiro.dev/docs/steering/), [skills and YAML manifest](https://kiro.dev/docs/skills/) (page updated October 2, 2026). Official HTML initially exposed metadata only; Jina Reader exposed the page body.
- Antigravity: [rules and file locations](https://antigravity.google/docs/rules), [skills and compatibility locations](https://antigravity.google/docs/skills).

No target remains unverified. If a future adapter cannot verify its convention, it must return `CAPABILITY_UNAVAILABLE`, reason `unverified_target_convention`, details `{capability: "agent_skills.<target>", milestone: "M2"}` rather than guessing paths.

### Installer contract

The core provides read-only `planAgentSkills` (install/remove, full-file diff), then `applyAgentSkills`. Plans are process-local authenticated objects, not editable serialized instructions. Apply compares every original byte and mode under a single workspace `.testmaster/agent-skills.lock` opened exclusively; contention returns `lock_busy`, changed inputs return `stale_preview`. Interrupted locks remain for explicit operator investigation, never unsafe automatic lock stealing.

Instruction ownership uses `<!-- testmaster:begin version=… hash=… -->` / `<!-- testmaster:end -->`. Hashes are SHA-256 over exact body bytes; only the managed span is replaced/removed, including its terminal newline. Skill ownership markers are appended after valid frontmatter/body and hash **all other bytes** of the file, preventing uninstallation of a human-edited skill. Duplicate/unbalanced markers, unmanaged skill collisions and hash drift are typed conflicts. Old intact versions can upgrade. Foreign bytes, including line endings and non-UTF-8 bytes, are retained as Buffers; preview strings are for display only, never the write source.

Backups precede target modification in `.testmaster/agent-backups/<timestamp>-<unique-id>/`, preserving original bytes/modes with private directory ancestry. Each replacement uses a same-directory exclusive temporary, fsync, mode restoration, atomic rename and parent-directory fsync. Only owned skill files are unlinked; no recursive removal of vendor folders or unrelated files. Rollback previews compare against applied bytes and refuse later edits. Linux descriptor-relative operations reuse the evidence package's `ConfinedRoot`: each ancestor is pinned with `O_DIRECTORY | O_NOFOLLOW`, regular files require one link, and destination lstat is repeated before publication. Unsupported platforms fail closed; other operating systems need equivalent native confinement before enabling installation. Atomicity is per file, not an all-files filesystem transaction; backups remain recoverable on I/O interruption.

The application exposes `agentSkills` (`AgentSkillsService`): list/status/plan require R scope, apply requires W scope and a plan issued by the same service/root. Mutation requests and completed/refused results append content-free audit events with hashes. `testmaster agent install --target <name>` and `agent remove --target <name>` preview by default without opening the database or changing files; diffs go to stderr and the JSON envelope identifies `preview:true, applied:false`. `--yes` is explicit consent to plan and apply in the same process against an initialized local workspace. `--dry-run` remains side-effect-free even with `--yes`. `agent list` and `agent status [--target <name>]` are local read-only diagnostics; they do not imply executable authority. Conflicts map to CLI exit 6, unsafe paths to 9, unsupported capability/platform to 8. The built-CLI J14 journey is `validation/journeys/j14-agent-skills.test.ts`, recording `validation/results/j14-agent-skills.json`; its MCP scope clause is separately covered by the MCP suite.

## Consequences

J14 unit scenarios cover all eight adapters: byte-identical foreign content, intact old-version upgrade, file/parent symlink refusal, duplicate/unbalanced markers, real-lock parallel apply, managed/whole-skill drift, uninstall ownership, preserved file/backup modes, stale previews and rollback protection. No claim is made that a textual agent response proves a Run. The shared skill documents scopes/consent, capability/version checks, snapshot hashes, pagination/partial/stale evidence, CLI exits and secrets only by protected input/secretRef. INT-034–039, REQ-031 and SEC-017 apply.

## Authority

[SPEC](../../SPEC.md), [architecture](../../specs/02-architecture.md), [security](../../specs/07-security.md), [roadmap](../../ROADMAP.md). These records describe decisions, not proof that controls have already passed acceptance.
