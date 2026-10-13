export const AGENT_TARGETS = [
  "claude",
  "codex",
  "cursor",
  "cline",
  "windsurf",
  "copilot",
  "kiro",
  "antigravity",
  "pi",
  "omp",
] as const;
export type AgentTarget = (typeof AGENT_TARGETS)[number];
export interface AgentTargetAdapter {
  target: AgentTarget;
  verified: boolean;
  instructionsPath: string;
  instructionsPrefix: string;
  skillPath: string;
  sources: readonly string[];
  accessedAt: string;
}
const adapter = (
  target: AgentTarget,
  instructionsPath: string,
  skillPath: string,
  sources: string[],
  instructionsPrefix = "",
  accessedAt = "2026-10-05",
): AgentTargetAdapter => ({
  target,
  verified: true,
  instructionsPath,
  instructionsPrefix,
  skillPath,
  sources,
  accessedAt,
});
export const AGENT_TARGET_ADAPTERS: Readonly<Record<AgentTarget, AgentTargetAdapter>> = {
  claude: adapter("claude", "CLAUDE.md", ".claude/skills/testmaster/SKILL.md", [
    "https://code.claude.com/docs/en/memory",
    "https://code.claude.com/docs/en/skills",
  ]),
  codex: adapter("codex", "AGENTS.md", ".agents/skills/testmaster/SKILL.md", [
    "https://developers.openai.com/codex/guides/agents-md",
    "https://developers.openai.com/codex/skills",
  ]),
  cursor: adapter(
    "cursor",
    ".cursor/rules/testmaster.mdc",
    ".cursor/skills/testmaster/SKILL.md",
    ["https://cursor.com/docs/context/rules", "https://cursor.com/docs/context/skills"],
    "---\nalwaysApply: true\n---\n",
  ),
  cline: adapter("cline", ".cline/rules/testmaster.md", ".cline/skills/testmaster/SKILL.md", [
    "https://docs.cline.bot/customization/cline-rules",
    "https://docs.cline.bot/customization/skills",
  ]),
  windsurf: adapter(
    "windsurf",
    ".windsurf/rules/testmaster.md",
    ".windsurf/skills/testmaster/SKILL.md",
    [
      "https://docs.windsurf.com/windsurf/cascade/memories",
      "https://docs.windsurf.com/windsurf/cascade/skills",
    ],
    "---\ntrigger: always_on\n---\n",
  ),
  copilot: adapter(
    "copilot",
    ".github/copilot-instructions.md",
    ".github/skills/testmaster/SKILL.md",
    [
      "https://code.visualstudio.com/docs/copilot/customization/custom-instructions",
      "https://code.visualstudio.com/docs/copilot/customization/agent-skills",
    ],
  ),
  kiro: adapter(
    "kiro",
    ".kiro/steering/testmaster.md",
    ".kiro/skills/testmaster/SKILL.md",
    ["https://kiro.dev/docs/steering/", "https://kiro.dev/docs/skills/"],
    "---\ninclusion: always\n---\n",
  ),
  antigravity: adapter("antigravity", "GEMINI.md", ".agent/skills/testmaster/SKILL.md", [
    "https://antigravity.google/docs/rules",
    "https://antigravity.google/docs/skills",
  ]),
  pi: adapter(
    "pi",
    ".pi/APPEND_SYSTEM.md",
    ".pi/skills/testmaster/SKILL.md",
    [
      "https://pi.dev/docs/latest/configuration",
      "https://pi.dev/docs/latest/skills",
      "https://pi.dev/docs/latest/security",
    ],
    "",
    "2026-10-13",
  ),
  omp: adapter(
    "omp",
    ".omp/RULES.md",
    ".omp/skills/testmaster/SKILL.md",
    ["https://omp.sh/docs/context-files", "https://omp.sh/docs/skills"],
    "",
    "2026-10-13",
  ),
};
export function listAgentTargets(): readonly AgentTargetAdapter[] {
  return AGENT_TARGETS.map((target) => AGENT_TARGET_ADAPTERS[target]);
}
