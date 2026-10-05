import { readFile } from "node:fs/promises";
import { ContractError } from "@testmaster/contracts";
import type { Command } from "commander";
import { collect, type Options, type Runtime, string, strings } from "./runtime.js";

async function secretValue(runtime: Runtime, options: Options): Promise<string> {
  const variable = string(options, "fromEnv");
  const file = string(options, "file");
  if (Boolean(variable) === Boolean(file))
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Provide exactly one of --from-env or --file; inline secrets are forbidden",
    );
  if (variable) {
    const value = process.env[variable];
    if (value === undefined)
      throw new ContractError("INVALID_ARGUMENT", "Secret environment variable is not set");
    return value;
  }
  return readFile(runtime.path(file as string), "utf8");
}
export function secretCommands(program: Command, runtime: Runtime): void {
  const group = program.command("secret").alias("secrets");
  runtime.bind(
    group
      .command("set <name>")
      .option("--from-env <variable>")
      .option("--file <path>")
      .option("--ephemeral")
      .option("--allowed-origin <origin>", "Allowed origin (repeatable)", collect, []),
    async (rt, args, opts) => {
      const value = await secretValue(rt, opts);
      return {
        data: await (await rt.app()).secrets.set(String(args[0]), value, {
          ...(opts.ephemeral === true ? { ephemeral: true } : {}),
          allowedOrigins: strings(opts, "allowedOrigin"),
        }),
      };
    },
    async (rt, _args, opts) => {
      await secretValue(rt, opts);
      return { data: null };
    },
  );
  runtime.bind(group.command("list"), async (rt) => ({
    data: await (await rt.app()).secrets.list(),
  }));
  runtime.bind(group.command("remove <id-or-name>"), async (rt, args) => ({
    data: await (await rt.app()).secrets.remove(String(args[0])),
  }));
  runtime.bind(
    group.command("rotate <id-or-name>").option("--from-env <variable>").option("--file <path>"),
    async (rt, args, opts) => {
      const value = await secretValue(rt, opts);
      return { data: await (await rt.app()).secrets.rotate(String(args[0]), value) };
    },
    async (rt, _args, opts) => {
      await secretValue(rt, opts);
      return { data: null };
    },
  );
}
