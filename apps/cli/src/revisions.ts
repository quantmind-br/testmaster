import type { Command } from "commander";
import { integer, type Runtime, required, string, version } from "./runtime.js";

export function revisionCommands(test: Command, runtime: Runtime): void {
  const group = test.command("revision").alias("revisions");
  runtime.bind(
    group.command("create <test-id>").requiredOption("--plan <path>").option("--parent <id>"),
    async (rt, args, options) => {
      const plan = await rt.plan(required(options, "plan"));
      return {
        data: await (await rt.app()).revisions.create(
          String(args[0]),
          plan,
          string(options, "parent"),
        ),
      };
    },
  );
  runtime.bind(group.command("list <test-id>"), async (rt, args) => ({
    data: await (await rt.app()).revisions.list(String(args[0])),
  }));
  runtime.bind(group.command("get <id>"), async (rt, args) => ({
    data: await (await rt.app()).revisions.get(String(args[0])),
  }));
  runtime.bind(
    group
      .command("promote <id>")
      .requiredOption("--expected-version <version>", "Current test version", integer),
    async (rt, args, options) => ({
      data: await (await rt.app()).revisions.promote(String(args[0]), version(options)),
    }),
  );
}
