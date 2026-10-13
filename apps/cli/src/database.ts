import { assessRelease, resolveConfig, upgradeLocalProfile } from "@testmaster/application";
import { PersistenceDatabase, type PostgresConfig } from "@testmaster/persistence";
import type { Command } from "commander";
import { type Options, type Runtime, required, string } from "./runtime.js";

/** PostgreSQL connection options shared by `db status` and `db migrate`. */
function withPostgresOptions(command: Command): Command {
  return command
    .option(
      "--database-url <url>",
      "Operate on a PostgreSQL database (postgres://user@host:port/db)",
    )
    .option("--password-file <path>", "File with the database password (mode 0600)")
    .option("--ca-file <path>", "CA bundle for sslmode=verify-full");
}

/** Host-operator access to a PostgreSQL database; credentials, not an Application identity, authorize it. */
function postgresTarget(options: Options): PostgresConfig | null {
  const url = string(options, "databaseUrl");
  if (!url) return null;
  const passwordFile = string(options, "passwordFile");
  const caFile = string(options, "caFile");
  return {
    url,
    ...(passwordFile ? { passwordFile } : {}),
    ...(caFile ? { caFile } : {}),
    applicationName: "testmaster-db",
  };
}

export function databaseCommands(program: Command, runtime: Runtime): void {
  const group = program.command("db");
  runtime.bind(withPostgresOptions(group.command("status")), async (rt) => {
    const target = postgresTarget(rt.options);
    if (target) {
      const database = PersistenceDatabase.openPostgres(target);
      try {
        return { data: { engine: "postgres", ...database.status() } };
      } finally {
        database.close();
      }
    }
    const app = await rt.app();
    app.context.authorize("R");
    return { data: app.database.status() };
  });
  runtime.bind(withPostgresOptions(group.command("migrate")), async (rt) => {
    const target = postgresTarget(rt.options);
    if (target) {
      const database = PersistenceDatabase.openPostgres(target);
      try {
        await database.migrate();
        return { data: { engine: "postgres", ...database.status() } };
      } finally {
        database.close();
      }
    }
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
