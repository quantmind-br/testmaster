import type { Command } from "commander";
import { type Runtime, unavailable } from "./runtime.js";

export function unavailableCommands(program: Command, runtime: Runtime): void {
  const groups: ReadonlyArray<{ name: string; capability: string; commands: readonly string[] }> = [
    { name: "auth", capability: "identity", commands: ["login", "status", "logout"] },
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
    { name: "tunnel", capability: "tunnels", commands: ["start", "list", "status", "stop"] },
    { name: "ci", capability: "ci", commands: ["init", "doctor"] },
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
    ["export", "portability"],
    ["import", "portability"],
  ] as const) {
    const deny = (): never => unavailable(capability);
    runtime.bind(program.command(name).allowUnknownOption().allowExcessArguments(), deny, deny);
  }
}
