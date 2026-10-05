import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  type ArtifactManifest,
  type ExecutablePlan,
  type JsonValue,
  type PlanStep,
  type ProjectConfig,
  validate,
} from "@testmaster/contracts";
import { scrubText } from "@testmaster/domain";
import { startShop } from "@testmaster/reference-shop";
import { expect } from "vitest";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const cli = join(root, "apps/cli/dist/main.js");
export const terminal: Record<string, true> = {
  passed: true,
  failed: true,
  blocked: true,
  cancelled: true,
  inconclusive: true,
};
export type Json = Record<string, unknown>;
export function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return value as Json;
}
export function text(value: unknown): string {
  if (typeof value !== "string") throw new Error(`Expected string: ${JSON.stringify(value)}`);
  return value;
}
export function items(value: unknown): Json[] {
  if (!Array.isArray(value)) throw new Error(`Expected array: ${JSON.stringify(value)}`);
  return value.map(object);
}
export function data(envelope: unknown): Json {
  const value = object(envelope).data;
  return Array.isArray(value) ? { items: value } : object(value);
}
export interface CommandResult {
  argv: string[];
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  json?: Json;
}
export interface RunningCommand {
  child: ChildProcessWithoutNullStreams;
  result: Promise<CommandResult>;
  stdout: () => string;
  stderr: () => string;
}
export async function signalReady(command: RunningCommand): Promise<void> {
  if (!command.child.pid) throw new Error("CLI process has no PID");
  const pid = command.child.pid;
  await eventually(
    async () => {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const caught = status.match(/^SigCgt:\s*([0-9a-f]+)$/m)?.[1];
      return caught !== undefined && (BigInt(`0x${caught}`) & 2n) !== 0n;
    },
    (ready) => ready,
  );
  await delay(500);
}

export async function eventually<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accepts(value)) return value;
    if (performance.now() >= deadline)
      throw new Error(
        `Journey boundary did not become ready within ${timeoutMs}ms: ${JSON.stringify(value)}`,
      );
    const delay = Promise.withResolvers<void>();
    setTimeout(delay.resolve, 100);
    await delay.promise;
  }
}

export async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      throw error;
    },
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result.sort();
}

