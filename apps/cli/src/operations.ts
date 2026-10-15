import {
  type Application,
  backupAgentRegistry,
  backupSettings,
  createServerBackup,
  listServerBackups,
  readKeyFile,
  readServerConfig,
  restoreServerBackup,
  runControllers,
  type ServerConfig,
  verifyServerBackup,
} from "@testmaster/application";
import {
  ContractError,
  type IncidentCloseInput,
  type IncidentEventInput,
} from "@testmaster/contracts";
import type { Command } from "commander";
import {
  collect,
  modeOption,
  type Options,
  type Runtime,
  required,
  string,
  strings,
} from "./runtime.js";

/** Operations run in-process: as the local user, or as the workspace system principal on the host. */
export async function target(rt: Runtime, options: Options): Promise<Application> {
  if (options.mode !== "server") return rt.app();
  const { application } = await rt.serverApp();
  const ids = application.operator.workspaceIds();
  const requested = string(options, "workspace");
  const id = requested ?? (ids.length === 1 ? ids[0] : undefined);
  if (!id)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "--workspace <id> is required on a multi-workspace server",
    );
  if (!ids.includes(id))
    throw new ContractError("NOT_FOUND", "Workspace does not exist", { workspaceId: id });
  return application.forWorkspaceSystem(id, rt.requestId);
}

export const workspaceOption = (command: Command): Command =>
  command
    .addOption(modeOption())
    .option("--workspace <id>", "Workspace on a multi-workspace server (--mode server)");

const evidence = (values: string[]): { kind: string; ref: string }[] =>
  values.map((value) => {
    const separator = value.indexOf(":");
    if (separator < 1 || separator === value.length - 1)
      throw new ContractError("INVALID_ARGUMENT", "Evidence must be <kind>:<ref>", { value });
    return { kind: value.slice(0, separator), ref: value.slice(separator + 1) };
  });

const resources = (values: string[]): { type: string; id: string }[] =>
  evidence(values).map((value) => ({ type: value.kind, id: value.ref }));

function incidentEvent(options: Options): IncidentEventInput {
  const kind = required(options, "kind");
  const text = required(options, "text");
  const refs = evidence(strings(options, "evidence")) as never;
  switch (kind) {
    case "timeline":
      return { kind, text };
    case "evidence":
      return { kind, text, evidenceRefs: refs };
    case "reach":
      return {
        kind,
        text,
        reach: {
          scope: required(options, "scope") as "confirmed",
          description: required(options, "description"),
          resources: resources(strings(options, "resource")),
        },
      };
    case "action":
      return {
        kind,
        text,
        action: {
          description: required(options, "description"),
          verificationCriterion: required(options, "criterion"),
          owner: required(options, "owner"),
          ...(string(options, "due") ? { dueAt: required(options, "due") } : {}),
        },
      };
    case "action_verified":
      return { kind, text, actionEventId: required(options, "actionEvent"), evidenceRefs: refs };
    case "communication":
      return {
        kind,
        text,
        communication: {
          state: required(options, "state") as "private_notified",
          audience: required(options, "audience"),
        },
      };
    case "status":
      return {
        kind,
        text,
        status: required(options, "status") as "mitigated",
        gates: {
          security: evidence(strings(options, "gateSecurity")) as never,
          consistency: evidence(strings(options, "gateConsistency")) as never,
        },
      };
    default:
      throw new ContractError("INVALID_ARGUMENT", `Unknown incident event kind: ${kind}`);
  }
}

