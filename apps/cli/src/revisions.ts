import type { Command } from "commander";
import { integer, type Runtime, required, string, version } from "./runtime.js";

export function revisionCommands(test: Command, runtime: Runtime): void {
  const group = test.command("revision").alias("revisions");
  runtime.bind(
    group.command("create <test-id>").requiredOption("--plan <path>").option("--parent <id>"),
    async (rt, args, options) => {
      const plan = await rt.plan(required(options, "plan"));
      const app = await rt.app();
      const revision = app.revisions.create(String(args[0]), plan, string(options, "parent"));
      const test = app.tests.get(revision.testId);
      // A new revision never becomes the test's active one: runs keep using the active revision
      // until it is promoted, so the receipt says so and gives the exact command.
      const active = test.activeRevisionId === revision.id;
      const promote = `testmaster test revision promote ${revision.id} --expected-version ${test.version}`;
      return {
        data: { ...revision, active, nextActions: active ? [] : [promote] },
        warnings: active
          ? []
          : [
              `Revision ${revision.id} is not active: runs keep using ${test.activeRevisionId ?? "no revision"}. Activate it with: ${promote}`,
            ],
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
      .requiredOption("--expected-version <version>", "Current test version", integer)
      .option(
        "--reason <text>",
        "Why you promote (1-2000 characters), recorded on the test with the reviewer and time",
      ),
    async (rt, args, options) => ({
      data: await (await rt.app()).revisions.promote(
        String(args[0]),
        version(options),
        string(options, "reason"),
      ),
    }),
  );
}