export async function diskSnapshot(directory: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function visit(path: string): Promise<void> {
    const info = await stat(path);
    if (info.isDirectory()) {
      snapshot[path.slice(directory.length)] = `directory:${info.mode}`;
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else
      snapshot[path.slice(directory.length)] = `${info.mode}:${createHash("sha256")
        .update(await readFile(path))
        .digest("hex")}`;
  }
  await visit(directory);
  return snapshot;
}

export class Journey {
  readonly commands: CommandResult[] = [];
  readonly runIds: string[] = [];
  readonly oracles: Json[] = [];
  readonly children = new Set<RunningCommand>();
  readonly env: NodeJS.ProcessEnv;
  private readonly diagnosticSecrets = new Set<string>();
  private constructor(
    readonly name: string,
    readonly temporary: string,
    readonly cwd: string,
    readonly home: string,
    readonly dataDir: string,
  ) {
    this.env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      TESTMASTER_DATA_DIR: dataDir,
      TESTMASTER_OFFLINE: "true",
      TESTMASTER_NO_TELEMETRY: "true",
      CI: "true",
    };
    delete this.env.TESTMASTER_PROJECT_ID;
    delete this.env.TESTMASTER_ENDPOINT;
    delete this.env.TESTMASTER_PROFILE;
    delete this.env.TESTMASTER_API_KEY;
    delete this.env.TESTMASTER_MODEL_API_KEY;
    delete this.env.NODE_OPTIONS;
    delete this.env.DOCKER_HOST;
    delete this.env.DOCKER_CONTEXT;
  }
  static async create(name: string): Promise<Journey> {
    const temporary = await mkdtemp(join(tmpdir(), "tm-m1-"));
    const cwd = join(temporary, "repo");
    const home = join(temporary, "home");
    await mkdir(cwd);
    await mkdir(home);
    return new Journey(name, temporary, cwd, home, join(cwd, ".testmaster"));
  }
  start(args: string[], env: NodeJS.ProcessEnv = {}, cwd = this.cwd): RunningCommand {
    const secretEnvIndex = args.indexOf("--from-env");
    if (secretEnvIndex >= 0) {
      const variable = args[secretEnvIndex + 1];
      const value = variable ? (env[variable] ?? this.env[variable]) : undefined;
      if (value) this.diagnosticSecrets.add(value);
    }
    const stream = args.includes("events") && args.includes("ndjson");
    const argv = [cli, ...args, "--output", stream ? "text" : "json", "--no-color"];
    const child = spawn(process.execPath, argv, {
      cwd,
      env: { ...this.env, ...env },
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const completion = Promise.withResolvers<CommandResult>();
    const result = completion.promise;
    child.once("error", completion.reject);
    child.once("close", (exitCode, signal) => {
      const value: CommandResult = { argv, exitCode, signal, stdout, stderr };
      if (stdout.trim()) {
        try {
          value.json = object(JSON.parse(stdout));
        } catch {
          /* A journey assertion reports malformed stdout. */
        }
      }
      this.commands.push(value);
      if (value.json) this.recordIds(value.json);
      completion.resolve(value);
    });
    const running = { child, result, stdout: () => stdout, stderr: () => stderr };
    this.children.add(running);
    void result.finally(() => this.children.delete(running)).catch(() => undefined);
    return running;
  }
  async command(
    args: string[],
    expectedExit = 0,
    env: NodeJS.ProcessEnv = {},
    cwd = this.cwd,
  ): Promise<Json> {
    const result = await this.start(args, env, cwd).result;
    expect(
      result.exitCode,
      `${args.join(" ")} stderr=${result.stderr} stdout=${result.stdout}`,
    ).toBe(expectedExit);
    expect(result.json, `Exactly one JSON document required: ${result.stdout}`).toBeDefined();
    return expectedExit === 0 ? data(result.json) : object(result.json);
  }
  recordIds(value: unknown): void {
    if (typeof value === "string" && /^run_[0-9a-f-]+$/.test(value) && !this.runIds.includes(value))
      this.runIds.push(value);
    else if (Array.isArray(value)) for (const member of value) this.recordIds(member);
    else if (value && typeof value === "object")
      for (const member of Object.values(value)) this.recordIds(member);
  }
  async init(url: string): Promise<Json> {
    const identity = await this.command([
      "init",
      "--mode",
      "local",
      "--name",
      this.name,
      "--base-url",
      url,
    ]);
    const configPath = join(this.cwd, "testmaster.config.json");
    const config = validate<ProjectConfig>(
      "ProjectConfig",
      JSON.parse(await readFile(configPath, "utf8")),
    );
    config.execution = {
      ...config.execution,
      executor: "docker",
      mode: "replay",
      concurrency: 1,
      maxAttempts: 1,
      attemptTimeoutMs: 120_000,
      executionTimeoutMs: 150_000,
      stepTimeoutMs: 5000,
      networkRequestTimeoutMs: 90_000,
    };
    config.healing = { mode: "off" };
    config.artifacts = { trace: "on", video: "off", retentionDays: 30 };
    config.telemetry = { enabled: false };
    await writeFile(configPath, JSON.stringify(config));
    return identity;
  }
  async plan(plan: ExecutablePlan, basename = "plan.json"): Promise<string> {
    const path = join(this.cwd, basename);
    await writeFile(path, JSON.stringify(plan));
    return path;
  }
  async createTest(plan: ExecutablePlan, basename?: string): Promise<Json> {
    const created = await this.command([
      "test",
      "create",
      "--plan",
      await this.plan(plan, basename),
    ]);
    return created;
  }
  async current(runId: string): Promise<Json> {
    return this.command(["run", "get", runId]);
  }
  async observe(
    runId: string,
    accepts: (value: Json) => boolean,
    timeoutMs = 60_000,
  ): Promise<Json> {
    return eventually(() => this.current(runId), accepts, timeoutMs);
  }
  async committed(runId: string): Promise<{ directory: string; manifest: ArtifactManifest }> {
    const manifestPaths = (await files(this.dataDir)).filter((path) =>
      path.endsWith("/manifest.json"),
    );
    for (const path of manifestPaths) {
      const manifest = validate<ArtifactManifest>(
        "ArtifactManifest",
        JSON.parse(await readFile(path, "utf8")),
      );
      if (manifest.runId === runId) return { directory: dirname(path), manifest };
    }
    throw new Error(`No committed evidence manifest for ${runId}`);
  }
  async worker(): Promise<RunningCommand> {
    const worker = this.start(["worker", "start"]);
    await eventually(
      () => this.command(["worker", "status"]),
      (status) =>
        items(status.items).some(
          (row) => workerReady(row) && text(object(row.labels).pid) === String(worker.child.pid),
        ),
    );
    expect(worker.stdout()).toBe("");
    return worker;
  }
  async close(error?: unknown): Promise<void> {
    for (const child of this.children) child.child.kill("SIGTERM");
    await Promise.allSettled([...this.children].map((child) => child.result));
    const failureDiagnostics: Json = {};
    if (error !== undefined) {
      const runs: Json[] = [];
      for (const runId of [...this.runIds]) {
        const diagnostic: Json = { runId };
        for (const operation of ["get", "events", "steps"]) {
          try {
            const result = await this.start(["run", operation, runId]).result;
            diagnostic[operation] = {
              exitCode: result.exitCode,
              json: result.json,
              stderr: result.stderr,
            };
          } catch (failure) {
            diagnostic[operation] = { captureError: String(failure) };
          }
        }
        runs.push(diagnostic);
      }
      failureDiagnostics.runs = runs;
      const artifacts: Json[] = [];
      try {
        for (const path of await files(this.dataDir)) {
          if (
            !/(?:^|\/)(?:manifest\.json|meta\.json|container\.log|protocol\.json|runtime\.json)$/.test(
              path,
            )
          )
            continue;
          try {
            const info = await stat(path);
            if (!info.isFile()) continue;
            const maxBytes = 1024 * 1024;
            const handle = await open(path, "r");
            let content: string;
            try {
              const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
              content = buffer.subarray(0, bytesRead).toString("utf8");
            } finally {
              await handle.close();
            }
            artifacts.push({
              relativePath: path.slice(this.dataDir.length + 1),
              sizeBytes: info.size,
              truncated: info.size > maxBytes,
              content,
            });
          } catch (failure) {
            artifacts.push({
              relativePath: path.slice(this.dataDir.length + 1),
              captureError: String(failure),
            });
          }
        }
      } catch (failure) {
        failureDiagnostics.artifactCaptureError = String(failure);
      }
      failureDiagnostics.artifacts = artifacts;
    }
    await mkdir(join(root, "validation/results"), { recursive: true });
    await writeFile(
      join(root, "validation/results", `${this.name}.json`),
      scrubText(
        JSON.stringify(
          {
            schemaVersion: "1.0.0",
            journey: this.name,
            class: "deterministic-e2e",
            runner: "real-docker",
            externalDependency: "local-reference-shop",
            observedAt: new Date().toISOString(),
            passed: error === undefined,
            ...(error === undefined ? {} : { error: String(error) }),
            commands: this.commands.map((command) => ({
              argv: command.argv,
              exitCode: command.exitCode,
              signal: command.signal,
              ...(command.json && typeof command.json === "object" && !Array.isArray(command.json)
                ? {
                    requestId: command.json.requestId,
                    error: command.json.error,
                    warnings: command.json.warnings,
                  }
                : {}),
              stderr: command.stderr,
            })),
            runIds: this.runIds,
            oracleVerdicts: this.oracles,
            ...(error === undefined ? {} : { failureDiagnostics }),
            limitations: ["Chromium and declarative HTTP only; no LLM or SaaS claim."],
          },
          null,
          2,
        ),
        [...this.diagnosticSecrets],
      ).text.replace(/tm-canary-[A-Za-z0-9-]+-never-public/g, "[REDACTED]"),
    );
    await chmod(this.home, 0o700);
    await rm(this.temporary, { recursive: true, force: true });
  }
}
export function workerReady(status: Json): boolean {
  if (Array.isArray(status.items)) return status.items.map(object).some(workerReady);
  if (Array.isArray(status.workers)) return status.workers.map(object).some(workerReady);
  return (
    status.status === "running" ||
    status.state === "ready" ||
    status.state === "running" ||
    status.active === true ||
    status.running === true
  );
}
export async function journey(
  name: string,
  body: (session: Journey) => Promise<void>,
): Promise<void> {
  const session = await Journey.create(name);
  let error: unknown;
  try {
    await body(session);
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await session.close(error);
  }
}

export const literal = (value: JsonValue) => ({ literal: value });
export const action = (id: string, operation: string, input: Json): PlanStep =>
  ({ id, description: id, kind: "action", operation, input }) as PlanStep;
export const assertion = (
  id: string,
  input: Json,
  predicate: string,
  value?: JsonValue,
): PlanStep =>
  ({
    id,
    description: id,
    kind: "assertion",
    operation: "assert",
    input,
    expectation: value === undefined ? { predicate } : { predicate, value: literal(value) },
  }) as PlanStep;
export const locator = (value: string) => ({ by: "testId", value });
export function executable(
  name: string,
  runner: "http" | "playwright",
  steps: PlanStep[],
): ExecutablePlan {
  return {
    schemaVersion: "1.0.0",
    kind: "executable",
    name,
    type: runner === "http" ? "backend" : "frontend",
    runner,
    requirementRefs: [],
    steps,
  };
}
export function healthPlan(expected = "ok", path = "health"): ExecutablePlan {
  return executable(
    "Service health",
    "http",
    [
      action("health_request", "request", { method: "GET", pathSegments: [literal(path)] }),
      assertion("health_status", { responseStepId: "health_request" }, "statusIn"),
      assertion(
        "health_value",
        { responseStepId: "health_request", jsonPointer: "/status" },
        "jsonEquals",
        expected,
      ),
    ].map((step) =>
      step.id === "health_status"
        ? ({ ...step, expectation: { predicate: "statusIn", values: [200] } } as PlanStep)
        : step,
    ),
  );
}
export function persistencePlan(): ExecutablePlan {
  return executable("Checkout persists across reload", "playwright", [
    action("login", "navigate", { path: "/login" }),
    action("password", "fill", {
      locator: locator("password"),
      value: literal("correct-password"),
    }),
    action("signin", "click", {
      locator: { by: "role", role: "button", name: "Sign in", exact: true },
    }),
    assertion("catalog_ready", { locator: locator("catalog-ready") }, "visible"),
    action("add", "click", { locator: locator("add-p1") }),
    assertion("added", { locator: locator("toast") }, "textEquals", "Added to cart"),
    action("cart", "click", { locator: { by: "role", role: "link", name: "Cart", exact: true } }),
    action("checkout", "click", { locator: locator("checkout-button") }),
    assertion("success_toast", { locator: locator("toast") }, "textContains", "Order created:"),
    action("orders", "click", {
      locator: { by: "role", role: "link", name: "Orders", exact: true },
    }),
    assertion("orders_loaded", { locator: locator("order-count") }, "visible"),
    action("reload_orders", "navigate", { path: "/orders" }),
    assertion("persisted_order", { locator: locator("order-count") }, "textEquals", "1"),
  ]);
}

// All execution still targets the real shop. The boundary gate only holds a response so kill/pinning races are deterministic.
export interface ControlledShop {
  shop: { url: string; dbPath: string; close(): Promise<void> };
  url: string;
  hits(): number;
  seenSecrets(): string[];
  hold(): void;
  release(): void;
  close(): Promise<void>;
}
export async function controlledShop(mutant = "healthy"): Promise<ControlledShop> {
  const shop = await startShop({ port: 0, mutant });
  let hits = 0;
  let blocked = false;
  const pending = new Set<() => void>();
  const secrets: string[] = [];
  const server: Server = createServer((incoming, outgoing) => {
    hits++;
    if (incoming.headers["x-canary"]) secrets.push(String(incoming.headers["x-canary"]));
    const forward = () => {
      if (outgoing.destroyed) return;
      const upstream = request(
        new URL(incoming.url ?? "/", shop.url),
        { method: incoming.method, headers: incoming.headers },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on("error", () => {
        outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(upstream);
    };
    if (blocked) {
      pending.add(forward);
      outgoing.once("close", () => pending.delete(forward));
    } else forward();
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing controlled shop address");
  const release = () => {
    blocked = false;
    for (const forward of pending) forward();
    pending.clear();
  };
  return {
    shop,
    url: `http://127.0.0.1:${address.port}`,
    hits: () => hits,
    seenSecrets: () => [...secrets],
    hold: () => {
      blocked = true;
    },
    release,
    close: async () => {
      release();
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      await shop.close();
    },
  };
}
