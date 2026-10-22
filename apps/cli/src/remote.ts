import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { TunnelAgent } from "@testmaster/application";
import {
  ContractError,
  type ErrorCode,
  errorRegistry,
  type TunnelOpening,
  type TunnelTarget,
} from "@testmaster/contracts";
import type { Command } from "commander";
import { runListFilter } from "./run-filter.js";
import { type Options, type Result, type Runtime, required, string, strings } from "./runtime.js";

/**
 * Remote CLI mode (M4-01, OPS-027): the same command surface against `/v1`, authenticated with a
 * bearer token. The profile file keeps endpoint metadata only; the token lives in its own 0600
 * file and is never printed. `auth logout` is local and never revokes the server token silently.
 */
export interface StoredProfile {
  endpoint: string;
  tokenFile: string;
  principalId: string;
  workspaceId: string;
  createdAt: string;
}
interface ProfileFile {
  schemaVersion: "1.0.0";
  profiles: Record<string, StoredProfile>;
}
export interface RemoteTarget {
  endpoint: URL;
  profile: string | null;
  token: string;
}

const profileName = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config"), "testmaster");
}
const profilesPath = (env: NodeJS.ProcessEnv) => join(configDirectory(env), "profiles.json");

async function readProfiles(env: NodeJS.ProcessEnv = process.env): Promise<ProfileFile> {
  try {
    const parsed = JSON.parse(await readFile(profilesPath(env), "utf8")) as ProfileFile;
    if (parsed.schemaVersion === "1.0.0" && parsed.profiles && typeof parsed.profiles === "object")
      return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new ContractError("INVALID_ARGUMENT", "Profile file is unreadable", {
        path: profilesPath(env),
      });
  }
  return { schemaVersion: "1.0.0", profiles: {} };
}
async function writePrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** HTTPS everywhere; plain HTTP is accepted only for a loopback server in the local profile. */
export function parseEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ContractError("INVALID_ARGUMENT", "Endpoint must be an absolute URL");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new ContractError("INVALID_ARGUMENT", "Endpoint must not carry credentials or a query");
  if (
    endpoint.protocol !== "https:" &&
    !(endpoint.protocol === "http:" && loopbackHosts.has(endpoint.hostname))
  )
    throw new ContractError("INVALID_ARGUMENT", "Endpoint must use https unless it is loopback", {
      endpoint: endpoint.origin,
    });
  return endpoint;
}

/** Flag wins over environment; an empty value counts as unset. */
export function selection(options: Options, env: NodeJS.ProcessEnv = process.env) {
  return {
    endpoint: string(options, "endpoint") || env.TESTMASTER_ENDPOINT || undefined,
    profile: string(options, "profile") || env.TESTMASTER_PROFILE || undefined,
  };
}

