import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Application,
  dryRunPlan,
  entity,
  lintPlan,
  readServerConfig,
  retryWriterContention,
  type ServerConfig,
} from "@testmaster/application";
import {
  ContractError,
  capabilityRegistry,
  type ErrorCode,
  type ExecutablePlan,
  errorBody,
} from "@testmaster/contracts";
import { exitCodeForError, semanticHash } from "@testmaster/domain";
import { Command, Option } from "commander";
import {
  confineServicePath,
  readConfinedFile,
  type WriteConfinedOptions,
  writeConfinedFile,
} from "./files.js";
import {
  commandPath,
  RemoteClient,
  remoteExempt,
  remoteHandlers,
  remoteTarget,
  unavailableRemote,
} from "./remote.js";

export type Options = Record<string, unknown>;
export class CliFailure extends ContractError {
  constructor(
    code: ErrorCode,
    message: string,
    readonly exit: number,
    details: Record<string, unknown> = {},
  ) {
    super(code, message, details);
  }
}
/**
 * `--mode server` selects the PostgreSQL deployment file named by `--config`. `server start` also
 * accepts `distributed` (`extra`), which additionally registers the process as one controller.
 */
export const modeOption = (extra: readonly string[] = []) =>
  new Option("--mode <mode>", "Deployment mode")
    .choices(["local", "server", ...extra])
    .default("local");
