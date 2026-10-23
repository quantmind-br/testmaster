import { createServer as createHttpServer, type Server } from "node:http";
import { expect } from "vitest";
import { eventually, object, text } from "./harness.js";
import type { ServerStack, Spawned } from "./server-stack.js";

interface Held {
  readonly path: string;
  readonly openedAt: number;
  closedAt: number | null;
}

interface Seen {
  readonly host: string;
  readonly path: string;
}

/**
 * The developer's loopback app. `/health` answers the marker; `/hold-*` holds every request open
 * and `/once-*` holds only its first, trickling a byte every 2 s so only the end of the stream
 * closes it; `/to-admin` redirects to the machine's admin API, which the tunnel must not reach.
 */
export async function startLaptop(marker: string, adminOrigin?: string) {
  const held: Held[] = [];
  const seen: Seen[] = [];
  const hits = new Map<string, number>();
  const server: Server = createHttpServer((incoming, outgoing) => {
    const path = new URL(incoming.url ?? "/", "http://laptop").pathname;
    const count = (hits.get(path) ?? 0) + 1;
    hits.set(path, count);
    seen.push({ host: incoming.headers.host ?? "", path });
    incoming.resume();
    if (path === "/to-admin" && adminOrigin) {
      outgoing.writeHead(302, { location: `${adminOrigin}/` });
      outgoing.end();
      return;
    }
    if (path.startsWith("/hold-") || (path.startsWith("/once-") && count === 1)) {
      const entry: Held = { path, openedAt: Date.now(), closedAt: null };
      held.push(entry);
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.write("{");
      // A real trickle against the real egress proxy's idle timer; fake timers cannot reach it.
      const trickle = setInterval(() => outgoing.write(" "), 2_000);
      // The agent closing the connection ends it: its FIN, or the reset a later trickle meets.
      const closed = () => {
        if (entry.closedAt !== null) return;
        clearInterval(trickle);
        entry.closedAt = Date.now();
      };
      outgoing.once("close", closed);
      incoming.socket.once("end", closed);
      return;
    }
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ status: "ok", marker }));
  });
  // Every TCP connection the app accepts: through the tunnel, each is one agent stream.
  let connections = 0;
  server.on("connection", () => connections++);
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("laptop has no port");
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    held,
    seen,
    hits: (path: string) => hits.get(path) ?? 0,
    connections: () => connections,
    heldAt: (path: string) => held.filter((entry) => entry.path === path),
    async close() {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

export type Laptop = Awaited<ReturnType<typeof startLaptop>>;

export interface Line {
  readonly event: string;
  readonly tunnelId?: string;
  readonly workerId?: string;
  readonly attemptId?: string;
  readonly reason?: string;
}

/** The JSON lifecycle lines a CLI process wrote to stderr. */
export function lines(process: Spawned): Line[] {
  return process
    .stderr()
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Line];
      } catch {
        return [];
      }
    });
}

export const lineOf = (process: Spawned, event: string) =>
  lines(process).find((line) => line.event === event);

/** `tunnel start` of the built CLI, in the foreground until it ends. */
export async function startCliAgent(
  stack: Pick<ServerStack, "spawn" | "baseUrl">,
  options: {
    projectId: string;
    token: string;
    caFile: string;
    target: string;
    extra?: string[];
    endpoint?: string;
  },
): Promise<{ agent: Spawned; tunnelId: string }> {
  const agent = stack.spawn(
    [
      "--endpoint",
      options.endpoint ?? stack.baseUrl,
      "tunnel",
      "start",
      "--project",
      options.projectId,
      "--target",
      options.target,
      ...(options.extra ?? []),
    ],
    { TESTMASTER_API_KEY: options.token, NODE_EXTRA_CA_CERTS: options.caFile },
  );
  await eventually(
    async () => lines(agent),
    (seen) => seen.some((line) => line.event === "tunnel.ready") || agent.child.exitCode !== null,
    60_000,
  );
  if (agent.child.exitCode !== null)
    throw new Error(`tunnel start exited: ${agent.stderr()} ${agent.stdout()}`);
  return { agent, tunnelId: text(lineOf(agent, "tunnel.created")?.tunnelId) };
}

/**
 * Admits a Run through a tunnel over REST as the workspace owner, binding the approval the
 * refusal names first (SEC-039).
 */
export async function admitThroughTunnel(
  stack: Pick<ServerStack, "ownerClient">,
  workspace: number,
  request: { testId: string; environmentId: string; tunnelId: string },
): Promise<string> {
  const client = stack.ownerClient(workspace);
  const body = { ...request, mode: "replay", healingPolicy: "off" };
  const refused = await client.mutate("POST", "/v1/runs", body);
  expect(refused.status, refused.text).toBeGreaterThanOrEqual(400);
  const details = object(object(object(refused.json()).error).details);
  expect(details.reasonCode).toBe("approval_required");
  const binding = object(details.binding);
  expect(binding.actionSet).toEqual([`tunnel:${request.tunnelId}`]);
  const approved = await client.mutate("POST", "/v1/approvals", {
    revisionHash: binding.revisionHash,
    environmentRevisionId: binding.environmentRevisionId,
    originSet: binding.originSet,
    actionSet: binding.actionSet,
    policyHash: binding.policyHash,
    reason: "Run against the developer's loopback app through the tunnel",
  });
  if (approved.status >= 300) throw new Error(`approval: ${approved.status} ${approved.text}`);
  const admitted = await client.mutate("POST", "/v1/runs", body);
  if (admitted.status >= 300) throw new Error(`admission: ${admitted.status} ${admitted.text}`);
  return text(object(object(admitted.json()).data).runId);
}