/** The remote endpoint selected by flag, environment or an explicitly named stored profile. */
export async function remoteTarget(
  options: Options,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RemoteTarget | null> {
  const { endpoint: flag, profile: selected } = selection(options, env);
  const files = await readProfiles(env);
  const stored = selected ? files.profiles[selected] : undefined;
  if (!flag && !stored) return null;
  const endpoint = parseEndpoint(flag ?? (stored as StoredProfile).endpoint);
  // A stored profile only supplies its token to the endpoint it was created for.
  const matching =
    stored && parseEndpoint(stored.endpoint).origin === endpoint.origin ? stored : undefined;
  let token = env.TESTMASTER_API_KEY;
  if (!token && matching) {
    try {
      token = (await readFile(join(configDirectory(env), matching.tokenFile), "utf8")).trim();
    } catch {
      token = undefined;
    }
  }
  if (!token)
    throw new ContractError("UNAUTHENTICATED", "No credential for this endpoint", {
      nextActions: [`testmaster auth login --endpoint ${endpoint.origin} --from-env <VAR>`],
    });
  return { endpoint, profile: matching ? (selected ?? null) : null, token };
}

export class RemoteClient {
  constructor(
    private readonly target: RemoteTarget,
    private readonly correlationId: string,
    private readonly signal: AbortSignal,
    private readonly timeoutSeconds = 30,
  ) {}
  /** The server the client calls; a tunnel agent opens its session on the same origin. */
  get endpoint(): URL {
    return this.target.endpoint;
  }
  async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(`/v1${path}`, this.target.endpoint);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        redirect: "error",
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutSeconds * 1000)]),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.target.token}`,
          "x-correlation-id": this.correlationId,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new ContractError("UNAVAILABLE", "Server endpoint is unreachable", {
        endpoint: this.target.endpoint.origin,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const text = await response.text();
    let envelope: { data?: T; error?: { code?: string; message?: string; details?: object } };
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new ContractError("UNAVAILABLE", "Server answered with a non-JSON body", {
        status: response.status,
      });
    }
    if (!response.ok || envelope.error) {
      const code = envelope.error?.code;
      throw new ContractError(
        code && code in errorRegistry ? (code as ErrorCode) : "INTERNAL",
        envelope.error?.message ?? `Server answered ${response.status}`,
        (envelope.error?.details ?? {}) as Record<string, unknown>,
      );
    }
    return envelope.data as T;
  }
  /** Follows signed cursors until the server answers nextCursor null; a failed page fails the call, and an expired cursor restarts the walk once from the first page. */
  async list<T>(path: string): Promise<T[]> {
    const separator = path.includes("?") ? "&" : "?";
    let items: T[] = [];
    let cursor: string | null = null;
    let restarted = false;
    for (;;) {
      try {
        const page: { items: T[]; nextCursor: string | null } = await this.request(
          "GET",
          `${path}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        items.push(...page.items);
        cursor = page.nextCursor;
        if (!cursor) return items;
      } catch (error) {
        const expired = error instanceof ContractError && error.code === "CURSOR_EXPIRED";
        if (!cursor || restarted || !expired) throw error;
        restarted = true;
        items = [];
        cursor = null;
      }
    }
  }
}

type RemoteHandler = (
  client: RemoteClient,
  args: unknown[],
  options: Options,
  rt: Runtime,
) => Promise<Result> | Result;

/** A tunnel target is a literal loopback IP and a port, never a name (SEC-041). */
function tunnelTarget(value: string): TunnelTarget {
  const match = /^(?:(127\.0\.0\.1)|\[(::1)\]):(\d{1,5})$/.exec(value);
  const port = Number(match?.[3]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "--target must be 127.0.0.1:<port> or [::1]:<port>",
      { option: "target" },
    );
  return { address: (match[1] ?? match[2]) as TunnelTarget["address"], port };
}

async function projectOf(client: RemoteClient, options: Options): Promise<string> {
  const explicit = string(options, "project") ?? process.env.TESTMASTER_PROJECT_ID;
  if (explicit) return explicit;
  const projects = await client.list<{ id: string; archivedAt?: string | null }>("/projects");
  const project = projects.find((item) => !item.archivedAt);
  if (!project) throw new ContractError("PRECONDITION_REQUIRED", "Select a project with --project");
  return project.id;
}

/** The token selects the workspace of a remote endpoint; host-only selectors do not apply. */
function assertRemoteOps(command: string, options: Options): void {
  if (options.workspace !== undefined) throw unavailableRemote(`${command} --workspace`);
  if (options.mode === "server") throw unavailableRemote(`${command} --mode server`);
}

const admission =
  (action: "pause" | "drain" | "resume"): RemoteHandler =>
  async (client, _args, options) => {
    assertRemoteOps(`ops ${action}`, options);
    return {
      data: await client.request("POST", "/operations/admission", {
        action,
        reason: required(options, "reason"),
      }),
    };
  };

const workerClaims =
  (action: "pause" | "resume"): RemoteHandler =>
  async (client, _args, options) => {
    assertRemoteOps(`ops workers ${action}`, options);
    return {
      data: await client.request("POST", "/operations/worker-claims", {
        action,
        reason: required(options, "reason"),
      }),
    };
  };

