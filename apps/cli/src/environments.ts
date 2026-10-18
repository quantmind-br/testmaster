import { ContractError } from "@testmaster/contracts";
import type { Command } from "commander";
import { listOrPage, withPaging } from "./paging.js";
import {
  collect,
  integer,
  type Options,
  type Runtime,
  required,
  string,
  strings,
  version,
} from "./runtime.js";

function environmentPatch(opts: Options) {
  const name = string(opts, "name");
  const baseUrl = string(opts, "baseUrl");
  const profile = string(opts, "networkProfile");
  const locale = string(opts, "locale");
  const timezone = string(opts, "timezone");
  const authRefs = strings(opts, "authRef");
  const additionalOrigins = strings(opts, "additionalOrigin");
  const ignoredOrigins = strings(opts, "ignoredOrigin");
  const serverLogContainer = string(opts, "serverLogContainer");
  if (opts.clearServerLog === true && serverLogContainer)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "--clear-server-log cannot be combined with --server-log-container",
    );
  if (profile && !["public", "private", "local-loopback"].includes(profile))
    throw new ContractError("INVALID_ARGUMENT", "Invalid network profile");
  if (opts.clearAdditionalOrigins === true && additionalOrigins.length)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "--clear-additional-origins cannot be combined with --additional-origin",
    );
  if (opts.clearIgnoredOrigins === true && ignoredOrigins.length)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "--clear-ignored-origins cannot be combined with --ignored-origin",
    );
  return {
    ...(name ? { name } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(profile ? { networkProfile: profile as "public" | "private" | "local-loopback" } : {}),
    ...(authRefs.length ? { authRefs } : {}),
    ...(additionalOrigins.length
      ? { additionalOrigins }
      : opts.clearAdditionalOrigins === true
        ? { additionalOrigins: [] }
        : {}),
    ...(ignoredOrigins.length
      ? { ignoredOrigins }
      : opts.clearIgnoredOrigins === true
        ? { ignoredOrigins: [] }
        : {}),
    ...(locale ? { locale } : {}),
    ...(timezone ? { timezone } : {}),
    ...(typeof opts.production === "boolean" ? { production: opts.production } : {}),
    ...(serverLogContainer
      ? { serverLog: { kind: "docker" as const, container: serverLogContainer } }
      : opts.clearServerLog === true
        ? { serverLog: null }
        : {}),
  };
}
function environmentOptions(command: Command): Command {
  return command
    .option("--name <name>")
    .option("--base-url <url>")
    .option("--network-profile <profile>")
    .option("--locale <locale>")
    .option("--timezone <timezone>")
    .option("--auth-ref <id>", "Auth profile bound to this environment (repeatable)", collect, [])
    .option(
      "--additional-origin <origin>",
      "Exact extra origin page subrequests (images, fonts, styles, media, scripts, requests) may reach; replaces the current list (repeatable)",
      collect,
      [],
    )
    .option("--clear-additional-origins", "Remove every additional origin")
    .option(
      "--ignored-origin <origin>",
      "Exact origin whose requests are aborted and recorded without failing the run, never reaching the network (for example a third-party script); replaces the current list (repeatable)",
      collect,
      [],
    )
    .option("--clear-ignored-origins", "Remove every ignored origin")
    .option(
      "--server-log-container <name>",
      "Docker container of the application server: the log lines it writes during each attempt become the evidence logs/server.log (opt-in)",
    )
    .option("--clear-server-log", "Stop reading the server log")
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
  runtime.bind(withPaging(group.command("list"), 100), async (rt, _args, opts) => {
    const projectId = await rt.project(opts);
    return {
      data: await listOrPage(
        rt,
        (await rt.app()).environments.list(projectId),
        `environments:${projectId}`,
        opts,
      ),
    };
  });
  runtime.bind(group.command("get <id-or-name>"), async (rt, args, opts) => ({
    data: await (await rt.app()).environments.get(String(args[0]), await rt.project(opts)),
  }));
  runtime.bind(group.command("revisions <id-or-name>"), async (rt, args) => ({
    data: (await rt.app()).environments.revisions(String(args[0])),
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
