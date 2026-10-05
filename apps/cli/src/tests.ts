import { scaffoldPlan } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import type { Command } from "commander";
import { revisionCommands } from "./revisions.js";
import {
  collect,
  integer,
  type Options,
  type Runtime,
  required,
  string,
  strings,
  unavailable,
  version,
} from "./runtime.js";
import { testExecutionCommands } from "./test-execution.js";

function metadata(options: Options) {
  const name = string(options, "name");
  const priority = string(options, "priority");
  if (priority && !["critical", "high", "normal", "low"].includes(priority))
    throw new ContractError("INVALID_ARGUMENT", "Priority must be critical, high, normal, or low");
  return {
    ...(name ? { name } : {}),
    ...(priority ? { priority: priority as "critical" | "high" | "normal" | "low" } : {}),
    ...(options.tag !== undefined ? { tags: strings(options, "tag") } : {}),
  };
}
export function testCommands(program: Command, runtime: Runtime): void {
  const group = program.command("test").alias("tests");
  runtime.bind(
    group.command("scaffold").requiredOption("--type <type>"),
    (_rt, _args, options) => {
      const type = required(options, "type");
      if (type !== "frontend" && type !== "backend")
        throw new ContractError("INVALID_ARGUMENT", "Type must be frontend or backend");
      return { data: scaffoldPlan(type) };
    },
    (_rt, _args, options) => {
      const type = required(options, "type");
      if (type !== "frontend" && type !== "backend")
        throw new ContractError("INVALID_ARGUMENT", "Type must be frontend or backend");
      scaffoldPlan(type);
      return { data: null };
    },
  );
  runtime.bind(
    group.command("lint").option("--plan <path>").option("--dir <path>"),
    async (rt, _args, options) => {
      const plan = string(options, "plan");
      const directory = string(options, "dir");
      if (Boolean(plan) === Boolean(directory))
        throw new ContractError("INVALID_ARGUMENT", "Provide exactly one of --plan or --dir");
      return {
        data: plan
          ? { validated: true, plan: await rt.plan(plan) }
          : await rt.lintDirectory(directory as string),
      };
    },
    async (rt, _args, options) => {
      const plan = string(options, "plan");
      const directory = string(options, "dir");
      if (Boolean(plan) === Boolean(directory))
        throw new ContractError("INVALID_ARGUMENT", "Provide exactly one of --plan or --dir");
      if (plan) await rt.plan(plan);
      else await rt.lintDirectory(directory as string);
      return { data: null };
    },
  );
  runtime.bind(
    group
      .command("create")
      .option("--plan <path>")
      .option("--code <path>")
      .option("--runner <kind>")
      .option("--name <name>")
      .option("--tag <tag>", "Tag (repeatable)", collect)
      .option("--priority <priority>"),
    async (rt, _args, options) => {
      if (string(options, "code")) {
        if (string(options, "plan"))
          throw new ContractError("INVALID_ARGUMENT", "--plan and --code are mutually exclusive");
        unavailable("code-import");
      }
      const plan = await rt.plan(required(options, "plan"));
      return {
        data: await (await rt.app()).tests.create({
          ...metadata(options),
          projectId: await rt.project(options),
          plan,
        }),
      };
    },
    async (rt, _args, options) => {
      if (string(options, "code")) unavailable("code-import");
      await rt.plan(required(options, "plan"));
      metadata(options);
      return { data: null };
    },
  );
  runtime.bind(
    group
      .command("list")
      .option("--tag <tag>", "Tag (repeatable)", collect)
      .option("--priority <priority>", "Priority (repeatable)", collect)
      .option("--status <status>", "Status (repeatable)", collect),
    async (rt, _args, options) => {
      const tests = await (await rt.app()).tests.list(await rt.project(options));
      const tags = strings(options, "tag");
      const priorities = strings(options, "priority");
      const statuses = strings(options, "status");
      return {
        data: tests.filter(
          (test) =>
            (!tags.length || tags.some((tag) => test.tags.includes(tag))) &&
            (!priorities.length || priorities.includes(test.priority)) &&
            (!statuses.length || statuses.includes(test.archivedAt ? "archived" : "active")),
        ),
      };
    },
  );
  runtime.bind(group.command("get <id>"), async (rt, args) => ({
    data: await (await rt.app()).tests.get(String(args[0])),
  }));
  runtime.bind(
    group
      .command("update <id>")
      .option("--name <name>")
      .option("--tag <tag>", "Replacement tags (repeatable)", collect)
      .option("--priority <priority>")
      .requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, options) => ({
      data: await (await rt.app()).tests.update(
        String(args[0]),
        metadata(options),
        version(options),
      ),
    }),
  );
  runtime.bind(
    group
      .command("archive <id>")
      .requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, options) => ({
      data: await (await rt.app()).tests.archive(String(args[0]), version(options)),
    }),
  );
  runtime.bind(
    group.command("import").allowUnknownOption().allowExcessArguments(),
    () => unavailable("code-import"),
    () => unavailable("code-import"),
  );
  runtime.bind(
    group.command("flaky [id]").allowUnknownOption().allowExcessArguments(),
    () => unavailable("flake-study"),
    () => unavailable("flake-study"),
  );
  revisionCommands(group, runtime);
  testExecutionCommands(group, runtime);
}
