import type { Command } from "commander";
import { type Runtime, unavailable } from "./runtime.js";

export function unavailableCommands(program: Command, runtime: Runtime): void {
  const groups: ReadonlyArray<{ name: string; capability: string; commands: readonly string[] }> = [
    { name: "auth", capability: "identity", commands: ["login", "status", "logout"] },
    { name: "source", capability: "source-text", commands: ["add", "list", "get", "archive"] },
    {
      name: "requirement",
      capability: "normalize",
      commands: ["list", "get", "update", "approve"],
    },
    {
      name: "plan",
      capability: "plan",
      commands: ["generate", "list", "get", "edit", "accept", "reject"],
    },
    { name: "heal", capability: "healing", commands: ["propose", "approve", "reject"] },
    {
      name: "suite",
      capability: "suites",
      commands: ["create", "list", "get", "update", "add", "remove", "archive", "run"],
    },
    {
      name: "schedule",
      capability: "schedules",
      commands: ["create", "list", "get", "update", "pause", "resume", "archive", "history"],
    },
    { name: "server", capability: "server", commands: ["start"] },
    { name: "tunnel", capability: "tunnels", commands: ["start", "list", "status", "stop"] },
    {
      name: "agent",
      capability: "agent-skills",
      commands: ["install", "list", "status", "remove"],
    },
    { name: "mcp", capability: "mcp", commands: ["serve"] },
    { name: "ci", capability: "ci", commands: ["init", "doctor"] },
    { name: "resource", capability: "resources-cleanup", commands: ["list", "get", "cleanup"] },
    {
      name: "memory",
      capability: "memory",
      commands: ["create", "list", "get", "update", "remove"],
    },
    {
      name: "visual-baseline",
      capability: "visual-baselines",
      commands: ["create", "list", "get", "approve"],
    },
  ];
  for (const entry of groups) {
    const group = program.command(entry.name);
    const deny = (): never => unavailable(entry.capability);
    runtime.bind(group.allowUnknownOption().allowExcessArguments(), deny, deny);
    for (const name of entry.commands)
      runtime.bind(group.command(name).allowUnknownOption().allowExcessArguments(), deny, deny);
  }
  for (const [name, capability] of [
    ["discover", "code-diff"],
    ["explore", "agent-mode"],
    ["usage", "model-accounting"],
    ["export", "portability"],
    ["import", "portability"],
  ] as const) {
    const deny = (): never => unavailable(capability);
    runtime.bind(program.command(name).allowUnknownOption().allowExcessArguments(), deny, deny);
  }
}