export function string(options: Options, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}
/** Commander stores `--token-file` as `tokenFile`; messages name the flag the user typed. */
export function required(options: Options, key: string): string {
  const value = string(options, key);
  if (!value) {
    const flag = key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
    throw new ContractError("INVALID_ARGUMENT", `--${flag} is required`);
  }
  return value;
}
export function integer(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
    throw new ContractError("INVALID_ARGUMENT", "Expected a positive integer");
  return Number(value);
}
export function seconds(value: string): number {
  const result = Number(value) * 1000;
  if (
    !Number.isFinite(result) ||
    !Number.isSafeInteger(result) ||
    result < 1 ||
    result > 2147483647
  )
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Timeout must be positive seconds within the supported range",
    );
  return result;
}
export function version(options: Options): number {
  const value = options.expectedVersion;
  if (typeof value !== "number")
    throw new ContractError("PRECONDITION_REQUIRED", "--expected-version is required");
  return value;
}
export function strings(options: Options, key: string): string[] {
  const value = options[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}
/** `key=value` options as a label map; the schema at the service boundary checks keys and values. */
export function labels(values: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator < 1)
      throw new ContractError("INVALID_ARGUMENT", "A label must be written key=value", { value });
    const key = value.slice(0, separator);
    if (Object.hasOwn(result, key))
      throw new ContractError("INVALID_ARGUMENT", "A label key is repeated", { key });
    result[key] = value.slice(separator + 1);
  }
  return result;
}
export function unavailable(capability: string): never {
  throw new ContractError("CAPABILITY_UNAVAILABLE", "Capability is unavailable", {
    capability,
    milestone: capabilityRegistry[capability]?.milestone ?? "M2",
  });
}
/** What a command's dry run would do; `prepare` handlers return it in `data`, or `null` for nothing. */
export interface DryRunReport {
  operations: Array<{ operation: string } & Record<string, unknown>>;
  /** Conditions only the real run can check, because they depend on stored state or the network. */
  unresolvedPreconditions: string[];
}
export const dryRunReport = (
  operations: DryRunReport["operations"],
  unresolvedPreconditions: string[] = [],
): Result => ({ data: { operations, unresolvedPreconditions } satisfies DryRunReport });
export interface DryRunReceipt extends DryRunReport {
  dryRun: true;
  validated: boolean;
}
function dryRunReceipt(validated: boolean, report: DryRunReport | null): DryRunReceipt {
  return {
    dryRun: true,
    validated,
    operations: report?.operations ?? [],
    unresolvedPreconditions: report?.unresolvedPreconditions ?? [],
  };
}
function isDryRunReport(value: unknown): value is DryRunReport {
  return (
    typeof value === "object" &&
    value !== null &&
    "operations" in value &&
    Array.isArray(value.operations) &&
    "unresolvedPreconditions" in value &&
    Array.isArray(value.unresolvedPreconditions)
  );
}
export interface Result {
  data: unknown;
  exit?: number;
  text?: string;
  warnings?: string[];
}
export type Handler = (
  runtime: Runtime,
  args: unknown[],
  options: Options,
) => Promise<Result> | Result;
/** Error codes that refuse a command itself, as the MCP server's `DENIED_CODES` do for a tool. */
const deniedCodes: Record<string, true> = {
  INVALID_ARGUMENT: true,
  UNAUTHENTICATED: true,
  FORBIDDEN: true,
  POLICY_DENIED: true,
};
export class Runtime {
  readonly controller = new AbortController();
  /** Aborted by a second interruption: a draining worker then stops the attempts it still runs. */
  readonly forceController = new AbortController();
  readonly requestId = `cli_${randomUUID()}`;
  readonly receipts: unknown[] = [];
  /** Warnings a handler's helpers add; `dispatch` appends them to the command's result. */
  readonly warnings: string[] = [];
  signal: NodeJS.Signals | undefined;
  private application: Application | undefined;
  private opening: Promise<Application> | undefined;
  output: "json" | "text" = "text";
  options: Options = {};
  emitted = false;
  private receipted = false;
  private refusedDryRun: DryRunReceipt | undefined;
  private failed = false;
  /** True once a command's audit record could not be written; the error envelope says so. */
  private auditUnrecorded = false;
  pending: Result | undefined;
  /** Set by `init`, the one command that may start a workspace inside an initialized tree. */
  allowNestedWorkspace = false;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  constructor(
    stdout: NodeJS.WritableStream = process.stdout,
    stderr: NodeJS.WritableStream = process.stderr,
  ) {
    this.stdout = stdout;
    this.stderr = stderr;
  }
  path(path: string): string {
    return resolve(string(this.options, "cwd") ?? process.cwd(), path);
  }
  /**
   * The bytes of one existing regular file named by a user path. A symbolic link anywhere on the
   * path, a directory, or a file with several hard links is refused with `FORBIDDEN`.
   */
  readInput(path: string): Promise<Buffer> {
    return readConfinedFile(this.path(path));
  }
  /**
   * Creates one new file named by a user path and returns its absolute path. It never replaces an
   * existing file (`EEXIST` propagates) and refuses a symbolic link anywhere on the path.
   */
  async writeOutput(
    path: string,
    data: string | Uint8Array,
    options?: WriteConfinedOptions,
  ): Promise<string> {
    const absolute = this.path(path);
    await writeConfinedFile(absolute, data, options);
    return absolute;
  }
  /**
   * The absolute form of a user path that an application service opens by itself (a directory, an
   * output the service creates): refused with `FORBIDDEN` when a symbolic link is on the way or is
   * the path itself. The path may not exist yet.
   */
  confinedPath(path: string): Promise<string> {
    return confineServicePath(this.path(path));
  }
  /**
   * Adds a warning to the command's result, once per distinct message. Text output also writes it
   * to stderr at once: the command may run long before its result is printed.
   */
  warn(message: string): void {
    if (this.warnings.includes(message)) return;
    this.warnings.push(message);
    if (this.output === "text") this.stderr.write(`${message}\n`);
  }
  interrupt(signal: NodeJS.Signals): void {
    if (!this.signal) {
      this.signal = signal;
      this.controller.abort(new Error(signal));
    } else this.forceController.abort(new Error(signal));
  }
  interrupted(): CliFailure {
    return new CliFailure(
      "UNAVAILABLE",
      "Command interrupted",
      this.signal === "SIGHUP" ? 129 : this.signal === "SIGTERM" ? 143 : 130,
      {
        signal: this.signal,
        receipts: this.receipts,
        ...(this.receipts.length === 1 &&
        typeof this.receipts[0] === "object" &&
        this.receipts[0] !== null &&
        "runId" in this.receipts[0]
          ? { runId: this.receipts[0].runId }
          : {}),
      },
    );
  }
  async app(): Promise<Application> {
    if (this.signal) throw this.interrupted();
    if (!this.opening) {
      if (string(this.options, "endpoint") || process.env.TESTMASTER_ENDPOINT)
        unavailable("server");
      const cwd = string(this.options, "cwd");
      const configPath = string(this.options, "config");
      const profile = string(this.options, "profile");
      this.opening = Application.open({
        correlationId: this.requestId,
        ...(cwd ? { cwd } : {}),
        ...(configPath ? { configPath: this.path(configPath) } : {}),
        ...(this.allowNestedWorkspace ? { allowNestedWorkspace: true } : {}),
        ...(profile ? { profile } : {}),
      }).then((app) => {
        this.application = app;
        return app;
      });
    }
    return this.opening;
  }
  /**
   * Opens the PostgreSQL server profile from the deployment file named by `--config`; for the
   * server commands that option is the server configuration, never a project configuration.
   */
  async serverApp(
    expectMode?: ServerConfig["mode"],
  ): Promise<{ application: Application; server: ServerConfig }> {
    if (this.signal) throw this.interrupted();
    const server = await readServerConfig(this.path(required(this.options, "config")));
    if (expectMode && server.mode !== expectMode)
      throw new ContractError(
        "INVALID_ARGUMENT",
        `--mode ${expectMode} does not match the deployment file, which declares mode ${server.mode}`,
        { reasonCode: "server_mode_mismatch" },
      );
    const cwd = string(this.options, "cwd");
    this.opening ??= Application.open({
      correlationId: this.requestId,
      server,
      ...(cwd ? { cwd } : {}),
    }).then((app) => {
      this.application = app;
      return app;
    });
    return { application: await this.opening, server };
  }
  async project(options: Options = this.options): Promise<string> {
    const explicit = string(options, "project") ?? process.env.TESTMASTER_PROJECT_ID;
    if (explicit) return explicit;
    const app = await this.app();
    const configured = app.config.effectiveConfig.config.project?.id;
    if (configured) return configured;
    const projects = await app.projects.list();
    const project = projects.find((item) => !item.archivedAt);
    if (!project)
      throw new ContractError(
        "PRECONDITION_REQUIRED",
        "Initialize or select a project with --project",
      );
    return project.id;
  }
  async plan(path: string): Promise<ExecutablePlan> {
    return lintPlan(await this.readInput(path));
  }
  async lintDirectory(path: string): Promise<unknown> {
    const root = await this.confinedPath(path);
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => resolve(entry.parentPath, entry.name))
      .sort();
    if (!files.length)
      throw new ContractError("INVALID_ARGUMENT", "No JSON plans found in directory");
    const plans = [];
    const errors = [];
    for (const file of files) {
      try {
        plans.push({ path: file, plan: lintPlan(await this.readInput(file)) });
      } catch (error) {
        errors.push({ path: file, ...errorData(error) });
      }
    }
    if (errors.length)
      throw new ContractError("INVALID_ARGUMENT", "Plan validation failed", { errors });
    return { validated: true, plans };
  }
  /**
   * The receipt of the global `--dry-run`. `validated: true` only after the command's own
   * `prepare` (or the plan/directory lint) accepted the input; a command with none reports
   * `validated: false` instead of claiming a check that never ran. A refusal sets
   * `refusedDryRun`, which `fail` puts in the error envelope next to the error.
   */
  private async dryRun(command: Command, args: unknown[], prepare: Handler | undefined) {
    try {
      if (prepare) {
        const { data } = await prepare(this, args, this.options);
        return dryRunReceipt(true, isDryRunReport(data) ? data : null);
      }
      const plan = string(this.options, "plan");
      const directory = string(this.options, "dir");
      if (plan) dryRunPlan(await this.readInput(plan));
      if (directory) await this.lintDirectory(directory);
      if (plan || directory) return dryRunReceipt(true, null);
      return dryRunReceipt(false, {
        operations: [],
        unresolvedPreconditions: [
          `"${commandPath(command)}" has no local dry-run validation: its arguments parsed, nothing else was checked and nothing was run`,
        ],
      });
    } catch (error) {
      this.refusedDryRun = dryRunReceipt(false, null);
      throw error;
    }
  }
  /**
   * Reads the parsed command line and answers the global `--dry-run` with its receipt, which is
   * true when it did: the command's handler then never runs, so it cannot authenticate, open the
   * database, call a model or change anything. Every command, bound or not, calls this first.
   */
  async startCommand(parsed: Command, args: unknown[], prepare?: Handler): Promise<boolean> {
    this.options = parsed.optsWithGlobals();
    this.output =
      this.options.json === true ? "json" : this.options.output === "json" ? "json" : "text";
    // A command that declares its own `--dry-run` option implements it; the global one stays out.
    if (this.options.dryRun !== true || parsed.options.some((o) => o.long === "--dry-run"))
      return false;
    this.pending = { data: await this.dryRun(parsed, args, prepare) };
    return true;
  }
  bind(command: Command, handler: Handler, prepare?: Handler): Command {
    command.action(async (...args: unknown[]) => {
      const parsed = args.at(-1);
      if (!(parsed instanceof Command))
        throw new ContractError("INTERNAL", "Command context is missing");
      if (await this.startCommand(parsed, args, prepare)) return;
      const path = commandPath(parsed);
      try {
        await this.dispatch(path, args, handler);
      } catch (error) {
        await this.audit(path, errorData(error).code);
        throw error;
      }
      if (!(await this.audit(path, "completed")) && this.pending)
        this.pending = {
          ...this.pending,
          warnings: [
            ...(this.pending.warnings ?? []),
            "The audit record of this command could not be written (writer busy or storage failed)",
          ],
        };
    });
    return command;
  }
  /** Runs the command locally, or against the `--endpoint` server when one is selected. */
  private async dispatch(path: string, args: unknown[], handler: Handler): Promise<void> {
    const target = remoteExempt.has(path) ? null : await remoteTarget(this.options);
    if (target) {
      const remote = remoteHandlers[path];
      if (!remote) throw unavailableRemote(path);
      const timeout =
        typeof this.options.requestTimeout === "number" ? this.options.requestTimeout : undefined;
      const client = new RemoteClient(target, this.requestId, this.controller.signal, timeout);
      const outcome = await remote(client, args, this.options, this);
      if (this.signal) throw this.interrupted();
      this.pending = outcome;
      return;
    }
    const result = await handler(this, args, this.options);
    if (this.signal) throw this.interrupted();
    this.pending = this.warnings.length
      ? { ...result, warnings: [...(result.warnings ?? []), ...this.warnings] }
      : result;
  }
  /**
   * Appends the invocation's audit record to the workspace the command opened: `cli.command.denied`
   * for the refusals the MCP server also audits as denied (see `auditToolError`),
   * `cli.command.failed` for any other error and `cli.command.completed` for success. Like the
   * MCP record it carries the actor, the command path, a hash of the outcome and the request id
   * the envelope reports, never the arguments. A command that never opened the application (a
   * remote one, a refusal before the workspace was read) has no workspace to record in, and a
   * `--dry-run` must not change state, so neither is recorded. Returns false when the record
   * could not be written, which the failing command's envelope reports as `auditRecorded: false`.
   */
  private async audit(command: string, outcome: "completed" | ErrorCode): Promise<boolean> {
    const app = this.application;
    if (!app || this.options.dryRun === true) return true;
    const action =
      outcome === "completed"
        ? "cli.command.completed"
        : deniedCodes[outcome] === true
          ? "cli.command.denied"
          : "cli.command.failed";
    try {
      await retryWriterContention(
        () =>
          app.context.entities.insert(
            "AuditEvent",
            entity(app.context, "aud", {
              actor: app.context.principalId,
              action,
              resourceId: command.slice(0, 200),
              requestId: this.requestId,
              beforeHash: null,
              afterHash: semanticHash({ command, outcome }),
              timestamp: new Date().toISOString(),
            }),
          ),
        { signal: this.controller.signal },
      );
      return true;
    } catch {
      this.auditUnrecorded = true;
      return false;
    }
  }
  emit(result: Result): void {
    if (this.emitted) return;
    this.emitted = true;
    this.receipted = true;
    const warnings = result.warnings ?? [];
    if (this.output === "json")
      this.stdout.write(
        `${JSON.stringify({ schemaVersion: "1.0.0", requestId: this.requestId, data: result.data, warnings })}\n`,
      );
    else {
      this.stdout.write(result.text ?? `${JSON.stringify(result.data, null, 2)}\n`);
      // `warn` already wrote its own messages.
      for (const warning of warnings)
        if (!this.warnings.includes(warning)) this.stderr.write(`${warning}\n`);
    }
    process.exitCode = result.exit ?? 0;
  }
  fail(error: unknown): void {
    // A long-running command (`server start`, the backup agent) emits its receipt while it keeps
    // running. A failure after that must still be reported and set the exit code; only the
    // operator's own interruption stays silent, because that is the command's normal stop.
    const afterReceipt = this.receipted && !this.failed && !this.signal;
    if (this.emitted && !afterReceipt) return;
    this.emitted = true;
    this.failed = true;
    const actual = this.signal ? this.interrupted() : error;
    const data = errorData(actual);
    if (this.auditUnrecorded) data.details = { ...data.details, auditRecorded: false };
    const code = data.code;
    const envelope = {
      schemaVersion: "1.0.0",
      requestId: this.requestId,
      ...(this.refusedDryRun ? { data: this.refusedDryRun } : {}),
      error: errorBody(data),
    };
    if (this.output === "json") this.stdout.write(`${JSON.stringify(envelope)}\n`);
    else {
      this.stderr.write(`${code}: ${data.message}\n`);
      for (const line of diagnosticLines(data.details)) this.stderr.write(`  ${line}\n`);
    }
    process.exitCode = actual instanceof CliFailure ? actual.exit : exitCodeForError(code);
  }
  async close(): Promise<void> {
    if (this.opening) {
      try {
        await this.opening;
      } catch {
        return;
      }
    }
    await this.application?.close();
  }
}
/**
 * One line per entry of an error's `details.diagnostics` (`code: message`) and `details.issues`
 * (`path: message (rule)`), for the text output: without them a refused document only says that
 * it is invalid.
 */
function diagnosticLines(details: Record<string, unknown>): string[] {
  const entries = (value: unknown) =>
    Array.isArray(value)
      ? value.filter(
          (item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null && "message" in item,
        )
      : [];
  return [
    ...entries(details.diagnostics).map(
      (item) => `${"code" in item ? `${String(item.code)}: ` : ""}${String(item.message)}`,
    ),
    ...entries(details.issues).map(
      (item) =>
        `${String(item.path || "/")}: ${String(item.message)}${"rule" in item ? ` (${String(item.rule)})` : ""}`,
    ),
  ];
}
export function errorData(error: unknown): {
  code: ErrorCode;
  message: string;
  details: Record<string, unknown>;
} {
  if (error instanceof ContractError)
    return {
      code: error.code,
      message: error.message,
      details: { ...error.details, ...(error.issues.length ? { issues: error.issues } : {}) },
    };
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ENOENT")
    return { code: "NOT_FOUND", message: "Input file was not found", details: {} };
  if (code === "EACCES" || code === "EPERM")
    return { code: "FORBIDDEN", message: "File access denied", details: {} };
  return { code: "INTERNAL", message: "Command failed", details: {} };
}
