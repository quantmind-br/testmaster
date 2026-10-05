import { ContractError } from "@testmaster/contracts";
import type { Command } from "commander";
import { type Runtime, required, string } from "./runtime.js";

export function reportCommands(program: Command, runtime: Runtime): void {
  const group = program.command("report").alias("reports");
  runtime.bind(
    group.command("export <id>").requiredOption("--format <format>").option("--out <path>"),
    async (rt, args, options) => {
      const format = required(options, "format");
      if (
        format !== "json" &&
        format !== "markdown" &&
        format !== "html" &&
        format !== "junit" &&
        format !== "allure"
      )
        throw new ContractError("INVALID_ARGUMENT", "Unsupported report format");
      const out = string(options, "out");
      if (!out && format === "allure")
        throw new ContractError("INVALID_ARGUMENT", "Allure export requires --out");
      const exported = await (await rt.app()).reports.export(
        String(args[0]),
        format,
        out ? rt.path(out) : undefined,
      );
      return {
        data: exported,
        ...(!out && rt.output === "text" && typeof exported === "string" ? { text: exported } : {}),
      };
    },
  );
}