export function operationsCommands(program: Command, runtime: Runtime): void {
  const ops = program
    .command("ops")
    .description("Operate the workspace: admission, DLQ, alerts, retention, incidents");
  runtime.bind(workspaceOption(ops.command("status")), async (rt, _args, options) => ({
    data: (await target(rt, options)).operations.status(),
  }));
  runtime.bind(workspaceOption(ops.command("slo")), async (rt, _args, options) => ({
    data: (await target(rt, options)).telemetry.slo(),
  }));
  for (const action of ["pause", "drain", "resume"] as const)
    runtime.bind(
      workspaceOption(
        ops.command(`${action}`).description(`${action} Run admission for the workspace`),
      ).requiredOption("--reason <text>"),
      async (rt, _args, options) => ({
        data: (await target(rt, options)).operations.admission({
          action,
          reason: required(options, "reason"),
        }),
      }),
    );
  const reconcile = ops.command("reconcile");
  for (const mode of ["preview", "apply"] as const)
    runtime.bind(workspaceOption(reconcile.command(mode)), async (rt, _args, options) => ({
      data: await (await target(rt, options)).operations.reconcile({ mode }),
    }));
  const dlq = ops.command("dlq");
  runtime.bind(workspaceOption(dlq.command("list")), async (rt, _args, options) => ({
    data: { items: (await target(rt, options)).operations.dlq() },
  }));
  runtime.bind(
    workspaceOption(dlq.command("requeue"))
      .requiredOption("--source <source>")
      .requiredOption("--id <id>"),
    async (rt, _args, options) => ({
      data: (await target(rt, options)).operations.requeue({
        source: required(options, "source"),
        id: required(options, "id"),
      }),
    }),
  );
  runtime.bind(
    workspaceOption(
      ops
        .command("isolation")
        .command("release")
        .description("Lift restore isolation after review"),
    ).requiredOption("--reason <text>"),
    async (rt, _args, options) => ({
      data: (await target(rt, options)).operations.releaseIsolation(required(options, "reason")),
    }),
  );
  const alerts = ops.command("alerts");
  runtime.bind(
    workspaceOption(alerts.command("list")).option("--state <state>"),
    async (rt, _args, options) => {
      const state = string(options, "state");
      return {
        data: {
          items: (await target(rt, options)).alerts.list(state ? { state: state as "firing" } : {}),
        },
      };
    },
  );
  runtime.bind(workspaceOption(alerts.command("ack <id>")), async (rt, args, options) => ({
    data: (await target(rt, options)).alerts.acknowledge(String(args[0])),
  }));
  runtime.bind(
    workspaceOption(alerts.command("evaluate")).description(
      "Evaluate every alert rule once for the workspace (admin); the local profile runs no alert loop",
    ),
    async (rt, _args, options) => {
      const outcome = await (await target(rt, options)).alerts.evaluate();
      const failed = Object.keys(outcome.errors);
      const lines = [
        `Alerts evaluated: ${outcome.fired.length} fired, ${outcome.resolved.length} resolved, ${failed.length} rule errors`,
        ...outcome.fired.map((alert) => `  fired ${alert.rule} (${alert.id})`),
        ...failed.map((rule) => `  error ${rule}: ${outcome.errors[rule]}`),
      ];
      // A rule that could not be evaluated leaves its alerts as they were: the run is not clean.
      return {
        data: outcome,
        text: `${lines.join("\n")}\n`,
        ...(failed.length ? { exit: 1 } : {}),
      };
    },
  );
  runtime.bind(workspaceOption(ops.command("alert-rules")), async (rt, _args, options) => ({
    data: { items: (await target(rt, options)).alerts.rules() },
  }));
  const backup = ops.command("backup");
  runtime.bind(
    workspaceOption(backup.command("request")).requiredOption("--reason <text>"),
    async (rt, _args, options) => ({
      data: (await target(rt, options)).operations.requestBackup(required(options, "reason")),
    }),
  );
  runtime.bind(
    workspaceOption(backup.command("verify"))
      .requiredOption("--backup-id <id>")
      .requiredOption("--reason <text>"),
    async (rt, _args, options) => ({
      data: (await target(rt, options)).operations.requestRestoreVerification({
        backupId: required(options, "backupId"),
        reason: required(options, "reason"),
      }),
    }),
  );
  const retention = ops.command("retention");
  for (const mode of ["preview", "run"] as const)
    runtime.bind(
      workspaceOption(retention.command(mode)).option(
        "--now <iso>",
        "Evaluate the windows at this instant",
      ),
      async (rt, _args, options) => {
        const now = string(options, "now");
        return {
          data: await (await target(rt, options)).retentionPurge.run({
            dryRun: mode === "preview",
            ...(now ? { now: new Date(now) } : {}),
          }),
        };
      },
    );
  const incident = ops.command("incident");
  runtime.bind(workspaceOption(incident.command("list")), async (rt, _args, options) => ({
    data: { items: (await target(rt, options)).incidents.list() },
  }));
  runtime.bind(workspaceOption(incident.command("show <id>")), async (rt, args, options) => ({
    data: (await target(rt, options)).incidents.get(String(args[0])),
  }));
  runtime.bind(
    workspaceOption(incident.command("create"))
      .requiredOption("--title <title>")
      .requiredOption("--severity <severity>")
      .requiredOption("--category <category>")
      .requiredOption("--summary <text>")
      .option("--detected-at <iso>")
      .option("--affected-version <v>", "Affected version (repeatable)", collect, [])
      .option("--resource <type:id>", "Affected resource (repeatable)", collect, []),
    async (rt, _args, options) => ({
      data: (await target(rt, options)).incidents.create({
        title: required(options, "title"),
        severity: required(options, "severity") as "critical",
        category: required(options, "category") as "outage",
        summary: required(options, "summary"),
        ...(string(options, "detectedAt") ? { detectedAt: required(options, "detectedAt") } : {}),
        versions: strings(options, "affectedVersion"),
        resources: resources(strings(options, "resource")),
      }),
    }),
  );
  runtime.bind(
    workspaceOption(incident.command("update <id>"))
      .requiredOption(
        "--kind <kind>",
        "timeline|evidence|reach|action|action_verified|communication|status",
      )
      .requiredOption("--text <text>")
      .option("--evidence <kind:ref>", "Evidence reference (repeatable)", collect, [])
      .option("--scope <scope>", "reach: confirmed|suspected|unknown")
      .option("--description <text>")
      .option("--resource <type:id>", "reach: affected resource (repeatable)", collect, [])
      .option("--criterion <text>", "action: how completion is verified")
      .option("--owner <owner>")
      .option("--due <iso>")
      .option("--action-event <id>", "action_verified: the action event")
      .option("--state <state>", "communication: none|private_notified|public_disclosed")
      .option("--audience <text>")
      .option("--status <status>", "status: mitigated|resumed")
      .option("--gate-security <kind:ref>", "status resumed: security gate evidence", collect, [])
      .option(
        "--gate-consistency <kind:ref>",
        "status resumed: consistency gate evidence",
        collect,
        [],
      ),
    async (rt, args, options) => ({
      data: (await target(rt, options)).incidents.addEvent(String(args[0]), incidentEvent(options)),
    }),
  );
  runtime.bind(
    workspaceOption(incident.command("close <id>"))
      .requiredOption("--resolution <text>")
      .requiredOption("--data-affected <state>", "confirmed|suspected|none_with_evidence|unknown")
      .option(
        "--evidence <kind:ref>",
        "Evidence for a no-data-affected claim (repeatable)",
        collect,
        [],
      ),
    async (rt, args, options) => ({
      data: (await target(rt, options)).incidents.close(String(args[0]), {
        resolution: required(options, "resolution"),
        dataAffected: required(options, "dataAffected") as IncidentCloseInput["dataAffected"],
        noDataAffectedEvidence: evidence(strings(options, "evidence")) as never,
      }),
    }),
  );
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Server-profile backup commands; they need the backup key, so only the host operator and the agent run them. */
export function serverBackupCommands(group: Command, runtime: Runtime): void {
  const modeConfig = (command: Command): Command => command.addOption(modeOption());
  const settingsOf = async (
    rt: Runtime,
  ): Promise<{ application: Application; server: ServerConfig }> => rt.serverApp();
  runtime.bind(
    modeConfig(group.command("list")).description("List server backups (needs the backup key)"),
    async (rt) => {
      const { server } = await settingsOf(rt);
      const key = await readKeyFile(server.security.backupKeyFile, "security.backupKeyFile");
      return { data: { items: await listServerBackups(backupSettings(server).destination, key) } };
    },
  );
  runtime.bind(
    modeConfig(group.command("verify <path>")).description("Verify one server backup end to end"),
    async (rt, args) => {
      const { server } = await settingsOf(rt);
      return { data: await verifyServerBackup(rt.path(String(args[0])), server) };
    },
  );
  runtime.bind(
    modeConfig(group.command("agent")).description(
      "Run the backup agent: fulfil backup requests, schedule daily backups, apply retention",
    ),
    async (rt) => {
      const { application, server } = await settingsOf(rt);
      backupSettings(server);
      const controller = new AbortController();
      const loops = runControllers(application, backupAgentRegistry(server), {
        profile: "server",
        signal: controller.signal,
        onError: (name, error) =>
          rt.stderr.write(
            `backup agent ${name} failed: ${error instanceof ContractError ? error.code : "INTERNAL"}\n`,
          ),
      });
      rt.emit({ data: { agent: "running" }, text: "Backup agent running\n" });
      try {
        await waitForAbort(rt.controller.signal);
      } finally {
        controller.abort();
        await loops;
      }
      return { data: { agent: "stopped" } };
    },
  );
}

export async function serverBackupCreate(rt: Runtime) {
  const { application, server } = await rt.serverApp();
  const result = await createServerBackup({
    database: application.controllerScope().database,
    server,
  });
  return {
    data: {
      backupId: result.backupId,
      directory: result.directory,
      evidenceComplete: result.evidenceComplete,
      missingObjects: result.missingObjects.length,
    },
  };
}

export async function serverBackupRestore(rt: Runtime, directory: string, keepSchema: boolean) {
  const server = await readServerConfig(rt.path(required(rt.options, "config")));
  return { data: await restoreServerBackup({ directory, server, keepSchema }) };
}
