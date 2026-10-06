import { readFile } from "node:fs/promises";
import { parseStrictJson, validateDocument } from "@testmaster/contracts";
import type { Command } from "commander";
import { type Runtime, required } from "./runtime.js";

export function contractCommands(program: Command, runtime: Runtime): void {
  runtime.bind(
    program
      .command("contract")
      .command("validate")
      .requiredOption("--schema <name>")
      .requiredOption("--document <path>"),
    async (rt, _args, options) => ({
      data: validateDocument(
        required(options, "schema"),
        parseStrictJson(await readFile(rt.path(required(options, "document"))), 10 * 1024 * 1024),
      ),
    }),
  );
}
