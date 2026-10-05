import type { Command } from "commander";
import { integer, type Runtime, required, string, unavailable, version } from "./runtime.js";

export function projectCommands(program: Command, runtime: Runtime): void {
  const group = program.command("project").alias("projects");
  runtime.bind(
    group.command("create").requiredOption("--name <name>").option("--slug <slug>"),
    async (rt, _args, opts) => {
      const slug = string(opts, "slug");
      return {
        data: await (await rt.app()).projects.create({
          name: required(opts, "name"),
          ...(slug ? { slug } : {}),
        }),
      };
    },
  );
  runtime.bind(group.command("list"), async (rt) => ({
    data: await (await rt.app()).projects.list(),
  }));
  runtime.bind(group.command("get [id]"), async (rt, args, opts) => ({
    data: await (await rt.app()).projects.get(
      typeof args[0] === "string" ? args[0] : await rt.project(opts),
    ),
  }));
  runtime.bind(
    group
      .command("update <id>")
      .option("--name <name>")
      .option("--slug <slug>")
      .requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, opts) => {
      const name = string(opts, "name");
      const slug = string(opts, "slug");
      return {
        data: await (await rt.app()).projects.update(
          String(args[0]),
          { ...(name ? { name } : {}), ...(slug ? { slug } : {}) },
          version(opts),
        ),
      };
    },
  );
  runtime.bind(
    group
      .command("archive <id>")
      .requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, opts) => ({
      data: await (await rt.app()).projects.archive(String(args[0]), version(opts)),
    }),
  );
  runtime.bind(
    group.command("purge <id>").requiredOption("--confirm <id>"),
    () => unavailable("server"),
    () => unavailable("server"),
  );
}
