import { basename } from "node:path";
import { ContractError } from "@testmaster/contracts";
import { type Command, Option } from "commander";
import { integer, type Options, type Runtime, required, string, version } from "./runtime.js";

type SourceFormat = "markdown" | "text" | "prd-json" | "pdf" | "openapi" | "graphql" | "postman";
function input(runtime: Runtime, args: unknown[], options: Options) {
  const positional = typeof args[0] === "string" ? args[0] : undefined;
  const path = string(options, "file") ?? positional;
  const uploadId = string(options, "upload");
  if (Boolean(path) === Boolean(uploadId) || (positional && string(options, "file")))
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Provide exactly one source path, --file or --upload",
    );
  const sourceId = string(options, "source");
  if (sourceId) version(options);
  else if (options.expectedVersion !== undefined)
    throw new ContractError("INVALID_ARGUMENT", "--expected-version requires --source");
  return {
    role: required(options, "role"),
    ...(path ? { path: runtime.path(path), name: string(options, "name") ?? basename(path) } : {}),
    ...(uploadId ? { uploadId } : {}),
    ...(!path && string(options, "name") ? { name: required(options, "name") } : {}),
    ...(string(options, "format") ? { format: required(options, "format") as SourceFormat } : {}),
    ...(sourceId ? { sourceId, expectedVersion: version(options) } : {}),
  };
}

export function sourceCommands(program: Command, runtime: Runtime): void {
  const group = program.command("source");
  runtime.bind(
    group
      .command("add [path]")
      .option("--file <path>")
      .option("--upload <id>")
      .requiredOption("--role <role>")
      .option("--name <name>")
      .addOption(
        new Option("--format <format>").choices([
          "markdown",
          "text",
          "prd-json",
          "pdf",
          "openapi",
          "graphql",
          "postman",
        ]),
      )
      .option("--source <id>")
      .option("--expected-version <version>", "Current source version", integer),
    async (rt, args, options) => ({
      data: await (await rt.app()).sources.add({
        ...input(rt, args, options),
        projectId: await rt.project(options),
      }),
    }),
    (rt, args, options) => {
      input(rt, args, options);
      return { data: null };
    },
  );
  runtime.bind(group.command("list"), async (rt, _args, options) => ({
    data: await (await rt.app()).sources.list(await rt.project(options)),
  }));
  runtime.bind(group.command("get <id>"), async (rt, args) => ({
    data: await (await rt.app()).sources.get(String(args[0])),
  }));
  runtime.bind(
    group
      .command("archive <id>")
      .requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, options) => ({
      data: await (await rt.app()).sources.archive(String(args[0]), version(options)),
    }),
  );
}
