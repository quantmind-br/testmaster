import { assessRelease, resolveConfig, upgradeLocalProfile } from "@testmaster/application";
import type { Command } from "commander";
import { type Runtime, required, string } from "./runtime.js";

export function databaseCommands(program: Command, runtime: Runtime): void {
  const group = program.command("db");
  runtime.bind(group.command("status"), async (rt) => {
    const app = await rt.app();
    app.context.authorize("R");
    return { data: app.database.status() };
  });
  runtime.bind(group.command("migrate"), async (rt) => {
    const app = await rt.app();
    app.context.authorize("A");
    await app.database.migrate();
    return { data: app.database.status() };
  });
  // Opens the database read-only (plan) or through the ordered upgrade (apply); it never goes
  // through Application.open, which would migrate before drain and backup.
  runtime.bind(
    group
      .command("upgrade")
      .description("Preview (default) or apply the ordered offline upgrade: drain, backup, migrate")
      .option("--apply", "Run the upgrade; requires --backup-out")
      .option("--backup-out <path>", "New directory for the pre-migration backup")
      .option("--drain-timeout <seconds>", "Maximum wait for in-flight work", "60"),
    async (rt, _args, options) => {
      const config = await resolveConfig({
        cwd: rt.path("."),
        ...(string(rt.options, "config") ? { configPath: rt.path(String(rt.options.config)) } : {}),
        ...(string(rt.options, "profile") ? { profile: String(rt.options.profile) } : {}),
      });
      if (options.apply !== true) {
        const assessment = await assessRelease({ dataDir: config.dataDir });
        return { data: { dryRun: true, ...assessment }, warnings: assessment.warnings };
      }
      const seconds = Number(string(options, "drainTimeout"));
      const result = await upgradeLocalProfile({
        dataDir: config.dataDir,
        backupDir: rt.path(required(options, "backupOut")),
        drainTimeoutMs: Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 60000,
      });
      return { data: result, warnings: result.receipt.warnings };
    },
  );
}
