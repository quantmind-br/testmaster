import { ContractError } from "@testmaster/contracts";
import { type Command, Option } from "commander";
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

function selection(options: Options): string[] {
  const ids = strings(options, "only").flatMap((value) => value.split(","));
  if (!ids.length || ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "--only must contain distinct, nonempty proposal IDs",
    );
  return ids;
}

export function planCommands(program: Command, runtime: Runtime): void {
  const group = program.command("plan");
  runtime.bind(
    group
      .command("generate")
      .option("--source-snapshot <id>")
      .addOption(new Option("--type <type>").choices(["frontend", "backend"]))
      .option("--requirement <id>", "Requirement (repeatable)", collect)
      .option("--provider <id>")
      .option("--model <id>"),
    async (rt, _args, options) => ({
      data: await (await rt.app()).proposals.generate({
        projectId: await rt.project(options),
        ...(string(options, "sourceSnapshot")
          ? { sourceSnapshotId: required(options, "sourceSnapshot") }
          : {}),
        ...(string(options, "type")
          ? { type: required(options, "type") as "frontend" | "backend" }
          : {}),
        ...(options.requirement !== undefined
          ? { requirementIds: strings(options, "requirement") }
          : {}),
        ...(string(options, "provider") ? { provider: required(options, "provider") } : {}),
        ...(string(options, "model") ? { model: required(options, "model") } : {}),
        signal: rt.controller.signal,
      }),
    }),
  );
  runtime.bind(group.command("list"), async (rt, _args, options) => ({
    data: await (await rt.app()).proposals.list(await rt.project(options)),
  }));
  runtime.bind(group.command("get <batch-id>"), async (rt, args) => ({
    data: await (await rt.app()).proposals.detail(String(args[0])),
  }));
  runtime.bind(
    group
      .command("edit <proposal-id>")
      .requiredOption("--plan <path>")
      .requiredOption("--expected-version <version>", "Current proposal version", integer),
    async (rt, args, options) => ({
      data: await (await rt.app()).proposals.edit(
        String(args[0]),
        await rt.plan(required(options, "plan")),
        version(options),
      ),
    }),
    async (rt, _args, options) => {
      await rt.plan(required(options, "plan"));
      version(options);
      return { data: null };
    },
  );
  for (const operation of ["accept", "reject"] as const) {
    runtime.bind(
      group
        .command(`${operation} <batch-id>`)
        .requiredOption("--only <id...>", "Proposal IDs (comma-separated also supported)")
        .requiredOption("--expected-version <version>", "Current batch version", integer)
        .requiredOption("--idempotency-key <key>"),
      async (rt, args, options) => ({
        data: await (await rt.app()).proposals[operation](String(args[0]), {
          proposalIds: selection(options),
          expectedVersion: version(options),
          idempotencyKey: required(options, "idempotencyKey"),
        }),
      }),
      (_rt, _args, options) => {
        selection(options);
        version(options);
        required(options, "idempotencyKey");
        return { data: null };
      },
    );
  }
}
