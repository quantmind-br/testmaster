# ADR-029: crush, goose and jcode agent skill targets

- Status: accepted
- Date: 2026-10-19
- Amends: [ADR-009](009-agent-targets.md), [ADR-023](023-pi-omp-agent-targets.md)

## Context

The project conventions of the coding agents in `~/dev/custom-providers/agent-sources/` were read from source on 2026-10-19. Three of them read project files that no current target owns:

- **crush** (charmbracelet), source commit `94f9364511033ca0242aebd8d3f8d10242b83328`; installed 0.98.1, tag `v0.98.1` checked.
- **goose** (aaif-goose) 1.55.0, source commit `fb9e3c89b2b4670a0eded99e7567e578ac6e502c`; installed 1.48.0, tag `v1.45.0` and HEAD checked.
- **jcode** 0.99.0, source commit `9d22cbb8ecad6df840b22737439aa5164091fa31`; installed 0.87.0, tag `v0.87.0` checked.

The other agents read files that an existing target already owns, so they get no target of their own (see the coverage matrix).

ADR-009 still applies: every adapter follows the agent's own project convention, owns paths that no other adapter owns, and never touches MCP configuration.

## Decision

| Target | Project instructions convention | Selected instructions | Project skill convention / selected skill |
| --- | --- | --- | --- |
| `crush` | The context paths list `CRUSH.md`, `crush.md`, `Crush.md`, their `.local` variants, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules` and Copilot instructions, and loads all of them ([config.go#L29-L46](https://github.com/charmbracelet/crush/blob/94f9364511033ca0242aebd8d3f8d10242b83328/internal/config/config.go#L29-L46)) | `CRUSH.md` | `.agents/skills`, `.crush/skills`, `.claude/skills` and `.cursor/skills` in the working directory and the git root ([load.go#L1341-L1372](https://github.com/charmbracelet/crush/blob/94f9364511033ca0242aebd8d3f8d10242b83328/internal/config/load.go#L1341-L1372)). A skill needs a name matching `^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$` and equal to its directory, and a description of at most 1024 characters ([skills.go#L118-L140](https://github.com/charmbracelet/crush/blob/94f9364511033ca0242aebd8d3f8d10242b83328/internal/skills/skills.go#L118-L140)) → `.crush/skills/testmaster/SKILL.md` |
| `goose` | `CONTEXT_FILE_NAMES` defaults to `.goosehints` and `AGENTS.md` ([load_hints.rs#L10-L24](https://github.com/aaif-goose/goose/blob/fb9e3c89b2b4670a0eded99e7567e578ac6e502c/crates/goose/src/hints/load_hints.rs#L10-L24)). Both are read in every directory from the git root down to the cwd and concatenated ([load_hints.rs#L187-L205](https://github.com/aaif-goose/goose/blob/fb9e3c89b2b4670a0eded99e7567e578ac6e502c/crates/goose/src/hints/load_hints.rs#L187-L205), [#L232-L290](https://github.com/aaif-goose/goose/blob/fb9e3c89b2b4670a0eded99e7567e578ac6e502c/crates/goose/src/hints/load_hints.rs#L232-L290)) | `.goosehints` | `.agents/skills`, `.goose/skills` and `.claude/skills` under the working directory ([skills/mod.rs#L320-L326](https://github.com/aaif-goose/goose/blob/fb9e3c89b2b4670a0eded99e7567e578ac6e502c/crates/goose/src/skills/mod.rs#L320-L326)). The `skills` platform extension lists each skill as `name - description` in its instructions ([skills/client.rs#L243-L262](https://github.com/aaif-goose/goose/blob/fb9e3c89b2b4670a0eded99e7567e578ac6e502c/crates/goose/src/skills/client.rs#L243-L262)) → `.goose/skills/testmaster/SKILL.md` |
| `jcode` | `<working dir>/.jcode/prompt-overlay.md` is appended as "Project Prompt Overlay", together with the global `~/.jcode/prompt-overlay.md` ([prompt.rs#L977-L1018](https://github.com/1jehuang/jcode/blob/9d22cbb8ecad6df840b22737439aa5164091fa31/crates/jcode-base/src/prompt.rs#L977-L1018)) | `.jcode/prompt-overlay.md` | `.jcode/skills`, `.agents/skills` and `.claude/skills` in the working directory, read fresh on every session ([skill.rs#L290-L352](https://github.com/1jehuang/jcode/blob/9d22cbb8ecad6df840b22737439aa5164091fa31/crates/jcode-base/src/skill.rs#L290-L352)); a skill needs `name` and `description` → `.jcode/skills/testmaster/SKILL.md` |

All three adapters have an empty `instructionsPrefix` and record `accessedAt` `2026-10-19`. The `pi` and `omp` adapters also move to `accessedAt` `2026-10-19`, because this ADR re-verifies them (below).

The installer, the managed body, `AGENT_SKILL_VERSION` 2.3.0 and the skill tree are unchanged. Skill 2.3.0 (`name: testmaster`, a one-line description of 225 characters) passes the crush, goose and jcode validators.

### Coverage matrix

| Agent | Covered by | Skill advertised from the covering target |
| --- | --- | --- |
| crush, goose, jcode | their own targets (above) | yes |
| opencode | `codex` (`AGENTS.md`) | yes: opencode advertises `.agents/skills` |
| forge | `codex` (`AGENTS.md`) | no: forge reads project skills only from `.forge/skills` ([forge_repo/src/skill.rs#L13-L23](https://github.com/tailcallhq/forgecode/blob/76dccdffbcae7906cbf66bc0c80bea6ea2c8cde7/crates/forge_repo/src/skill.rs#L13-L23)) |
| hermes | `codex` (`AGENTS.md`) | no, unless the operator trusts the project: project `.agents/skills` loads only for a root listed in `skills.trusted_project_dirs` ([agent/skill_utils.py#L495-L501](https://github.com/NousResearch/hermes-agent/blob/f4ac0bea1e/agent/skill_utils.py#L495-L501)) |
| dsh | `codex` (`AGENTS.md`) | not probed |
| feynman | `pi` (`.pi/` conventions) | as `pi` |

zeroclaw, AionUi and model-loader are not project-convention agents and need no target.

### Rejected paths

- `.hermes.md`: hermes loads only the first project context type it finds, in the order `.hermes.md`/`HERMES.md` → `AGENTS.md` → `CLAUDE.md` → `.cursorrules` ([agent/prompt_builder.py#L1755](https://github.com/NousResearch/hermes-agent/blob/f4ac0bea1e/agent/prompt_builder.py#L1755), [#L1771](https://github.com/NousResearch/hermes-agent/blob/f4ac0bea1e/agent/prompt_builder.py#L1771)). A TestMaster `.hermes.md` would hide the repository's `AGENTS.md` from hermes.
- `.jcode/system-prompt.md`: it replaces jcode's whole base prompt instead of adding to it.
- `.forge/skills` and `.opencode/skills`: neither agent has an instructions file that no other target owns, so a target built on them would have to share `AGENTS.md` with `codex`.
- MCP configuration files: ADR-009 forbids MCP configuration mutation.

## Consequences

- On its first run in a project, crush creates `.crush/` with a `.gitignore` containing `*` ([internal/cmd/root.go#L304-L313](https://github.com/charmbracelet/crush/blob/94f9364511033ca0242aebd8d3f8d10242b83328/internal/cmd/root.go#L304-L313); observed by the probe as `crushDataDirIgnored: true`). The installed crush skill is therefore not committed unless the operator un-ignores it. `CRUSH.md` is committed normally.
- crush matches the exact names in its list, so on a case-sensitive filesystem it reads `CRUSH.md` only under that spelling (or the other listed spellings).
- goose reads `.goosehints` in every directory from the cwd up to the git root and concatenates it with `AGENTS.md`, so a goose session in a codex-targeted repository sees both managed sections.
- jcode reads the overlay and the project skills from its working directory only, not from ancestors.
- jcode clips each advertised skill description to 120 characters (`SKILL_DESC_MAX_CHARS`, `crates/jcode-base/src/prompt.rs` at `v0.87.0`). The probe therefore matches the skill on the first 100 characters of its description.
- J14 and the per-target installer scenarios now cover thirteen adapters. INT-034–037, REQ-031 and J14 apply.

### Re-verification of pi and omp

At pi 1.3.0 and oh-my-pi 18.12.3 (source `53a0377db6`; installed 18.12.2), the selected paths and the trust behaviour of ADR-023 are unchanged. Two precisions:

- Correction to ADR-023: native omp `.omp/skills` does not need `name`. A skill without `description` is skipped, and a missing `name` falls back to the directory name (`packages/coding-agent/src/discovery/builtin.ts` lines 309-337, `requireDescription: true`; `discovery/helpers.ts` lines 488-493).
- pi walks `AGENTS.md`/`CLAUDE.md` from the cwd to the filesystem root without a trust gate (`dist/core/resource-loader.js` `loadProjectContextFiles`). Any ancestor `.agents/skills` other than `~/.agents/skills` triggers pi's project-trust prompt (`dist/core/trust-manager.js` `hasTrustRequiringProjectResources`).

### Probe

`validation/probes/agent-target-loaders.mjs` (result schema 2.0.0) proves discovery for eight agents through install and removal:

- pi and omp: their loaders are asked directly, as in ADR-023. No model request is made.
- crush, goose, jcode, opencode, forge and hermes run one real turn per phase against a local OpenAI-compatible stub (`validation/probes/stub-upstream.mjs`). Each agent runs in its own git workspace where only its target is installed. It gets an isolated HOME and an environment built from scratch, holding only a placeholder key.
- The chat completion request bodies show whether the managed instructions marker (`Read <skillPath> before planning`) and the skill description reached the model.
- A phase counts only if the agent exited 0 and sent at least one chat completion request.
- `beforeInstall` and `afterRemove` are the negative controls.

Result: `validation/results/agent-targets-20261019/005-agents-loaders-reviewed/changed/validation/results/agent-target-loaders.json`, `passed: true`. Versions: pi 1.3.0, omp 18.12.2, crush 0.98.1, goose 1.48.0, jcode 0.87.0, opencode 2.0.32, forge 2.13.21 and hermes 0.22.2, all against the stub. Installed, every agent received the instructions, and crush, goose, jcode and opencode also received the skill description. forge and hermes did not, as the coverage matrix predicts.

The probe runs request-level agents only on Linux, because it finds their daemons through `/proc`. On another platform, selecting any of them exits 2 with a usage line; `pi` and `omp` can still be probed by naming them. Cancelling the probe (SIGINT or SIGTERM) kills the running agent's process group and its tagged daemons, then removes the temporary workspace.

Agent compliance with the instructions is not claimed.
