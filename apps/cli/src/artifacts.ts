import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ContractError } from "@testmaster/contracts";
import type { Command } from "commander";
import { type Runtime, string } from "./runtime.js";

export function artifactCommands(program: Command, runtime: Runtime): void {
  const group = program.command("artifact").alias("artifacts");
  runtime.bind(
    group
      .command("import-fixture <path>")
      .requiredOption("--mime-type <type>")
      .option("--name <name>"),
    async (rt, args, options) => {
      const path = rt.path(String(args[0]));
      return {
        data: await (await rt.app()).artifacts.importFixtureInput({
          projectId: await rt.project(),
          name: string(options, "name") ?? basename(path),
          bytes: await readFile(path),
          mimeType: string(options, "mimeType") as string,
        }),
      };
    },
  );
  runtime.bind(
    group.command("delete <artifact-id>").requiredOption("--confirm <artifact-id>"),
    async (rt, args, options) => {
      const artifactId = String(args[0]);
      if (string(options, "confirm") !== artifactId)
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Confirmation must exactly match the artifact ID",
        );
      return { data: (await rt.app()).retention.requestDeletion(artifactId) };
    },
  );
  runtime.bind(group.command("deletion-status <id>"), async (rt, args) => ({
    data: (await rt.app()).retention.deletionStatus(String(args[0])),
  }));
  runtime.bind(
    group
      .command("repair-references")
      .option("--apply", "Confirm controlled reference recomputation"),
    async (rt, _args, options) => ({
      data: (await rt.app()).retention.repairReferences(options.apply === true),
    }),
  );
  runtime.bind(
    group
      .command("get <run-id>")
      .option("--attempt <id>")
      .option("--out <path>")
      .option("--failed-only")
      .option("--raw", "Explicitly request restricted raw artifacts")
      .option("--approval <id>", "Production raw evidence approval"),
    async (rt, args, options) => {
      const attemptId = string(options, "attempt");
      const out = string(options, "out");
      return {
        data: await (await rt.app()).artifacts.get(String(args[0]), {
          ...(attemptId ? { attemptId } : {}),
          ...(out ? { out: rt.path(out) } : {}),
          ...(options.failedOnly === true ? { failedOnly: true } : {}),
          ...(options.raw === true ? { allowRestrictedRaw: true } : {}),
          ...(string(options, "approval")
            ? { approvalId: string(options, "approval") as string }
            : {}),
        }),
      };
    },
  );
}
