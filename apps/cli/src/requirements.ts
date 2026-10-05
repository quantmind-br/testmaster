import { readFile } from "node:fs/promises";
import { ContractError, parseStrictJson } from "@testmaster/contracts";
import type { Command } from "commander";
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

async function patch(runtime: Runtime, options: Options) {
  const file = string(options, "file");
  const text = string(options, "text");
  const criteria = strings(options, "criterion");
  if (file && (text !== undefined || options.criterion !== undefined))
    throw new ContractError(
      "INVALID_ARGUMENT",
      "--file cannot be combined with --text or --criterion",
    );
  if (file) {
    const value = parseStrictJson(await readFile(runtime.path(file)));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ContractError("INVALID_ARGUMENT", "Requirement patch must be an object");
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => !["text", "acceptanceCriteria"].includes(key)) ||
      (record.text !== undefined && typeof record.text !== "string") ||
      (record.acceptanceCriteria !== undefined &&
        (!Array.isArray(record.acceptanceCriteria) ||
          record.acceptanceCriteria.some((item) => typeof item !== "string")))
    )
      throw new ContractError("INVALID_ARGUMENT", "Invalid requirement patch");
    if (record.text === undefined && record.acceptanceCriteria === undefined)
      throw new ContractError("INVALID_ARGUMENT", "Provide a requirement change");
    return record as { text?: string; acceptanceCriteria?: string[] };
  }
  if (text === undefined && options.criterion === undefined)
    throw new ContractError("INVALID_ARGUMENT", "Provide --text, --criterion or --file");
  return {
    ...(text !== undefined ? { text } : {}),
    ...(options.criterion !== undefined ? { acceptanceCriteria: criteria } : {}),
  };
}

export function requirementCommands(program: Command, runtime: Runtime): void {
  const group = program.command("requirement");
  runtime.bind(
    group
      .command("normalize")
      .requiredOption("--source-revision <id...>")
      .option("--provider <id>")
      .option("--model <id>"),
    async (rt, _args, options) => ({
      data: await (await rt.app()).requirements.normalize({
        projectId: await rt.project(options),
        sourceRevisionIds: strings(options, "sourceRevision"),
        ...(string(options, "provider") ? { provider: required(options, "provider") } : {}),
        ...(string(options, "model") ? { model: required(options, "model") } : {}),
        signal: rt.controller.signal,
      }),
    }),
  );
  runtime.bind(group.command("list"), async (rt, _args, options) => ({
    data: await (await rt.app()).requirements.list(await rt.project(options)),
  }));
  runtime.bind(group.command("get <id>"), async (rt, args) => ({
    data: await (await rt.app()).requirements.get(String(args[0])),
  }));
  runtime.bind(
    group
      .command("update <id>")
      .option("--text <text>")
      .option("--criterion <text>", "Replacement criterion (repeatable)", collect)
      .option("--file <path>")
      .requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, options) => ({
      data: await (await rt.app()).requirements.update(
        String(args[0]),
        await patch(rt, options),
        version(options),
      ),
    }),
    async (rt, _args, options) => {
      await patch(rt, options);
      version(options);
      return { data: null };
    },
  );
  runtime.bind(
    group
      .command("approve <id>")
      .requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, options) => ({
      data: await (await rt.app()).requirements.approve(String(args[0]), version(options)),
    }),
  );
  runtime.bind(
    group
      .command("adjudicate <conflict-id>")
      .requiredOption("--selected-requirement <id>")
      .requiredOption("--reason <text>")
      .requiredOption("--expected-version <version>", "Normalization version", integer),
    async (rt, args, options) => ({
      data: await (await rt.app()).requirements.adjudicate(await rt.project(options), {
        conflictId: String(args[0]),
        selectedRequirementId: required(options, "selectedRequirement"),
        reason: required(options, "reason"),
        expectedVersion: version(options),
      }),
    }),
  );
}
