import type { Command } from "commander";
import {
  serverBackupCommands,
  serverBackupCreate,
  serverBackupRestore,
  target,
  workspaceOption,
} from "./operations.js";
import { modeOption, type Runtime, required } from "./runtime.js";

export function backupCommands(program: Command, runtime: Runtime): void {
  const group = program.command("backup");
  runtime.bind(
    workspaceOption(
      group
        .command("review")
        .option("--apply")
        .option("--revocations-confirmed")
        .option("--accept-incomplete-evidence")
        .option(
          "--ledger-loss-accepted",
          "Accept that revocations and tombstones made after the snapshot could not be replayed",
        ),
    ).description(
      "Review a restored profile; --mode server --config reviews the restored PostgreSQL server as the host operator",
    ),
    async (rt, _args, options) => ({
      data: (await target(rt, options)).backups.review({
        apply: options.apply === true,
        revocationsConfirmed: options.revocationsConfirmed === true,
        incompleteEvidenceAccepted: options.acceptIncompleteEvidence === true,
        ledgerLossAccepted: options.ledgerLossAccepted === true,
      }),
    }),
  );
  runtime.bind(
    workspaceOption(group.command("resume-run <run-id>").option("--apply")),
    async (rt, args, options) => ({
      data: (await target(rt, options)).backups.resumeRun(String(args[0]), options.apply === true),
    }),
  );
  runtime.bind(
    group
      .command("create")
      .addOption(modeOption())
      .option("--out <path>", "Backup directory (local profile)")
      .description(
        "Back up the local profile to --out, or the PostgreSQL server profile to backup.destination (--mode server --config)",
      ),
    async (rt, _args, options) => {
      if (options.mode === "server") return serverBackupCreate(rt);
      return {
        data: await (await rt.app()).backups.create(
          await rt.confinedPath(required(options, "out")),
        ),
      };
    },
  );
  runtime.bind(
    group
      .command("restore <path>")
      .addOption(modeOption())
      .option("--out <path>", "Restored data directory (local profile)")
      .option(
        "--keep-schema",
        "Keep the backup's schema version (restore point for an older release) instead of migrating forward",
      )
      .description(
        "Restore the local profile to --out, or restore into the empty PostgreSQL target of --config (--mode server); the server restores in isolation until reviewed",
      ),
    async (rt, args, options) => {
      if (options.mode === "server")
        return serverBackupRestore(rt, String(args[0]), options.keepSchema === true);
      return {
        data: await (await rt.app()).backups.restore(
          await rt.confinedPath(String(args[0])),
          await rt.confinedPath(required(options, "out")),
          { keepSchema: options.keepSchema === true },
        ),
      };
    },
  );
  serverBackupCommands(group, runtime);
}
