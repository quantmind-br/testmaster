import type { Command } from "commander";
import { type Runtime, unavailable } from "./runtime.js";

export function unavailableCommands(program: Command, runtime: Runtime): void {
  for (const [name, capability] of [
    ["export", "portability"],
    ["import", "portability"],
  ] as const) {
    const deny = (): never => unavailable(capability);
    runtime.bind(program.command(name).allowUnknownOption().allowExcessArguments(), deny, deny);
  }
}
