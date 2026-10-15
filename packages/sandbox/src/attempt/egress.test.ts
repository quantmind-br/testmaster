import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkPolicy } from "@testmaster/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { Resolver } from "../egress/policy.js";
import { EgressProxy } from "../egress/proxy.js";
import { attemptEgressPolicy } from "./egress.js";

const resources: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
});

const policy = (
  networkProfile: NetworkPolicy["networkProfile"],
  baseUrl: string,
  additionalOrigins: string[],
  extraAllowed: string[] = [],
): NetworkPolicy => ({
  allowedOrigins: [baseUrl, ...additionalOrigins, ...extraAllowed],
  ...(additionalOrigins.length ? { additionalOrigins } : {}),
  networkProfile,
  baseUrl,
});
const never: Resolver = async () => {
  throw new Error("resolver must not be called");
};
const answers =
  (...addresses: string[]): Resolver =>
  async () =>
    addresses;

describe("additional origins in the attempt egress policy", () => {
  it("admits a loopback additional origin on local-loopback at its exact port only", async () => {
    const egress = attemptEgressPolicy(
      policy(
        "local-loopback",
        "http://127.0.0.1:3000",
        ["http://127.0.0.1:9000"],
        ["http://127.0.0.1:9001"],
      ),
    );
    const allowed = await egress.authorize("http://127.0.0.1:9000/img.png", never);
    expect(allowed).toMatchObject({ pinnedIp: "127.0.0.1", port: 9000 });
    // Same host, another port: not an approved additional origin.
    await expect(egress.authorize("http://127.0.0.1:9002/", never)).rejects.toThrow(
      "origin_denied",
    );
    // Allowlisted but neither the base nor an additional origin: the loopback is not exempted.
    await expect(egress.authorize("http://127.0.0.1:9001/", never)).rejects.toThrow(
      "address_denied:loopback",
    );
    // Base target unchanged.
    expect(await egress.authorize("http://127.0.0.1:3000/", never)).toMatchObject({
      pinnedIp: "127.0.0.1",
      port: 3000,
    });
  });

  it("pins a localhost additional origin to the host loopback without DNS", async () => {
    const egress = attemptEgressPolicy(
      policy("local-loopback", "http://localhost:3000", ["http://localhost:9000"]),
    );
    expect(await egress.authorize("http://localhost:9000/", never)).toMatchObject({
      pinnedIp: "127.0.0.1",
      port: 9000,
    });
    expect(await egress.authorize("http://localhost:3000/", never)).toMatchObject({
      pinnedIp: "127.0.0.1",
      port: 3000,
    });
    await expect(egress.authorize("http://localhost:9001/", never)).rejects.toThrow(
      "origin_denied",
    );
  });

  it("admits a name that resolves to loopback on local-loopback and keeps the rebinding checks", async () => {
    const egress = attemptEgressPolicy(
      policy("local-loopback", "http://127.0.0.1:3000", ["http://cdn.dev.test:9000"]),
    );
    expect(await egress.authorize("http://cdn.dev.test:9000/", answers("127.0.0.1"))).toMatchObject(
      { pinnedIp: "127.0.0.1", port: 9000 },
    );
    for (const [answer, reason] of [
      [["10.0.0.5"], "address_denied:private"],
      [["169.254.169.254"], "address_denied:metadata"],
      [["127.0.0.1", "10.0.0.5"], "address_denied:private"],
      [["127.0.0.1", "169.254.169.254"], "address_denied:metadata"],
    ] as const)
      await expect(
        egress.authorize("http://cdn.dev.test:9000/", answers(...answer)),
      ).rejects.toThrow(reason);
  });

  it("admits a private literal or name on the private profile at its exact port only", async () => {
    const egress = attemptEgressPolicy(
      policy(
        "private",
        "http://10.0.0.7:3000",
        ["http://10.0.0.5:9000", "http://assets.corp.test:8080"],
        ["http://10.0.0.5:9001"],
      ),
    );
    expect(await egress.authorize("http://10.0.0.5:9000/", never)).toMatchObject({
      pinnedIp: "10.0.0.5",
      port: 9000,
    });
    expect(
      await egress.authorize("http://assets.corp.test:8080/", answers("192.168.1.20")),
    ).toMatchObject({ pinnedIp: "192.168.1.20", port: 8080 });
    await expect(egress.authorize("http://10.0.0.5:9001/", never)).rejects.toThrow(
      "address_denied:private",
    );
    await expect(egress.authorize("http://10.0.0.5:9002/", never)).rejects.toThrow("origin_denied");
    // The private profile does not reach loopback or metadata through a name.
    await expect(
      egress.authorize("http://assets.corp.test:8080/", answers("127.0.0.1")),
    ).rejects.toThrow("address_denied:loopback");
    await expect(
      egress.authorize("http://assets.corp.test:8080/", answers("169.254.169.254")),
    ).rejects.toThrow("address_denied:metadata");
  });

  it("admits a private base URL on the private profile at its exact port only", async () => {
    const egress = attemptEgressPolicy(
      policy("private", "http://10.0.0.7:3000", [], ["http://10.0.0.7:3001"]),
    );
    expect(await egress.authorize("http://10.0.0.7:3000/login", never)).toMatchObject({
      pinnedIp: "10.0.0.7",
      port: 3000,
    });
    // Same host, allowlisted but another port: not the base target, so no exception.
    await expect(egress.authorize("http://10.0.0.7:3001/", never)).rejects.toThrow(
      "address_denied:private",
    );
    // Same host, not allowlisted at all.
    await expect(egress.authorize("http://10.0.0.7:3002/", never)).rejects.toThrow("origin_denied");
    // Another private host on the base port.
    await expect(egress.authorize("http://10.0.0.8:3000/", never)).rejects.toThrow("origin_denied");
  });

  it("admits a base host name that resolves to a private address and refuses any other answer", async () => {
    const egress = attemptEgressPolicy(
      policy("private", "http://app.corp.test:3000", [], ["http://app.corp.test:3001"]),
    );
    expect(
      await egress.authorize("http://app.corp.test:3000/", answers("192.168.1.20")),
    ).toMatchObject({ pinnedIp: "192.168.1.20", port: 3000 });
    await expect(
      egress.authorize("http://app.corp.test:3001/", answers("192.168.1.20")),
    ).rejects.toThrow("address_denied:private");
    for (const [answer, reason] of [
      [["127.0.0.1"], "address_denied:loopback"],
      [["169.254.169.254"], "address_denied:metadata"],
      [["10.0.0.7", "127.0.0.1"], "address_denied:loopback"],
      [["10.0.0.7", "169.254.169.254"], "address_denied:metadata"],
    ] as const)
      await expect(
        egress.authorize("http://app.corp.test:3000/", answers(...answer)),
      ).rejects.toThrow(reason);
  });

  it("does not widen a loopback or metadata base URL on the private profile", async () => {
    const loopback = attemptEgressPolicy(policy("private", "http://127.0.0.1:3000", []));
    await expect(loopback.authorize("http://127.0.0.1:3000/", never)).rejects.toThrow(
      "address_denied:loopback",
    );
    const metadata = attemptEgressPolicy(policy("private", "http://169.254.169.254", []));
    await expect(metadata.authorize("http://169.254.169.254/", never)).rejects.toThrow(
      "address_denied:metadata",
    );
  });

  it("keeps refusing a private base URL on the public profile", async () => {
    const literal = attemptEgressPolicy(policy("public", "http://10.0.0.7:3000", []));
    await expect(literal.authorize("http://10.0.0.7:3000/", never)).rejects.toThrow(
      "address_denied:private",
    );
    const named = attemptEgressPolicy(policy("public", "http://app.corp.test:3000", []));
    await expect(
      named.authorize("http://app.corp.test:3000/", answers("10.0.0.7")),
    ).rejects.toThrow("address_denied:private");
  });

  it("keeps refusing private and loopback addresses on the public profile", async () => {
    const egress = attemptEgressPolicy(
      policy("public", "https://app.example.test", [
        "http://10.0.0.5:9000",
        "http://127.0.0.1:9000",
        "http://localhost:9000",
        "http://assets.example.test:8080",
      ]),
    );
    await expect(egress.authorize("http://10.0.0.5:9000/", never)).rejects.toThrow(
      "address_denied:private",
    );
    await expect(egress.authorize("http://127.0.0.1:9000/", never)).rejects.toThrow(
      "address_denied:loopback",
    );
    await expect(egress.authorize("http://localhost:9000/", answers("127.0.0.1"))).rejects.toThrow(
      "address_denied:loopback",
    );
    await expect(
      egress.authorize("http://assets.example.test:8080/", answers("10.0.0.5")),
    ).rejects.toThrow("address_denied:private");
    // A public answer for an approved additional origin still connects.
    expect(
      await egress.authorize("http://assets.example.test:8080/", answers("93.184.216.34")),
    ).toMatchObject({ pinnedIp: "93.184.216.34" });
    expect(
      await egress.authorize("https://app.example.test/", answers("93.184.216.34")),
    ).toMatchObject({ pinnedIp: "93.184.216.34" });
  });

  it("never admits an additional origin that is not on the allowlist or leaves the profile ranges", async () => {
    const stray = attemptEgressPolicy({
      allowedOrigins: ["http://127.0.0.1:3000"],
      additionalOrigins: ["http://127.0.0.1:9000"],
      networkProfile: "local-loopback",
      baseUrl: "http://127.0.0.1:3000",
    });
    await expect(stray.authorize("http://127.0.0.1:9000/", never)).rejects.toThrow("origin_denied");
    const outside = attemptEgressPolicy(
      policy("local-loopback", "http://127.0.0.1:3000", ["http://10.0.0.5:9000"]),
    );
    await expect(outside.authorize("http://10.0.0.5:9000/", never)).rejects.toThrow(
      "address_denied:private",
    );
  });
});

