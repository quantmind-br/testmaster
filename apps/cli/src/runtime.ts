import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Application,
  dryRunPlan,
  lintPlan,
  readServerConfig,
  type ServerConfig,
} from "@testmaster/application";
import {
  ContractError,
  capabilityRegistry,
  type ErrorCode,
  type ExecutablePlan,
  errorRegistry,
} from "@testmaster/contracts";
import { exitCodeForError } from "@testmaster/domain";
import { Command, Option } from "commander";
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
/** `--mode server` selects the PostgreSQL deployment file named by `--config`. */
export const modeOption = () =>
  new Option("--mode <mode>", "Deployment mode").choices(["local", "server"]).default("local");
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
export class Runtime {
  readonly controller = new AbortController();
  readonly requestId = `cli_${randomUUID()}`;
  readonly receipts: unknown[] = [];
  signal: NodeJS.Signals | undefined;
  private application: Application | undefined;
  private opening: Promise<Application> | undefined;
  output: "json" | "text" = "text";
  options: Options = {};
  emitted = false;
  private receipted = false;
  private refusedDryRun: DryRunReceipt | undefined;
  private failed = false;
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
  interrupt(signal: NodeJS.Signals): void {
    if (!this.signal) {
      this.signal = signal;
      this.controller.abort(new Error(signal));
    }
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
  async serverApp(): Promise<{ application: Application; server: ServerConfig }> {
    if (this.signal) throw this.interrupted();
    const server = await readServerConfig(this.path(required(this.options, "config")));
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
    return lintPlan(await readFile(this.path(path)));
  }
  async lintDirectory(path: string): Promise<unknown> {
    const root = this.path(path);
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
        plans.push({ path: file, plan: lintPlan(await readFile(file)) });
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
      if (plan) dryRunPlan(await readFile(this.path(plan)));
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
  bind(command: Command, handler: Handler, prepare?: Handler): Command {
    command.action(async (...args: unknown[]) => {
      const parsed = args.at(-1);
      if (!(parsed instanceof Command))
        throw new ContractError("INTERNAL", "Command context is missing");
      this.options = parsed.optsWithGlobals();
      this.output =
        this.options.json === true ? "json" : this.options.output === "json" ? "json" : "text";
      // A command that declares its own `--dry-run` option implements it; the global one stays out.
      if (this.options.dryRun === true && !parsed.options.some((o) => o.long === "--dry-run")) {
        this.pending = { data: await this.dryRun(parsed, args, prepare) };
        return;
      }
      const path = commandPath(parsed);
      const target = remoteExempt.has(path) ? null : await remoteTarget(this.options);
      if (target) {
        const remote = remoteHandlers[path];
        if (!remote) throw unavailableRemote(path);
        const timeout =
          typeof this.options.requestTimeout === "number" ? this.options.requestTimeout : undefined;
        const client = new RemoteClient(target, this.requestId, this.controller.signal, timeout);
        const outcome = await remote(client, args, this.options);
        if (this.signal) throw this.interrupted();
        this.pending = outcome;
        return;
      }
      const result = await handler(this, args, this.options);
      if (this.signal) throw this.interrupted();
      this.pending = result;
    });
    return command;
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
      for (const warning of warnings) this.stderr.write(`${warning}\n`);
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
    const code = data.code;
    const envelope = {
      schemaVersion: "1.0.0",
      requestId: this.requestId,
      ...(this.refusedDryRun ? { data: this.refusedDryRun } : {}),
      error: { ...data, retryable: errorRegistry[code].retryable === true, nextActions: [] },
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
