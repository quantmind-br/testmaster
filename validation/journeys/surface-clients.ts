import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cli } from "./harness.js";
import type { ServerStack } from "./server-stack.js";
import type { HttpsClient } from "./tls-proxy.js";

/**
 * The two non-browser surfaces of the server profile, driven the way an agent or an operator would
 * drive them: MCP over HTTPS with a bearer token, and the remote-mode CLI with an API key.
 */
export interface McpAnswer {
  readonly status: number;
  readonly result?: {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: { text: string }[];
  };
  readonly error?: { message: string };
  readonly raw: string;
}

function parseEventOrJson(text: string): Omit<McpAnswer, "status" | "raw"> {
  const line = text.split("\n").find((value) => value.startsWith("data:"));
  return JSON.parse(line ? line.slice(5) : text) as Omit<McpAnswer, "status" | "raw">;
}

/** An initialized MCP session: later calls cost one request each, which matters for the actor rate limit. */
export interface McpSession {
  call(tool: string, args: Record<string, unknown>): Promise<McpAnswer>;
}

/** Initialize and notify once; the session then serves any number of `tools/call` requests. */
export async function openMcp(stack: ServerStack, token: string): Promise<McpSession> {
  const client = stack.anonymous();
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/json, text/event-stream",
    origin: stack.baseUrl,
  };
  const initialized = await client.request("POST", "/mcp", {
    headers,
    cookies: false,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "journey", version: "1" },
      },
    },
  });
  if (initialized.status !== 200) {
    const refused: McpAnswer = {
      status: initialized.status,
      raw: initialized.text,
      error: { message: initialized.text },
    };
    return { call: async () => refused };
  }
  const sessionHeaders = {
    ...headers,
    "mcp-session-id": String(initialized.headers["mcp-session-id"]),
    "mcp-protocol-version": "2025-06-18",
  };
  await client.request("POST", "/mcp", {
    headers: sessionHeaders,
    cookies: false,
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  let nextId = 2;
  return {
    call: async (tool, args) => {
      const called = await client.request("POST", "/mcp", {
        headers: sessionHeaders,
        cookies: false,
        body: {
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/call",
          params: { name: tool, arguments: args },
        },
      });
      return { status: called.status, ...parseEventOrJson(called.text), raw: called.text };
    },
  };
}

/** One MCP session per call: initialize, notify, then `tools/call`. */
export async function mcpCall(
  stack: ServerStack,
  token: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<McpAnswer> {
  return (await openMcp(stack, token)).call(tool, args);
}

/** A cookie session of a stack user, with the CSRF token the portal would hold. */
export async function signedInClient(
  stack: ServerStack,
  user: { login: string; password: string },
): Promise<HttpsClient> {
  const client = stack.anonymous();
  const login = await client.request("POST", "/v1/identity/login", {
    body: { principal: user.login, password: user.password },
    headers: { origin: stack.baseUrl, "idempotency-key": randomUUID() },
  });
  if (login.status !== 200) throw new Error(`login for ${user.login} failed: ${login.status}`);
  client.csrfToken = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  return client;
}

export interface CliAnswer<T = unknown> {
  readonly code: number | null;
  readonly document: {
    data?: T;
    error?: { code: string; message: string };
  };
  readonly stderr: string;
}

/** Runs the built CLI in remote mode against the stack, trusting only the stack CA. */
export function remoteCli<T = unknown>(
  stack: ServerStack,
  options: { caFile: string; configHome: string },
  token: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<CliAnswer<T>> {
  const { promise, resolve, reject } = Promise.withResolvers<CliAnswer<T>>();
  const child = spawn(process.execPath, [cli, "--json", "--endpoint", stack.baseUrl, ...args], {
    env: {
      ...process.env,
      TESTMASTER_API_KEY: token,
      NODE_EXTRA_CA_CERTS: options.caFile,
      XDG_CONFIG_HOME: options.configHome,
      ...env,
    },
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
  child.once("error", reject);
  child.once("close", (code) => {
    try {
      resolve({ code, document: JSON.parse(stdout), stderr });
    } catch (error) {
      reject(
        new Error(`CLI printed no JSON (exit ${code}): ${stdout}\n${stderr}`, { cause: error }),
      );
    }
  });
  return promise;
}