async function raw(socketPath: string, message: string): Promise<string> {
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
async function upstream(): Promise<{ port: number; requests: () => number }> {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.writeHead(200, { connection: "close" });
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  resources.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  return { port: address.port, requests: () => requests };
}

it("forwards through the proxy to an approved loopback additional origin only", async () => {
  const base = await upstream();
  const cdn = await upstream();
  const other = await upstream();
  const baseUrl = `http://127.0.0.1:${base.port}`;
  const cdnUrl = `http://127.0.0.1:${cdn.port}`;
  const directory = await mkdtemp(join(tmpdir(), "tm-attempt-egress-"));
  resources.push(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "egress.sock");
  const proxy = new EgressProxy({
    socketPath,
    policy: attemptEgressPolicy(
      policy("local-loopback", baseUrl, [cdnUrl], [`http://127.0.0.1:${other.port}`]),
    ),
  });
  await proxy.listen();
  resources.push(() => proxy.close());
  const get = (url: string) =>
    raw(
      socketPath,
      `GET ${url}/ HTTP/1.1\r\nHost: ${new URL(url).host}\r\nConnection: close\r\n\r\n`,
    );
  expect(await get(baseUrl)).toContain("200");
  expect(await get(cdnUrl)).toContain("200");
  // Listed in allowedOrigins but not an additional origin, and an unlisted port.
  expect(await get(`http://127.0.0.1:${other.port}`)).toContain("403");
  expect(await get(`http://127.0.0.1:${other.port + 1}`)).toContain("403");
  expect([base.requests(), cdn.requests(), other.requests()]).toEqual([1, 1, 0]);
});

it("refuses a private additional origin through the proxy on the public profile", async () => {
  const cdn = await upstream();
  const cdnUrl = `http://127.0.0.1:${cdn.port}`;
  const directory = await mkdtemp(join(tmpdir(), "tm-attempt-egress-"));
  resources.push(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "egress.sock");
  const proxy = new EgressProxy({
    socketPath,
    policy: attemptEgressPolicy(policy("public", "https://app.example.test", [cdnUrl])),
  });
  await proxy.listen();
  resources.push(() => proxy.close());
  expect(
    await raw(
      socketPath,
      `GET ${cdnUrl}/ HTTP/1.1\r\nHost: 127.0.0.1:${cdn.port}\r\nConnection: close\r\n\r\n`,
    ),
  ).toContain("403");
  expect(cdn.requests()).toBe(0);
});
