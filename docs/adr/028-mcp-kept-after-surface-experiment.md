# ADR-028: The MCP server stays a supported surface after the surface experiment

- Status: accepted
- Date: 2026-10-19
- Relates to: [ADR-008](008-mcp.md) (unchanged), [ADR-009](009-agent-targets.md) (agent skill payload)
- Scope: `apps/mcp`, the `/mcp` route of `apps/server`, `testmaster mcp serve`, and the agent skill installed by `testmaster agent install`.

## Context

The MCP catalog had grown to 982,964 bytes in one `tools/list` answer, most of it three output schemas that inlined the whole `ExecutablePlan`. One proposal was to remove the MCP server and route agents through the CLI and a skill only. Before deciding, the catalog was cut to 48,080 bytes without removing a tool, the CLI gained the operations only the MCP had (`bootstrap`, `test generate`, `requirement review --file`, `job get|wait|cancel`, paging, `--example`, `run events --follow`), and skill 2.0.0 documented the CLI as the single route.

A preregistered experiment (`evals/surface/`) then compared four arms on the same build of each round: A0 the frozen pre-cut catalog with skill 1.0.0, A1 the cut catalog with skill 1.0.0, A2 the cut catalog with the CLI skill, and A3 the CLI skill with no MCP server. Two agent models, `gemini-3.8-flash-high` and `muse-spark-1.3-contributor`, ran 15 tasks per arm on three development targets (SearXNG, WeKnora, Dokploy), 120 sessions per round. A3 would replace the MCP only if it was non-inferior to A0 for each model on every criterion: total prompt tokens at most 0.70 of A0, invalid-call and fabrication rates not worse, steps to a green test at most 1.15 of A0, completion not lower, and no secret leak, false success or weakened assertion.

## Decision

1. **The MCP server is kept as it is after the catalog cut.** The migration to a CLI-only surface is rejected. Six counted rounds (r2-r7, `evals/surface/rounds/decision.md`) reached the preregistered round limit without A3 meeting every criterion for both models, although one failure class was fixed after each round. A3's fixed prompt cost is about 22 tokens against about 2,400-2,600 for A0, but its total cost stayed between 0.81 and 1.07 of A0's over the last four rounds, and A3 sessions made more calls (median 53 against 30 for gemini in r7). Steps to green or fabrications failed for at least one model in every round. The Vikunja holdout was not run, because the protocol runs it only after a development round in which every threshold holds.
2. **The CLI stays the route the skill documents.** The skill (2.3.0) documents the CLI only and names no MCP tool. In r7, agents with both routes available still made most of their calls through the CLI (A0 883 CLI and 188 MCP calls, A2 1,168 and 16). The MCP server documents its own tools through descriptions and the `testmaster://tools/{name}` rules pages.
3. **The catalog size lock prevents a regression.** `apps/mcp/src/surface.test.ts` fails when `tools/list` grows past the measured 48,080 bytes or when an advertised schema inlines `ExecutablePlan` or exceeds 12 KB. A smaller catalog lowers the ceiling to the new measured value.
4. **ADR-008 is not superseded.** The pinned SDK, the negotiated protocol and the tool contracts stay as that record decided.

## Consequences

- No surface is removed, and no client configuration changes. `surface-parity` keeps comparing four routes: the built CLI, REST, stdio MCP and HTTP MCP.
- The fixes made after the five rounds r2-r6 are kept: skills 2.1.0, 2.2.0 and 2.3.0, the `doctor` vault probe, `requirement snapshot`, and `env get` with the active revision. The CLI fixes serve every agent with a shell, whatever MCP configuration it has.
- A later proposal to remove the MCP needs a new preregistered experiment, with a holdout that no fix has looked at. The Vikunja target (`evals/surface/apps/vikunja/`) was never run and still qualifies.

## Authority

[SPEC](../../SPEC.md), [CLI and MCP](../../specs/05-cli-mcp.md), [ADR-008](008-mcp.md), [ADR-009](009-agent-targets.md). The evidence is in `evals/surface/rounds/` (each round's `preregistration.json`, `report.md` and `classification.md`, and `decision.md`). This record describes a decision, not proof that every control has passed acceptance.
