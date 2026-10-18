import { readFile, writeFile } from "node:fs/promises";
import {
  ContractError,
  jsonSchema,
  parseStrictJson,
  schemaCatalog,
  similarSchemaNames,
  validateDocument,
} from "@testmaster/contracts";
import type { Command } from "commander";
import { type Runtime, required, string } from "./runtime.js";

/** The JSON Schema of one public contract; an unknown name is refused with the names near it. */
function contractSchema(name: string): Record<string, unknown> {
  if (Object.hasOwn(schemaCatalog, name)) return jsonSchema(name);
  const close = similarSchemaNames(name);
  const similar = close.length ? `similar names are ${close.join(", ")}; ` : "";
  const shown = name.length > 100 ? `${name.slice(0, 100)}...` : name;
  throw new ContractError(
    "NOT_FOUND",
    `Unknown schema ${shown}: ${similar}names are case-sensitive (for example ExecutablePlan, Step, ProjectConfig, RunRequest)`,
  );
}

export function contractCommands(program: Command, runtime: Runtime): void {
  const group = program.command("contract");
  runtime.bind(
    group.command("validate").requiredOption("--schema <name>").requiredOption("--document <path>"),
    async (rt, _args, options) => ({
      data: validateDocument(
        required(options, "schema"),
        parseStrictJson(await readFile(rt.path(required(options, "document"))), 10 * 1024 * 1024),
      ),
    }),
  );
  runtime.bind(
    group
      .command("schema <name>")
      .option("--out <path>", "New file that receives the schema instead of the output")
      .description(
        "Print the JSON Schema of a public contract (ExecutablePlan, Step, ProjectConfig, RunRequest, ...), the one packages/contracts/schemas/<name>.json holds",
      ),
    async (rt, args, options) => {
      const name = String(args[0]);
      const schema = contractSchema(name);
      const out = string(options, "out");
      if (!out) return { data: schema };
      const text = `${JSON.stringify(schema)}\n`;
      try {
        await writeFile(rt.path(out), text, { flag: "wx" });
      } catch (error) {
        throw new ContractError("INVALID_ARGUMENT", "--out must name a file that does not exist", {
          field: "out",
          reason: (error as NodeJS.ErrnoException).code ?? "unwritable",
        });
      }
      return { data: { name, path: rt.path(out), sizeBytes: Buffer.byteLength(text) } };
    },
  );
}
