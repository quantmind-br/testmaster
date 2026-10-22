import { nodeSupport } from "@testmaster/application";
import { ContractError, RUNNER_VERSION, SCHEMA_VERSION } from "@testmaster/contracts";
import { Command, CommanderError, Help, Option } from "commander";
import { agentCommands } from "./agents.js";
import { explorationCommands } from "./ai-execution.js";
import { approvalCommands } from "./approvals.js";
import { artifactCommands } from "./artifacts.js";
import { auditCommands } from "./audit.js";
import { authProfileCommands } from "./auth-profiles.js";
import { backupCommands } from "./backups.js";
import { bootstrapCommands } from "./bootstrap.js";
import { ciCommands } from "./ci.js";
import { contractCommands } from "./contracts.js";
import { databaseCommands } from "./database.js";
import { discoveryCommands } from "./discovery.js";
import { environmentCommands } from "./environments.js";
import { declareExampleVariants, exampleFor, leafCommand } from "./examples.js";
import { githubCommands } from "./github.js";
import { healingCommands } from "./heal.js";
import { imageCommands } from "./images.js";
import { jobCommands } from "./jobs.js";
import { suiteCommands } from "./lists.js";
import { mcpCommands } from "./mcp.js";
import { operationsCommands } from "./operations.js";
import { planCommands } from "./plans.js";
import { projectCommands } from "./projects.js";
import { remoteCommands } from "./remote.js";
import { reportCommands } from "./reports.js";
import { requirementCommands } from "./requirements.js";
import { resourceCommands } from "./resources.js";
import { runCommands } from "./runs.js";
import { Runtime, seconds } from "./runtime.js";
import { scheduleCommands } from "./schedules.js";
import { secretCommands } from "./secrets.js";
import { identityCommands, serverCommands } from "./server.js";
import { setupCommands } from "./setup.js";
import { sourceCommands } from "./sources.js";
import { testCommands } from "./tests.js";
import { tokenCommands } from "./tokens.js";
import { tunnelCommands } from "./tunnels.js";
import { unavailableCommands } from "./unavailable.js";
import { usageCommands } from "./usage.js";
import { workerCommands } from "./workers.js";

/** Commander lists a `requiredOption` like any other flag; the help must say it is mandatory. */
function markMandatory(this: Help, option: Option): string {
  const text = Help.prototype.optionDescription.call(this, option);
  if (!option.mandatory) return text;
  return text ? `${text} (required)` : "(required)";
}

export function createCli(runtime: Runtime): Command {
  const program = new Command("testmaster").configureHelp({ optionDescription: markMandatory });
  program
    .description("Local deterministic test execution and evidence")
    .version(`0.1.0 (schema ${SCHEMA_VERSION}, runner ${RUNNER_VERSION})`)
    .option("--json", "Emit exactly one JSON envelope")
    .addOption(
      new Option("--output <format>", "Output format").choices(["json", "text"]).default("text"),
    )
    .option("--cwd <path>", "Explicit working directory")
    .option("--config <path>", "Project configuration path")
    .option("--profile <name>", "Profile name")
    .option("--project <id>", "Project ID")
    .option("--endpoint <url>", "Server endpoint")
    .option(
      "--request-timeout <seconds>",
      "Request deadline in seconds for a remote HTTP request and for the wait on a run owned by a worker; never ends a run this command executes",
      seconds,
    )
    .option("--no-color", "Disable colors")
    .option("--verbose", "Diagnostics on stderr, without sensitive payloads")
    .option("--dry-run", "Validate locally without side effects")
    .option(
      "--example",
      "Emit the command's input contract and a sample input file, labeled as an example, not a verdict",
    );
  setupCommands(program, runtime);
  projectCommands(program, runtime);
  bootstrapCommands(program, runtime);
  environmentCommands(program, runtime);
  secretCommands(program, runtime);
  authProfileCommands(program, runtime);
  testCommands(program, runtime);
  runCommands(program, runtime);
  jobCommands(program, runtime);
  artifactCommands(program, runtime);
  reportCommands(program, runtime);
  workerCommands(program, runtime);
  backupCommands(program, runtime);
  imageCommands(program, runtime);
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
  tokenCommands(program, runtime);
  identityCommands(program, runtime);
  resourceCommands(program, runtime);
  operationsCommands(program, runtime);
  ciCommands(program, runtime);
  suiteCommands(program, runtime);
  scheduleCommands(program, runtime);
  remoteCommands(program, runtime);
  githubCommands(program, runtime);
  tunnelCommands(program, runtime);
  unavailableCommands(program, runtime);
  declareExampleVariants(program);
  return program;
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  runtime = new Runtime(),
  nodeVersion: string = process.versions.node,
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
    const node = nodeSupport(nodeVersion);
    if (!node.supported)
      throw new ContractError("PRECONDITION_FAILED", "Unsupported Node.js runtime", {
        reasonCode: "unsupported_node",
        required: node.required,
        actual: node.actual,
      });
    // `--example` answers before commander validates the command's required options, so a
    // command that needs `--file` or `--plan` can still print what that file looks like.
    const example =
      argv.includes("--example") && !argv.includes("--help") && !argv.includes("-h")
        ? leafCommand(program, argv)
        : undefined;
    if (example) runtime.pending = { data: exampleFor(example, argv) };
    else await program.parseAsync(argv, { from: "user" });
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
    else failure = error instanceof CommanderError ? argumentError(error) : error;
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
// Commander messages for these codes name only the declared option or argument, never a value
// typed on the command line (unknown options and invalid choices echo the user's token).
const NAMING_CODES = new Set([
  "commander.missingMandatoryOptionValue",
  "commander.optionMissingArgument",
  "commander.missingArgument",
  "commander.excessArguments",
]);
function argumentError(error: CommanderError): ContractError {
  const message = NAMING_CODES.has(error.code)
    ? error.message.replace(/^error: /u, "")
    : "Invalid command arguments";
  return new ContractError("INVALID_ARGUMENT", message.charAt(0).toUpperCase() + message.slice(1), {
    reason: error.code,
  });
}
