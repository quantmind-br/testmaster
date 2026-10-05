import {
  AGENT_TARGETS,
  type AgentSkillFailure,
  type AgentTarget,
  getAgentSkillStatus,
  listAgentTargets,
  planAgentSkills,
} from "@testmaster/application";
import { ContractError, type ErrorCode } from "@testmaster/contracts";
import { type Command, Option } from "commander";
import { type Options, type Runtime, required, string } from "./runtime.js";

function target(options: Options): AgentTarget {
  const value = required(options, "target");
  if (!(AGENT_TARGETS as readonly string[]).includes(value))
    throw new ContractError("INVALID_ARGUMENT", "Unknown agent target", { target: value });
  return value as AgentTarget;
}
function refuse(result: AgentSkillFailure): never {
  const code: ErrorCode =
    result.code === "CONFLICT"
      ? "PRECONDITION_FAILED"
      : result.code === "INVALID_INPUT"
        ? "INVALID_ARGUMENT"
        : result.code === "INTERNAL_ERROR"
          ? "INTERNAL"
          : result.code;
  throw new ContractError(code, result.message, {
    ...result.details,
    target: result.target,
    reasonCode: result.reasonCode,
    ...(result.path ? { path: result.path } : {}),
  });
}
export function agentCommands(program: Command, runtime: Runtime): void {
  const group = program.command("agent").description("Preview and manage project agent guidance");
  runtime.bind(group.command("list"), () => ({ data: listAgentTargets() }));
  runtime.bind(
    group.command("status").option("--target <target>", "Agent target"),
    async (_runtime, _args, options) => {
      const selected = string(options, "target") ? [target(options)] : AGENT_TARGETS;
      const statuses = [];
      for (const entry of selected) {
        const result = await getAgentSkillStatus({ root: runtime.path("."), target: entry });
        if (!result.ok) refuse(result);
        statuses.push(result);
      }
      return { data: statuses };
    },
  );
  for (const operation of ["install", "remove"] as const) {
    const command = group
      .command(operation)
      .addOption(
        new Option("--target <target>", "Agent target")
          .choices([...AGENT_TARGETS])
          .makeOptionMandatory(),
      )
      .option("--yes", "Apply the reviewed changes (default: preview only)");
    const preview = async (_runtime: Runtime, _args: unknown[], options: Options) => {
      const result = await planAgentSkills({
        root: runtime.path("."),
        target: target(options),
        operation,
      });
      if (!result.ok) refuse(result);
      return result;
    };
    runtime.bind(
      command,
      async (_runtime, args, options) => {
        if (options.yes !== true) {
          const result = await preview(runtime, args, options);
          for (const change of result.plan.changes) runtime.stderr.write(change.diff);
          return { data: { preview: true, applied: false, ...result } };
        }
        await preview(runtime, args, options);
        const app = await runtime.app();
        const result = await app.agentSkills.plan(target(options), operation);
        if (!result.ok) refuse(result);
        for (const change of result.plan.changes) runtime.stderr.write(change.diff);
        const applied = await app.agentSkills.apply(result.plan);
        if (!applied.ok) refuse(applied);
        return { data: { preview: false, applied: true, ...applied } };
      },
      async (_runtime, args, options) => {
        await preview(runtime, args, options);
        return { data: { validated: true } };
      },
    );
  }
}
