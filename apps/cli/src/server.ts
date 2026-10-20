import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Application,
  assertBackupSeparation,
  issueLocalToken,
  readServerConfig,
  runControllers,
  type ServerConfig,
  serverReadiness,
} from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import { PersistenceDatabase } from "@testmaster/persistence";
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
/** Built-in error classes; any other `name` (custom errors may embed secrets) is never printed. */
const builtInErrorNames: Record<string, true> = {
  Error: true,
  TypeError: true,
  RangeError: true,
  SyntaxError: true,
  ReferenceError: true,
  EvalError: true,
  URIError: true,
  AggregateError: true,
};
/** `node:sqlite` error code; any other `code` (Node system errors, custom ones) is never printed. */
const sqliteErrorCode = "ERR_SQLITE_ERROR";
/** SQLite's own fixed `sqlite3_errstr` texts; an `errstr` outside this list is never printed. */
const sqliteErrorStrings: Record<string, true> = {
  "SQL logic error": true,
  "database is locked": true,
  "database table is locked": true,
  "out of memory": true,
  "attempt to write a readonly database": true,
  "disk I/O error": true,
  "database disk image is malformed": true,
  "database or disk is full": true,
  "unable to open database file": true,
  "constraint failed": true,
  "database schema has changed": true,
};
/**
 * The stderr label of a failed loop. A typed error prints its code and its application-authored
 * `reasonCode`. An untyped one prints only values from closed lists: a built-in error class name
 * and, for `node:sqlite`, the fixed code, an integer `errcode` and a known `errstr`. Names, codes,
 * messages and parameters an error carries beyond those lists are never printed, because they may
 * contain secrets.
 */
