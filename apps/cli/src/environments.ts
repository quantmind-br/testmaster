import { ContractError } from "@testmaster/contracts";
import type { Command } from "commander";
import { integer, type Options, type Runtime, required, string, version } from "./runtime.js";

function environmentPatch(opts: Options) {
  const name = string(opts, "name");
  const baseUrl = string(opts, "baseUrl");
  const profile = string(opts, "networkProfile");
  const locale = string(opts, "locale");
  const timezone = string(opts, "timezone");
  if (profile && !["public", "private", "local-loopback"].includes(profile))
    throw new ContractError("INVALID_ARGUMENT", "Invalid network profile");
  return {
    ...(name ? { name } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(profile ? { networkProfile: profile as "public" | "private" | "local-loopback" } : {}),
    ...(locale ? { locale } : {}),
    ...(timezone ? { timezone } : {}),
    ...(typeof opts.production === "boolean" ? { production: opts.production } : {}),
  };
}
function environmentOptions(command: Command): Command {
  return command
    .option("--name <name>")
    .option("--base-url <url>")
    .option("--network-profile <profile>")
    .option("--locale <locale>")
    .option("--timezone <timezone>")
    .option("--production");
}
export function environmentCommands(program: Command, runtime: Runtime): void {
  const group = program.command("env").alias("environments");
  runtime.bind(environmentOptions(group.command("create")), async (rt, _args, opts) => ({
    data: await (await rt.app()).environments.create({
      ...environmentPatch(opts),
      projectId: await rt.project(opts),
      name: required(opts, "name"),
      baseUrl: required(opts, "baseUrl"),
    }),
  }));
  runtime.bind(group.command("list"), async (rt, _args, opts) => ({
    data: await (await rt.app()).environments.list(await rt.project(opts)),
  }));
  runtime.bind(group.command("get <id-or-name>"), async (rt, args, opts) => ({
    data: await (await rt.app()).environments.get(String(args[0]), await rt.project(opts)),
  }));
  runtime.bind(
    environmentOptions(group.command("update <id>")).requiredOption(
      "--expected-version <version>",
      "Current version",
      integer,
    ),
    async (rt, args, opts) => ({
      data: await (await rt.app()).environments.update(
        String(args[0]),
        environmentPatch(opts),
        version(opts),
      ),
    }),
  );
  runtime.bind(
    group
      .command("set-default <id>")
      .requiredOption("--expected-version <version>", "Current project version", integer),
    async (rt, args, opts) => ({
      data: await (await rt.app()).environments.setDefault(
        await rt.project(opts),
        String(args[0]),
        version(opts),
      ),
    }),
  );
  runtime.bind(
    group
      .command("archive <id>")
      .requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, opts) => ({
      data: await (await rt.app()).environments.archive(String(args[0]), version(opts)),
    }),
  );
}
