import type { MemoryEdit } from "@testmaster/application";
import { ContractError, type MemoryEntryInput } from "@testmaster/contracts";
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

/** One `--source-ref <json>`: an evidence reference the service resolves inside the project. */
function sourceRef(text: string): MemoryEntryInput["sourceRefs"][number] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ContractError("INVALID_ARGUMENT", "--source-ref takes a JSON object", {
      field: "source-ref",
    });
  return parsed as MemoryEntryInput["sourceRefs"][number];
}

/** The request body of `memory add`. */
export function memoryCreateBody(options: Options): MemoryEntryInput {
  const validFrom = string(options, "validFrom");
  const expiresAt = string(options, "expiresAt");
  return {
    text: required(options, "text"),
    sourceRefs: strings(options, "sourceRef").map(sourceRef),
    ...(validFrom ? { validFrom } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

/** The request body of `memory edit`: only the fields the command names change. */
export function memoryEditBody(options: Options): MemoryEdit {
  const text = string(options, "text");
  const validFrom = string(options, "validFrom");
  const expiresAt = string(options, "expiresAt");
  const refs = strings(options, "sourceRef");
  if (expiresAt && options.clearExpiry === true)
    throw new ContractError("INVALID_ARGUMENT", "--expires-at and --clear-expiry are exclusive");
  return {
    expectedVersion: version(options),
    ...(text !== undefined ? { text } : {}),
    ...(refs.length ? { sourceRefs: refs.map(sourceRef) } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(options.clearExpiry === true ? { expiresAt: null } : {}),
  };
}

/**
 * `memory list|add|edit|approve|forget` (ADR-034): reviewed facts about the project that reach
 * planning, analysis and healing prompts as data. An edit sends an entry back to review, and a
 * newer source revision retires the entries that cite the old one.
 */
export function memoryCommands(program: Command, runtime: Runtime): void {
  const memory = program
    .command("memory")
    .description("Approved project memory: facts with their sources that prompts carry as data");
  runtime.bind(
    memory.command("list").description("List the project's memory entries, newest first"),
    async (rt, _args, opts) => {
      const app = await rt.app();
      return { data: app.memory.list(await rt.project(opts)) };
    },
  );
  runtime.bind(
    memory
      .command("add")
      .description("Add a pending entry; it reaches prompts only after approval")
      .requiredOption("--text <text>", "The fact, without credentials or personal data")
      .requiredOption(
        "--source-ref <json>",
        'Evidence reference as JSON, e.g. {"sourceRevisionId":"svr_..."} (repeatable)',
        collect,
        [],
      )
      .option("--valid-from <timestamp>", "The entry applies from this time (default now)")
      .option("--expires-at <timestamp>", "The entry stops applying at this time"),
    async (rt, _args, opts) => {
      const app = await rt.app();
      return { data: app.memory.create(await rt.project(opts), memoryCreateBody(opts)) };
    },
  );
  runtime.bind(
    memory
      .command("edit <id>")
      .description("Edit an entry; the edit clears its approval")
      .requiredOption("--expected-version <version>", "Current version", integer)
      .option("--text <text>")
      .option("--source-ref <json>", "Replaces the sources (repeatable)", collect)
      .option("--valid-from <timestamp>")
      .option("--expires-at <timestamp>")
      .option("--clear-expiry", "Remove the expiry"),
    async (rt, args, opts) => ({
      data: (await rt.app()).memory.update(String(args[0]), memoryEditBody(opts)),
    }),
  );
  runtime.bind(
    memory
      .command("approve <id>")
      .description("Approve an entry as it stands; the author may approve it")
      .requiredOption("--expected-version <version>", "Current version", integer)
      .option("--reason <text>", "Why the fact is approved"),
    async (rt, args, opts) => {
      const reason = string(opts, "reason");
      return {
        data: (await rt.app()).memory.approve(String(args[0]), {
          expectedVersion: version(opts),
          ...(reason !== undefined ? { reason } : {}),
        }),
      };
    },
  );
  runtime.bind(
    memory.command("forget <id>").description("Erase an entry's text and sources; irreversible"),
    async (rt, args) => ({ data: (await rt.app()).memory.forget(String(args[0])) }),
  );
}