/** Commands that run against `/v1`; every other command fails closed with CAPABILITY_UNAVAILABLE. */
export const remoteHandlers: Readonly<Record<string, RemoteHandler>> = {
  "project list": async (client) => ({ data: await client.list("/projects") }),
  "run list": async (client, _args, options) => {
    for (const flag of ["limit", "cursor"] as const)
      if (options[flag] !== undefined) throw unavailableRemote(`run list --${flag}`);
    const query = new URLSearchParams(Object.entries(runListFilter(options)));
    return { data: await client.list(query.size ? `/runs?${query}` : "/runs") };
  },
  "run get": async (client, args) => ({
    data: await client.request("GET", `/runs/${encodeURIComponent(String(args[0]))}`),
  }),
  "run cancel": async (client, args) => ({
    data: await client.request("POST", `/runs/${encodeURIComponent(String(args[0]))}/cancel`, {}),
  }),
  "test list": async (client, _args, options) => {
    for (const flag of ["status", "limit", "cursor"] as const)
      if (options[flag] !== undefined) throw unavailableRemote(`test list --${flag}`);
    const tags = strings(options, "tag");
    const priorities = strings(options, "priority");
    if (tags.length > 1) throw unavailableRemote("test list --tag (repeated)");
    if (priorities.length > 1) throw unavailableRemote("test list --priority (repeated)");
    const query = new URLSearchParams();
    for (const [flag, value] of [
      ["tag", tags[0]],
      ["priority", priorities[0]],
    ] as const) {
      // The server treats an empty filter as absent; refuse it rather than list every test.
      if (value === "") throw new ContractError("INVALID_ARGUMENT", `--${flag} must not be empty`);
      if (value !== undefined) query.set(flag, value);
    }
    const path = `/projects/${await projectOf(client, options)}/tests`;
    return { data: await client.list(query.size ? `${path}?${query}` : path) };
  },
  "test get": async (client, args) => ({
    data: await client.request("GET", `/tests/${encodeURIComponent(String(args[0]))}`),
  }),
  "test run": async (client, args, options) => {
    const ids = Array.isArray(args[0]) ? (args[0] as string[]) : [];
    // Defaults are accepted as such; any option the remote route cannot honour fails closed.
    const defaults: Record<string, unknown> = { mode: "replay", heal: "off" };
    const global = new Set([
      "endpoint",
      "profile",
      "json",
      "output",
      "color",
      "verbose",
      "cwd",
      "config",
      "project",
      "requestTimeout",
      "env",
      "tunnel",
    ]);
    const unsupported = Object.keys(options).filter(
      (key) =>
        !global.has(key) &&
        options[key] !== undefined &&
        options[key] !== false &&
        options[key] !== defaults[key],
    );
    if (ids.length !== 1 || unsupported.length)
      throw unavailableRemote(
        unsupported.length ? `test run --${unsupported[0]}` : "test run with several ids",
      );
    const tunnelId = string(options, "tunnel");
    return {
      data: await client.request("POST", "/runs", {
        testId: ids[0],
        environmentId: required(options, "env"),
        ...(tunnelId ? { tunnelId } : {}),
      }),
    };
  },
  /**
   * Creates a tunnel and serves it in the foreground until it ends or the process is stopped
   * (ADR-031). Lifecycle facts go to stderr as JSON lines; the open token is never printed.
   */
  "tunnel start": async (client, _args, options, rt) => {
    const target = tunnelTarget(required(options, "target"));
    const ttl = options.ttl === undefined ? undefined : Number(options.ttl);
    if (ttl !== undefined && (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600))
      throw new ContractError("INVALID_ARGUMENT", "--ttl must be 60 to 3600 seconds");
    const opening = await client.request<TunnelOpening>("POST", "/tunnels", {
      projectId: await projectOf(client, options),
      target,
      ...(ttl === undefined ? {} : { ttlSeconds: ttl }),
    });
    const tunnelId = opening.tunnel.id;
    const log = (entry: Record<string, unknown>) => rt.stderr.write(`${JSON.stringify(entry)}\n`);
    log({ event: "tunnel.created", tunnelId, expiresAt: opening.tunnel.expiresAt });
    const { reason } = await new TunnelAgent({
      endpoint: client.endpoint.href,
      tunnelId,
      openToken: opening.openToken,
      target,
      expiresAt: opening.tunnel.expiresAt,
      log,
    }).run(rt.controller.signal);
    return { data: { tunnelId, reason } };
  },
  "tunnel list": async (client) => ({ data: await client.list("/tunnels") }),
  "tunnel status": async (client, args) => ({
    data: await client.request("GET", `/tunnels/${encodeURIComponent(String(args[0]))}`),
  }),
  "tunnel stop": async (client, args) => ({
    data: await client.request("DELETE", `/tunnels/${encodeURIComponent(String(args[0]))}`),
  }),
  "ops status": async (client, _args, options) => {
    assertRemoteOps("ops status", options);
    return { data: await client.request("GET", "/operations/status") };
  },
  "ops pause": admission("pause"),
  "ops drain": admission("drain"),
  "ops resume": admission("resume"),
  "ops workers pause": workerClaims("pause"),
  "ops workers resume": workerClaims("resume"),
};
/** Commands that manage the connection itself and never need a stored credential. */
export const remoteExempt: ReadonlySet<string> = new Set([
  "auth login",
  "auth status",
  "auth logout",
  "whoami",
]);

