import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { EgressPolicy, type NetworkPolicy, type Resolver } from "./policy.js";
import { EgressProxy } from "./proxy.js";

const resources: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
});
const config = (origins: string[]): NetworkPolicy => ({
  defaultAction: "deny",
  allowedOrigins: origins,
  privateTargets: [],
  allowedProtocols: ["http", "https"],
  allowRedirects: true,
  maxRedirects: 10,
  allowInsecureTls: false,
});
async function setup(policy: EgressPolicy, resolver?: Resolver, maxLogBytes?: number) {
  const directory = await mkdtemp(join(tmpdir(), "tm-proxy-"));
  resources.push(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "egress.sock");
  const logPath = join(directory, "egress.ndjson");
  const proxy = new EgressProxy({
    socketPath,
    policy,
    logPath,
    ...(resolver ? { resolver } : {}),
    ...(maxLogBytes ? { maxLogBytes } : {}),
  });
  await proxy.listen();
  resources.push(() => proxy.close());
  return { proxy, socketPath, logPath };
}
async function raw(socketPath: string, message: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(socketPath);
    const chunks: Buffer[] = [];
    socket.setTimeout(2000, () => socket.destroy(new Error("test_timeout")));
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString()));
    socket.on("connect", () => socket.write(message));
  });
}
async function target() {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.writeHead(302, { location: "http://169.254.169.254/latest", connection: "close" });
    response.end("safe");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  resources.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  return { port: address.port, requests: () => requests };
}
it("pins vetted DNS, rechecks subsequent sockets and refuses mixed A/AAAA", async () => {
  const upstream = await target();
  const url = `http://fixture.test:${upstream.port}`;
  const policy = config([url]);
  policy.privateTargets = [{ hostname: "fixture.test", cidr: "127.0.0.1/32", port: upstream.port }];
  let call = 0;
  const proxy = await setup(new EgressPolicy(policy), async () =>
    ++call === 1 ? ["127.0.0.1"] : ["127.0.0.1", "169.254.169.254"],
  );
  expect(
    await raw(
      proxy.socketPath,
      `GET ${url}/?secret=canary HTTP/1.1\r\nHost: fixture.test:${upstream.port}\r\nProxy-Connection: keep-alive\r\nConnection: close\r\n\r\n`,
    ),
  ).toContain("302");
  expect(
    await raw(
      proxy.socketPath,
      `GET ${url}/ HTTP/1.1\r\nHost: fixture.test:${upstream.port}\r\nConnection: close\r\n\r\n`,
    ),
  ).toContain("403");
  expect(call).toBe(2);
  expect(upstream.requests()).toBe(1);
  await proxy.proxy.close();
  resources.pop();
  const log = await readFile(proxy.logPath, "utf8");
  expect(log).not.toContain("canary");
  expect(log).toContain('"pinnedIp":"127.0.0.1"');
});
it("re-authorizes redirect hops and denies metadata", async () => {
  const upstream = await target();
  const url = `http://fixture.test:${upstream.port}`;
  const { socketPath } = await setup(
    new EgressPolicy(config([url]), {
      networkProfile: "local-loopback",
      baseUrl: url,
      host: "127.0.0.1",
      port: upstream.port,
    }),
  );
  expect(
    await raw(
      socketPath,
      `GET ${url}/ HTTP/1.1\r\nHost: fixture.test:${upstream.port}\r\nConnection: close\r\n\r\n`,
    ),
  ).toContain("http://169.254.169.254/latest");
  expect(
    await raw(
      socketPath,
      "GET http://169.254.169.254/latest HTTP/1.1\r\nHost: 169.254.169.254\r\nConnection: close\r\n\r\n",
    ),
  ).toContain("403");
  expect(upstream.requests()).toBe(1);
});
it.each([
  "CONNECT forbidden.test:443 HTTP/1.1\r\nHost: forbidden.test:443\r\n\r\n",
  "GET http://allowed.test/ HTTP/1.1\r\nHost: attacker.test\r\n\r\n",
  "GET / HTTP/1.1\r\nHost: allowed.test\r\n\r\n",
  ...[
    "Proxy-Authorization: Basic canary",
    "Proxy-Connection: host",
    "X-Forwarded-Host: attacker.test",
    "Forwarded: host=attacker.test",
    "Via: nested",
    "Connection: host",
  ].map((header) => `GET http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\n${header}\r\n\r\n`),
])("rejects destination overrides/chaining before DNS", async (message) => {
  let dns = 0;
  const { socketPath } = await setup(
    new EgressPolicy(config(["http://allowed.test"])),
    async () => {
      dns++;
      return ["8.8.8.8"];
    },
  );
  expect(await raw(socketPath, message)).toContain("403");
  expect(dns).toBe(0);
});
it("closes live CONNECT tunnels immediately on revocation", async () => {
  const upstream = await target();
  const url = `http://fixture.test:${upstream.port}`;
  const { proxy, socketPath } = await setup(
    new EgressPolicy(config([url]), {
      networkProfile: "local-loopback",
      baseUrl: url,
      host: "127.0.0.1",
      port: upstream.port,
    }),
  );
  const socket = connect(socketPath);
  socket.on("error", () => {});
  await new Promise<void>((resolve) =>
    socket.on("connect", () => {
      socket.write(
        `CONNECT fixture.test:${upstream.port} HTTP/1.1\r\nHost: fixture.test:${upstream.port}\r\n\r\n`,
      );
      resolve();
    }),
  );
  const response = await new Promise<string>((resolve) =>
    socket.once("data", (chunk: Buffer) => resolve(chunk.toString())),
  );
  expect(response).toContain("200");
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await proxy.close();
  resources.pop();
  await closed;
});
it("bounds decision logs without query, header or body leakage", async () => {
  const { proxy, socketPath, logPath } = await setup(new EgressPolicy(config([])), undefined, 160);
  for (let i = 0; i < 8; i++)
    await raw(
      socketPath,
      "GET http://denied.test/?canary=value HTTP/1.1\r\nHost: denied.test\r\n\r\n",
    );
  await proxy.close();
  resources.pop();
  const log = await readFile(logPath);
  expect(log.length).toBeLessThanOrEqual(160);
  expect(proxy.droppedDecisions).toBeGreaterThan(0);
  expect(log.toString()).not.toContain("canary");
});
