import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Application, dryRunPlan, lintPlan } from "@testmaster/application";
import {
  ContractError,
  capabilityRegistry,
  type ErrorCode,
  type ExecutablePlan,
  errorRegistry,
} from "@testmaster/contracts";
import { exitCodeForError } from "@testmaster/domain";
import { Command } from "commander";

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
export function string(options: Options, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}
export function required(options: Options, key: string): string {
  const value = string(options, key);
  if (!value) throw new ContractError("INVALID_ARGUMENT", `--${key} is required`);
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
export const dryReceipt = {
  dryRun: true,
  validated: true,
  operations: [],
  unresolvedPreconditions: [],
};
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
  pending: Result | undefined;
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
        ...(profile ? { profile } : {}),
      }).then((app) => {
        this.application = app;
        return app;
      });
    }
    return this.opening;
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
  bind(command: Command, handler: Handler, prepare?: Handler): Command {
    command.action(async (...args: unknown[]) => {
      const parsed = args.at(-1);
      if (!(parsed instanceof Command))
        throw new ContractError("INTERNAL", "Command context is missing");
      this.options = parsed.optsWithGlobals();
      this.output =
        this.options.json === true ? "json" : this.options.output === "json" ? "json" : "text";
      if (this.options.example === true) {
        this.pending = {
          data: {
            example: true,
            dryRun: false,
            command: parsed.name(),
            fixture: { schemaVersion: "1.0.0" },
          },
        };
        return;
      }
      if (this.options.dryRun === true) {
        if (prepare) await prepare(this, args, this.options);
        else if (string(this.options, "plan"))
          dryRunPlan(await readFile(this.path(required(this.options, "plan"))));
        if (!prepare && string(this.options, "dir"))
          await this.lintDirectory(required(this.options, "dir"));
        this.pending = { data: dryReceipt };
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
    if (this.emitted) return;
    this.emitted = true;
    const actual = this.signal ? this.interrupted() : error;
    const data = errorData(actual);
    const code = data.code;
    const envelope = {
      schemaVersion: "1.0.0",
      requestId: this.requestId,
      error: { ...data, retryable: errorRegistry[code].retryable === true, nextActions: [] },
    };
    if (this.output === "json") this.stdout.write(`${JSON.stringify(envelope)}\n`);
    else this.stderr.write(`${code}: ${data.message}\n`);
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
