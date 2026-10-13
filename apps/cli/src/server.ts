import { setTimeout as delay } from "node:timers/promises";
import {
  type Application,
  issueLocalToken,
  runControllers,
  type ServerConfig,
} from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import { createServer } from "@testmaster/server";
import type { Command } from "commander";
import {
  collect,
  integer,
  modeOption,
  type Runtime,
  required,
  string,
  strings,
} from "./runtime.js";

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
/** Runs the controller loops until the signal aborts; a failing tick is reported and retried. */
function controllerLoops(
  rt: Runtime,
  application: Application,
  profile: "local" | "server",
  signal: AbortSignal,
): Promise<void> {
  return runControllers(application, application.controllers, {
    profile,
    signal,
    onError: (name, error) =>
      rt.stderr.write(
        `controller ${name} failed: ${error instanceof ContractError ? error.code : "INTERNAL"}\n`,
      ),
  });
}
async function startServerProfile(
  rt: Runtime,
  application: Application,
  server: ServerConfig,
): Promise<{ data: unknown }> {
  const { host, port } = server.server.listen;
  const app = createServer({ application, mode: "server", server });
  const controller = new AbortController();
  const loops = controllerLoops(rt, application, "server", controller.signal);
  const address = await app.listen({ host, port });
  const receipt = { address, publicOrigin: server.server.publicOrigin, mode: "server" };
  rt.emit({
    data: receipt,
    text: `Server listening at ${address} (public origin ${server.server.publicOrigin})\n`,
  });
  try {
    await waitForAbort(rt.controller.signal);
  } finally {
    controller.abort();
    await app.close();
    await loops;
  }
  return { data: receipt };
}

export function serverCommands(program: Command, runtime: Runtime): void {
  const group = program.command("server");
  runtime.bind(
    group
      .command("start")
      .option("--host <host>", "Loopback bind address", "127.0.0.1")
      .option("--port <port>", "HTTP port", integer, 7331)
      .addOption(modeOption())
      .option("--origin <origin>", "Allowed browser Origin (repeatable)", collect, [])
      .option("--token-file <path>", "Private capability token file")
      .option("--print-token", "Explicitly emit the capability token")
      .description("Start the API; --mode server reads the deployment file named by --config"),
    async (rt, _args, options) => {
      if (options.mode === "server") {
        const { application, server } = await rt.serverApp();
        return startServerProfile(rt, application, server);
      }
      const host = string(options, "host") ?? "127.0.0.1";
      if (host !== "127.0.0.1")
        throw new ContractError("POLICY_DENIED", "Local server binds 127.0.0.1 only");
      const application = await rt.app();
      const tokenPath = string(options, "tokenFile");
      const token = await issueLocalToken(
        application,
        tokenPath ? { tokenPath: rt.path(tokenPath) } : {},
      );
      const app = createServer({ application, host, origins: strings(options, "origin") });
      const controller = new AbortController();
      const worker = application.worker.run({ signal: controller.signal }).catch((error) => {
        controller.abort(error);
      });
      const loops = controllerLoops(rt, application, "local", controller.signal);
      const address = await app.listen({ host, port: options.port as number });
      const receipt = {
        address,
        tokenPath: token.tokenPath,
        ...(options.printToken ? { token: token.token } : {}),
      };
      rt.emit({
        data: receipt,
        text: `Server listening at ${address}\nCapability token file: ${token.tokenPath}${options.printToken ? `\n${token.token}` : ""}`,
      });
      try {
        await waitForAbort(rt.controller.signal);
      } finally {
        controller.abort();
        await app.close();
        await worker;
        await loops;
      }
      return { data: receipt };
    },
  );
  runtime.bind(
    group
      .command("bootstrap")
      .option("--workspace-name <name>", "Name of the first workspace")
      .option("--owner-login <login>", "Login of the first organization owner")
      .option("--owner-display-name <name>", "Display name of the first owner")
      .description("Create the first workspace and owner on the server database (needs --config)"),
    async (rt, _args, options) => {
      const workspaceName = required(options, "workspaceName");
      const ownerLogin = required(options, "ownerLogin");
      const { application } = await rt.serverApp();
      const displayName = string(options, "ownerDisplayName");
      const result = application.operator.bootstrap({
        workspaceName,
        ownerLogin,
        ...(displayName ? { ownerDisplayName: displayName } : {}),
      });
      const data = {
        workspaceId: result.workspace.id,
        ownerPrincipalId: result.ownerPrincipalId,
        ownerLogin: result.ownerLogin,
        ownerRecoveryToken: result.ownerRecovery.recoveryToken,
        recoveryExpiresAt: result.ownerRecovery.recoveryExpiresAt,
      };
      return {
        data,
        text: `Workspace ${data.workspaceId} created.\nOne-time owner recovery token (valid until ${data.recoveryExpiresAt}):\n${data.ownerRecoveryToken}\n`,
      };
    },
  );
  runtime.bind(
    group
      .command("operator-token")
      .option("--expires-at <iso>", "Token expiry (default 30 days)")
      .description("Print a new operator token once; it may create workspaces (needs --config)"),
    async (rt, _args, options) => {
      const { application } = await rt.serverApp();
      const expiresAt = string(options, "expiresAt");
      const issued = application.operator.operatorToken(expiresAt ? { expiresAt } : {});
      return {
        data: issued,
        text: `Operator token ${issued.id} (valid until ${issued.expiresAt}), shown once:\n${issued.token}\n`,
      };
    },
  );
}
export function identityCommands(program: Command, runtime: Runtime): void {
  const group = program.command("identity");
  runtime.bind(
    group
      .command("recovery-token")
      .option("--login <login>", "Login of the member to recover")
      .description("Print a one-time recovery token for a member (needs --config)"),
    async (rt, _args, options) => {
      const login = required(options, "login");
      const { application } = await rt.serverApp();
      const grant = application.operator.recoveryToken(login);
      return {
        data: grant,
        text: `Recovery token for ${grant.principalId} (valid until ${grant.recoveryExpiresAt}), shown once:\n${grant.recoveryToken}\n`,
      };
    },
  );
}
/** One worker loop per workspace; new workspaces are picked up while the process runs. */
export async function runServerWorkers(
  application: Application,
  signal: AbortSignal,
  onError: (workspaceId: string, error: unknown) => void,
): Promise<void> {
  const loops = new Map<string, Promise<unknown>>();
  while (!signal.aborted) {
    for (const workspaceId of application.operator.workspaceIds()) {
      if (loops.has(workspaceId)) continue;
      loops.set(
        workspaceId,
        application
          .forWorkspaceSystem(workspaceId)
          .worker.run({ signal })
          .catch((error) => onError(workspaceId, error)),
      );
    }
    try {
      await delay(5000, undefined, { signal });
    } catch {
      break;
    }
  }
  await Promise.all(loops.values());
}