export function unavailableRemote(command: string): ContractError {
  return new ContractError(
    "CAPABILITY_UNAVAILABLE",
    `Command is not available against a remote endpoint: ${command}`,
    { capability: "remote-cli", command, milestone: "M4" },
  );
}
export function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent)
    names.unshift(current.name());
  return names.join(" ");
}

function profileFor(endpoint: URL, requested: string | undefined): string {
  const name = requested ?? `${endpoint.hostname}-${endpoint.port || "443"}`.toLowerCase();
  if (!profileName.test(name))
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Profile name must match ^[a-z0-9][a-z0-9._-]{0,63}$",
    );
  return name;
}

export function remoteCommands(program: Command, runtime: Runtime): void {
  const auth = program.command("auth").description("Credentials for a TestMaster server");
  runtime.bind(
    auth
      .command("login")
      .description("Store a server token read from an environment variable")
      .requiredOption("--from-env <name>", "Environment variable holding the token"),
    async (rt, _args, options) => {
      const endpointValue = selection(options).endpoint;
      if (!endpointValue)
        throw new ContractError("INVALID_ARGUMENT", "auth login needs --endpoint");
      const endpoint = parseEndpoint(endpointValue);
      const variable = required(options, "fromEnv");
      const token = process.env[variable]?.trim();
      if (!token)
        throw new ContractError("INVALID_ARGUMENT", `Environment variable ${variable} is empty`);
      if (!/^tm_(local|api|op)_[A-Za-z0-9_-]{20,}$/.test(token))
        throw new ContractError("INVALID_ARGUMENT", "The value is not a TestMaster bearer token");
      const client = new RemoteClient(
        { endpoint, profile: null, token },
        rt.requestId,
        rt.controller.signal,
      );
      const me = await client.request<RemoteIdentity>("GET", "/me");
      const name = profileFor(endpoint, string(options, "profile"));
      const tokenFile = join("credentials", `${name}.token`);
      const env = process.env;
      await writePrivate(join(configDirectory(env), tokenFile), `${token}\n`);
      const files = await readProfiles(env);
      files.profiles[name] = {
        endpoint: endpoint.origin,
        tokenFile,
        principalId: me.principal.id,
        workspaceId: me.workspace.id,
        createdAt: new Date().toISOString(),
      };
      await writePrivate(profilesPath(env), `${JSON.stringify(files, null, 2)}\n`);
      return { data: { profile: name, endpoint: endpoint.origin, ...summarize(me) } };
    },
  );
  runtime.bind(auth.command("status"), async (rt, _args, options) => {
    const files = await readProfiles();
    const { profile: selected, endpoint: endpointFlag } = selection(options);
    const entries = Object.entries(files.profiles).filter(
      ([name, profile]) =>
        (!selected || name === selected) &&
        (!endpointFlag ||
          parseEndpoint(profile.endpoint).origin === parseEndpoint(endpointFlag).origin),
    );
    const data = [];
    for (const [name, profile] of entries) {
      let token: string | undefined;
      try {
        token = (await readFile(join(configDirectory(), profile.tokenFile), "utf8")).trim();
      } catch {
        token = undefined;
      }
      if (!token) {
        data.push({
          profile: name,
          endpoint: profile.endpoint,
          authenticated: false,
          reason: "no_credential",
        });
        continue;
      }
      try {
        const me = await new RemoteClient(
          { endpoint: parseEndpoint(profile.endpoint), profile: name, token },
          rt.requestId,
          rt.controller.signal,
        ).request<RemoteIdentity>("GET", "/me");
        data.push({
          profile: name,
          endpoint: profile.endpoint,
          authenticated: true,
          ...summarize(me),
        });
      } catch (error) {
        if (!(error instanceof ContractError) || error.code === "UNAVAILABLE")
          data.push({
            profile: name,
            endpoint: profile.endpoint,
            authenticated: false,
            reason: "unreachable",
          });
        else
          data.push({
            profile: name,
            endpoint: profile.endpoint,
            authenticated: false,
            reason: error.code,
          });
      }
    }
    return { data: { profiles: data } };
  });
  runtime.bind(auth.command("logout"), async (_rt, _args, options) => {
    const files = await readProfiles();
    const { profile: selected, endpoint: endpointFlag } = selection(options);
    const names = Object.entries(files.profiles)
      .filter(
        ([name, profile]) =>
          (selected ? name === selected : Boolean(endpointFlag)) &&
          (!endpointFlag ||
            parseEndpoint(profile.endpoint).origin === parseEndpoint(endpointFlag).origin),
      )
      .map(([name]) => name);
    if (!names.length)
      throw new ContractError(
        "NOT_FOUND",
        "No stored profile matches; name one with --profile or --endpoint",
      );
    for (const name of names) {
      const profile = files.profiles[name] as StoredProfile;
      await rm(join(configDirectory(), profile.tokenFile), { force: true });
      delete files.profiles[name];
    }
    await writePrivate(profilesPath(process.env), `${JSON.stringify(files, null, 2)}\n`);
    return {
      data: {
        loggedOut: names,
        revokedRemotely: false,
        note: "Local credentials were removed. The server token stays valid until it is revoked in the portal or with the tokens API.",
      },
    };
  });
  runtime.bind(program.command("whoami"), async (rt, _args, options) => {
    const target = await remoteTarget(options);
    if (!target) {
      const me = (await rt.app()).me();
      return { data: summarize(me as unknown as RemoteIdentity) };
    }
    const client = new RemoteClient(target, rt.requestId, rt.controller.signal);
    return {
      data: {
        endpoint: target.endpoint.origin,
        ...summarize(await client.request<RemoteIdentity>("GET", "/me")),
      },
    };
  });
}

interface RemoteIdentity {
  principal: { id: string; displayName?: string; kind?: string };
  workspace: { id: string; name?: string };
  membership: { role: string };
  permissions: Record<string, boolean>;
}
function summarize(me: RemoteIdentity) {
  return {
    principalId: me.principal.id,
    displayName: me.principal.displayName ?? null,
    workspaceId: me.workspace.id,
    role: me.membership.role,
    permissions: me.permissions,
  };
}
