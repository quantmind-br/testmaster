import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type Application, authenticateBearer } from "@testmaster/application";
import { routeCatalog } from "@testmaster/contracts";
import type { ServerStack, StackWorkspace } from "./server-stack.js";

const run = promisify(execFile);

/** Creates a project as the workspace owner through the public API. */
export async function createProject(
  stack: ServerStack,
  name: string,
  workspace = 0,
): Promise<string> {
  const created = await stack.ownerClient(workspace).mutate("POST", "/v1/projects", { name });
  if (created.status !== 201)
    throw new Error(`project creation failed: ${created.status} ${created.text}`);
  return created.json<{ data: { id: string } }>().data.id;
}

export async function createEnvironment(
  stack: ServerStack,
  projectId: string,
  options: {
    name: string;
    baseUrl: string;
    networkProfile: "public" | "private" | "local-loopback";
  },
): Promise<string> {
  const created = await stack
    .ownerClient()
    .mutate("POST", `/v1/projects/${projectId}/environments`, options);
  if (created.status !== 201)
    throw new Error(`environment creation failed: ${created.status} ${created.text}`);
  return created.json<{ data: { id: string } }>().data.id;
}

export async function createSecret(
  stack: ServerStack,
  options: { name: string; value: string; allowedOrigins: string[] },
): Promise<string> {
  const created = await stack.ownerClient().mutate("POST", "/v1/secrets", options);
  if (created.status !== 200 && created.status !== 201)
    throw new Error(`secret creation failed: ${created.status} ${created.text}`);
  return created.json<{ data: { id: string } }>().data.id;
}

/** Writes files and commits them; returns the commit SHA. */
export async function commitFiles(
  directory: string,
  files: Record<string, string>,
  message: string,
): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    const target = join(directory, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const git = (...args: string[]) =>
    run("git", ["-c", "user.name=Journey", "-c", "user.email=journey@example.test", ...args], {
      cwd: directory,
    });
  await git("add", "--all");
  await git("commit", "--quiet", "--message", message);
  return (await git("rev-parse", "HEAD")).stdout.trim();
}

export async function initGitRepository(directory: string): Promise<void> {
  await run("git", ["init", "--quiet", "--initial-branch", "main"], { cwd: directory });
}

const catalogMatchers = routeCatalog.map((route) => ({
  method: route.method,
  pattern: new RegExp(`^/v1${route.path.replace(/\{[^}]+\}/g, "[^/]+")}$`),
}));

/** Pages and assets the portal itself serves; anything else under another prefix is private. */
const portalPath = /^\/(?:assets\/|projects\/|onboarding|login|recover|$)/;
/**
 * Requests that are neither the portal's own static assets/pages nor a catalog `/v1` route
 * (`METHOD path[?query]`). The portal must have no private endpoint (M4-04).
 */
export function privateEndpointCalls(requests: readonly string[]): string[] {
  return requests.filter((request) => {
    const [method = "", target = ""] = request.split(" ");
    const path = target.split("?")[0] ?? "";
    if (!path.startsWith("/v1/")) return !(method === "GET" && portalPath.test(path));
    return !catalogMatchers.some((entry) => entry.method === method && entry.pattern.test(path));
  });
}

export interface CountingTarget {
  readonly url: string;
  readonly port: number;
  hits(): number;
  close(): Promise<void>;
}

/** A local HTTP target that records how often it was contacted. */
export async function startCountingTarget(status = 200): Promise<CountingTarget> {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.statusCode = status;
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("target has no address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    hits: () => hits,
    close: () => closeServer(server),
  };
}

/** A port that nothing listens on. */
export async function closedPort(): Promise<number> {
  const target = await startCountingTarget();
  const { port } = target;
  await target.close();
  return port;
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

export interface FakeModel {
  readonly baseUrl: string;
  /** Output of the next normalization calls; reconciliation reuses its `conflicts`. */
  setOutput(value: unknown): void;
  calls(): number;
  close(): Promise<void>;
}

/** Local OpenAI-compatible provider: no paid model call is ever made. */
export async function startFakeModel(): Promise<FakeModel> {
  let output: unknown = { requirements: [], conflicts: [], openQuestions: [] };
  let calls = 0;
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls += 1;
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as {
      messages: { content: string }[];
    };
    const reconciliation = payload.messages.some((message) =>
      message.content.includes("Compare the normalized statements"),
    );
    const conflicts =
      output && typeof output === "object" && "conflicts" in output ? output.conflicts : [];
    response.end(
      JSON.stringify({
        model: "model",
        choices: [
          {
            message: {
              content: JSON.stringify(reconciliation ? { conflicts, openQuestions: [] } : output),
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 10,
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("model has no address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    setOutput(value) {
      output = value;
    },
    calls: () => calls,
    close: () => closeServer(server),
  };
}

/** Model profile and user policy for a stack whose only provider is the fake one. */
export function fakeModelSettings(baseUrl: string) {
  return {
    profiles: {
      defaultProfile: "test",
      profiles: {
        test: {
          modelProviders: [
            {
              id: "fake",
              kind: "openai-compatible",
              baseUrl,
              apiKeyEnv: "FAKE_KEY",
              models: [
                {
                  id: "model",
                  capabilities: { structuredJson: true, toolCalls: true, maxOutputTokens: 1024 },
                },
              ],
            },
          ],
        },
      },
    },
    userPolicy: { allowUpload: true, allowedModelProviders: ["fake"] },
    extraEnv: { FAKE_KEY: "fake-key" },
  };
}

/**
 * An in-process Application bound to the workspace owner, for seeding data the portal then shows.
 * It shares the stack's database and `home`, exactly like the CLI of that owner would.
 */
export async function asOwner(stack: ServerStack, workspace = 0): Promise<Application> {
  const owner = (stack.workspaces[workspace] as StackWorkspace).owner;
  const token = await stack.issueToken(owner.principalId, ["R", "W", "X", "A"], [], workspace);
  const scope = await stack.scope();
  return scope.forIdentity(authenticateBearer(scope, token));
}
