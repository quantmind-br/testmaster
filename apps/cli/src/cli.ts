import { ContractError } from "@testmaster/contracts";
import { Command, CommanderError, Option } from "commander";
import { agentCommands } from "./agents.js";
import { explorationCommands } from "./ai-execution.js";
import { approvalCommands } from "./approvals.js";
import { artifactCommands } from "./artifacts.js";
import { auditCommands } from "./audit.js";
import { backupCommands } from "./backups.js";
import { ciCommands } from "./ci.js";
import { contractCommands } from "./contracts.js";
import { databaseCommands } from "./database.js";
import { discoveryCommands } from "./discovery.js";
import { environmentCommands } from "./environments.js";
import { healingCommands } from "./heal.js";
import { mcpCommands } from "./mcp.js";
import { planCommands } from "./plans.js";
import { projectCommands } from "./projects.js";
import { reportCommands } from "./reports.js";
import { requirementCommands } from "./requirements.js";
import { resourceCommands } from "./resources.js";
import { runCommands } from "./runs.js";
import { Runtime, seconds } from "./runtime.js";
import { secretCommands } from "./secrets.js";
import { serverCommands } from "./server.js";
import { setupCommands } from "./setup.js";
import { sourceCommands } from "./sources.js";
import { testCommands } from "./tests.js";
import { unavailableCommands } from "./unavailable.js";
import { usageCommands } from "./usage.js";
import { workerCommands } from "./workers.js";

export function createCli(runtime: Runtime): Command {
  const program = new Command("testmaster");
  program
    .description("Local deterministic test execution and evidence")
    .version("0.1.0")
    .option("--json", "Emit exactly one JSON envelope")
    .addOption(
      new Option("--output <format>", "Output format").choices(["json", "text"]).default("text"),
    )
    .option("--cwd <path>", "Explicit working directory")
    .option("--config <path>", "Project configuration path")
    .option("--profile <name>", "Profile name")
    .option("--project <id>", "Project ID")
    .option("--endpoint <url>", "Server endpoint")
    .option("--request-timeout <seconds>", "Request deadline in seconds", seconds)
    .option("--no-color", "Disable colors")
    .option("--verbose", "Diagnostics on stderr, without sensitive payloads")
    .option("--dry-run", "Validate locally without side effects")
    .option("--example", "Emit a clearly labeled fixture, not a verdict");
  setupCommands(program, runtime);
  projectCommands(program, runtime);
  environmentCommands(program, runtime);
  secretCommands(program, runtime);
  testCommands(program, runtime);
  runCommands(program, runtime);
  artifactCommands(program, runtime);
  reportCommands(program, runtime);
  workerCommands(program, runtime);
  backupCommands(program, runtime);
  auditCommands(program, runtime);
  contractCommands(program, runtime);
  databaseCommands(program, runtime);
  approvalCommands(program, runtime);
  agentCommands(program, runtime);
  healingCommands(program, runtime);
  sourceCommands(program, runtime);
  discoveryCommands(program, runtime);
  requirementCommands(program, runtime);
  planCommands(program, runtime);
  usageCommands(program, runtime);
  explorationCommands(program, runtime);
  mcpCommands(program, runtime);
  serverCommands(program, runtime);
  resourceCommands(program, runtime);
  ciCommands(program, runtime);
  unavailableCommands(program, runtime);
  return program;
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  runtime = new Runtime(),
): Promise<void> {
  runtime.output =
    argv.includes("--json") ||
    argv.some(
      (value, index) =>
        value === "--output=json" || (value === "--output" && argv[index + 1] === "json"),
    )
      ? "json"
      : "text";
  const program = createCli(runtime);
  let help = "";
  const configure = (command: Command): void => {
    command.exitOverride().configureOutput({
      writeOut: (text) => {
        help += text;
      },
      writeErr: () => {},
      outputError: () => {},
    });
    for (const child of command.commands) configure(child);
  };
  configure(program);
  const sigint = (): void => runtime.interrupt("SIGINT");
  const sigterm = (): void => runtime.interrupt("SIGTERM");
  const sighup = (): void => runtime.interrupt("SIGHUP");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  process.on("SIGHUP", sighup);
  let failure: unknown;
  try {
    await program.parseAsync(argv, { from: "user" });
    if (!runtime.pending) {
      if (runtime.signal) throw runtime.interrupted();
      runtime.pending = {
        data: { help: help || program.helpInformation() },
        text: help || program.helpInformation(),
      };
    }
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0)
      runtime.pending = { data: { help }, text: help };
    else
      failure =
        error instanceof CommanderError
          ? new ContractError("INVALID_ARGUMENT", "Invalid command arguments", {
              reason: error.code,
            })
          : error;
  } finally {
    try {
      await runtime.close();
    } catch (error) {
      failure ??= error;
    }
    if (runtime.signal) failure = runtime.interrupted();
    if (failure) runtime.fail(failure);
    else if (runtime.pending) runtime.emit(runtime.pending);
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
    process.removeListener("SIGHUP", sighup);
  }
}
