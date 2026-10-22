import { ContractError } from "@testmaster/contracts";
import type { Command } from "commander";
import type { Runtime } from "./runtime.js";

/**
 * `tunnel start|list|status|stop` (ADR-031). A tunnel lets a remote worker reach a loopback target
 * of this machine through a TestMaster server, so every subcommand runs against `--endpoint`; the
 * remote handlers live with the other remote commands.
 */
export function tunnelCommands(program: Command, runtime: Runtime): void {
  const group = program.command("tunnel");
  const local = (): never => {
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Tunnels run through a server endpoint; select one with --endpoint",
      { nextActions: ["testmaster auth login --endpoint <https-origin> --from-env <VAR>"] },
    );
  };
  runtime.bind(
    group
      .command("start")
      .description("Expose one loopback port to the project's remote workers until stopped")
      .option("--project <id>", "Project whose Runs may use the tunnel")
      .requiredOption("--target <address:port>", "127.0.0.1:<port> or [::1]:<port>")
      .option("--ttl <seconds>", "Session lifetime, 60 to 3600 seconds (default 900)"),
    local,
  );
  runtime.bind(group.command("list").description("List the tunnels you may use"), local);
  runtime.bind(
    group.command("status <id>").description("Show a tunnel and whether it is live"),
    local,
  );
  runtime.bind(
    group.command("stop <id>").description("Revoke a tunnel and close its streams"),
    local,
  );
}
