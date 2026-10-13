import {
  assessRelease,
  readServerConfig,
  resolveConfig,
  upgradeLocalProfile,
} from "@testmaster/application";
import { PersistenceDatabase } from "@testmaster/persistence";
import type { Command } from "commander";
import { modeOption, type Runtime, required, string } from "./runtime.js";

/**
 * Host-operator access to the PostgreSQL database named by the server deployment file; the
 * credentials in that file, not an Application identity, authorize it. `Application.open` is not
 * used because it refuses a schema that is behind, which is exactly what these commands fix.
 */
async function withServerDatabase<T>(
  rt: Runtime,
  work: (database: PersistenceDatabase) => Promise<T>,
): Promise<T> {
  const server = await readServerConfig(rt.path(required(rt.options, "config")));
  const database = PersistenceDatabase.openPostgres({
    ...server.database,
    applicationName: "testmaster-db",
  });
  try {
    return await work(database);
  } finally {
    database.close();
  }
}

export function databaseCommands(program: Command, runtime: Runtime): void {
  const group = program.command("db");
  runtime.bind(
    group
      .command("status")
      .addOption(modeOption())
      .description(
        "Applied migrations; --mode server reads the PostgreSQL deployment file named by --config",
      ),
    async (rt, _args, options) => {
      if (options.mode === "server")
        return withServerDatabase(rt, async (database) => ({
          data: { engine: "postgres", ...database.status() },
        }));
      const app = await rt.app();
      app.context.authorize("R");
      return { data: app.database.status() };
    },
  );
  runtime.bind(
    group
      .command("migrate")
      .addOption(modeOption())
      .description(
        "Forward-only migration; --mode server migrates the PostgreSQL deployment file named by --config",
      ),
    async (rt, _args, options) => {
      if (options.mode === "server")
        return withServerDatabase(rt, async (database) => {
          await database.migrate();
          return { data: { engine: "postgres", ...database.status() } };
        });
      const app = await rt.app();
      app.context.authorize("A");
      await app.database.migrate();
      return { data: app.database.status() };
    },
  );
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
