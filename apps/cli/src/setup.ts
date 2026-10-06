import { exportEffectiveConfig, resolveConfig } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import type { Command } from "commander";
import { type Runtime, string, unavailable } from "./runtime.js";

export function setupCommands(program: Command, runtime: Runtime): void {
  runtime.bind(program.command("config").command("show"), async (rt) => ({
    data: exportEffectiveConfig(
      await resolveConfig({
        cwd: rt.path("."),
        ...(string(rt.options, "config") ? { configPath: rt.path(String(rt.options.config)) } : {}),
        ...(string(rt.options, "profile") ? { profile: String(rt.options.profile) } : {}),
      }),
    ),
  }));
  runtime.bind(
    program
      .command("init")
      .option("--mode <mode>", "Local or server setup", "local")
      .option("--name <name>")
      .option("--base-url <url>")
      .option("--overwrite", "Confirm replacing existing configuration"),
    async (rt, _args, options) => {
      if (options.mode === "server") unavailable("server");
      if (options.mode !== "local")
        throw new ContractError("INVALID_ARGUMENT", "Mode must be local or server");
      const app = await rt.app();
      const name = string(options, "name");
      const baseUrl = string(options, "baseUrl");
      const result = await app.init({
        ...(name ? { name } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(options.overwrite === true ? { overwrite: true } : {}),
      });
      return { data: result, warnings: result.notice ? [result.notice] : [] };
    },
    (_rt, _args, options) => {
      if (options.mode === "server") unavailable("server");
      if (options.mode !== "local")
        throw new ContractError("INVALID_ARGUMENT", "Mode must be local or server");
      return { data: null };
    },
  );
  runtime.bind(
    program.command("doctor").option("--target <url>", "Explicitly probe target"),
    async (rt, _args, options) => {
      const target = string(options, "target");
      const result = await (await rt.app()).doctor(target ? { target } : {});
      return { data: result, exit: result.status === "FAIL" ? 9 : 0 };
    },
  );
  runtime.bind(program.command("capabilities"), async (rt) => ({
    data: await (await rt.app()).capabilities(),
  }));
}