function failureLabel(error: unknown): string {
  if (error instanceof ContractError) {
    const reason = (error.details as { reasonCode?: unknown } | undefined)?.reasonCode;
    return typeof reason === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(reason)
      ? `${error.code} (${reason})`
      : error.code;
  }
  if (!(error instanceof Error)) return "INTERNAL";
  const { code, errcode, errstr } = error as Error & {
    code?: unknown;
    errcode?: unknown;
    errstr?: unknown;
  };
  const parts: string[] = [];
  if (Object.hasOwn(builtInErrorNames, error.name)) parts.push(error.name);
  if (code === sqliteErrorCode) {
    parts.push(sqliteErrorCode);
    if (typeof errcode === "number" && Number.isInteger(errcode) && errcode >= 0 && errcode < 65536)
      parts.push(`errcode=${errcode}`);
    if (typeof errstr === "string" && Object.hasOwn(sqliteErrorStrings, errstr)) parts.push(errstr);
  }
  return parts.length ? `INTERNAL (${parts.join(" ")})` : "INTERNAL";
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
      rt.stderr.write(`controller ${name} failed: ${failureLabel(error)}\n`),
  });
}
async function startServerProfile(
  rt: Runtime,
  application: Application,
  server: ServerConfig,
): Promise<{ data: unknown }> {
  await assertBackupSeparation(server);
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
      // `controller` stops the worker and loops; it is aborted by shutdown or by a worker failure.
      const controller = new AbortController();
      announceDrain(rt);
      const worker = application.worker
        .run({
          signal: controller.signal,
          force: rt.forceController.signal,
          onContended: (elapsedMs) =>
            rt.stderr.write(
              `worker is waiting for the database writer lock (${Math.round(elapsedMs / 1000)} s so far; another process holds it)\n`,
            ),
        })
        .then(
          () => {
            // The worker ends by itself only when it was drained or stopped (or revoked) while the
            // server runs: a server without a worker must not keep looking healthy.
            if (!controller.signal.aborted) {
              rt.stderr.write("worker drained; shutting the server down\n");
              controller.abort();
            }
            return null;
          },
          (error: unknown) => {
            rt.stderr.write(`worker failed: ${failureLabel(error)}; shutting the server down\n`);
            controller.abort();
            return { error };
          },
        );
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
        await waitForAbort(AbortSignal.any([rt.controller.signal, controller.signal]));
      } finally {
        controller.abort();
        await app.close();
        await loops;
      }
      const outcome = await worker;
      if (outcome) throw outcome.error;
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
  // Reads the deployment file, not an Application: it must still report a database whose schema
  // is behind or ahead, which `Application.open` refuses. Workers of every workspace are counted.
  runtime.bind(
    group
      .command("readiness")
      .description("Server-profile readiness probes for operators; exits 1 when not ready"),
    async (rt) => {
      const server = await readServerConfig(rt.path(required(rt.options, "config")));
      const database = PersistenceDatabase.openPostgres({
        ...server.database,
        applicationName: "testmaster-readiness",
      });
      try {
        const report = await serverReadiness({ database, server });
        if (report.status !== "ready") process.exitCode = 1;
        return {
          data: report,
          text: `Server ${report.status}${report.reasons.length ? `: ${report.reasons.join(", ")}` : ""}; ${report.worker.ready} worker(s) ready; schema ${report.schema.databaseVersion}/${report.schema.supportedVersion}\n`,
        };
      } finally {
        database.close();
      }
    },
  );
  runtime.bind(
    group
      .command("keygen")
      .option("--out <path>", "New key file (mode 0600); an existing file is never replaced")
      .description("Create a 32-byte master or backup key file and print only its key id"),
    async (rt, _args, options) => {
      const key = randomBytes(32);
      let path: string;
      try {
        path = await rt.writeOutput(required(options, "out"), key, { mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new ContractError("PRECONDITION_FAILED", "Key file already exists");
        throw error;
      }
      const keyId = createHash("sha256").update(key).digest("hex");
      key.fill(0);
      return { data: { path, keyId }, text: `Key ${keyId} written to ${path}\n` };
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
/**
 * One stderr line when the first interruption starts a worker drain. Call it once the application
 * is open and a worker is about to run: an interruption that arrived while the application opened
 * is announced at once, since the worker then starts drained; one that arrived earlier ends the
 * command before any worker exists. The drain has no deadline, so the line names the forced stop:
 * a second interruption.
 */
export function announceDrain(rt: Runtime): void {
  const announce = () =>
    rt.stderr.write(
      "worker draining: attempts in flight finish first; interrupt again to stop them now\n",
    );
  if (rt.controller.signal.aborted) announce();
  else rt.controller.signal.addEventListener("abort", announce, { once: true });
}
/**
 * One worker loop per workspace; new workspaces are picked up while the process runs. Any loop
 * that ends in failure is fatal for the whole process: a loop that is not restarted would leave a
 * healthy-looking process with no worker for that workspace. Sibling loops drain, then the first
 * failure is thrown so the supervisor restarts the process (a build older than the database,
 * `worker_schema_behind`, OPS-038, included; writer contention is waited out, not a failure).
 * `force` stops the attempts every loop still runs, as `WorkerService.run` documents.
 */
export async function runServerWorkers(
  application: Application,
  signal: AbortSignal,
  onError: (workspaceId: string, error: unknown) => void,
  force?: AbortSignal,
): Promise<void> {
  const fail = new AbortController();
  const linked = AbortSignal.any([signal, fail.signal]);
  const loops = new Map<string, Promise<{ error: unknown } | null>>();
  while (!linked.aborted) {
    for (const workspaceId of application.operator.workspaceIds()) {
      if (loops.has(workspaceId)) continue;
      loops.set(
        workspaceId,
        application
          .forWorkspaceSystem(workspaceId)
          .worker.run({ signal: linked, ...(force ? { force } : {}) })
          .then(
            () => null,
            (error: unknown) => {
              onError(workspaceId, error);
              fail.abort();
              return { error };
            },
          ),
      );
    }
    try {
      await delay(5000, undefined, { signal: linked });
    } catch {
      break;
    }
  }
  const failed = (await Promise.all(loops.values())).find((outcome) => outcome !== null);
  if (failed) throw failed.error;
}
