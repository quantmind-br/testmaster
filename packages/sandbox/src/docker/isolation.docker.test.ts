import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { EgressPolicy, type NetworkPolicy } from "../egress/policy.js";
import { EgressProxy } from "../egress/proxy.js";
import { readImageLock } from "../images/lock.js";
import { type DockerAttempt, DockerExecutor, dockerCommand } from "./executor.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
interface TestEnvironment {
  directory: string;
  options: DockerAttempt;
  executor: DockerExecutor;
}
async function environment(kind: DockerAttempt["kind"] = "browser") {
  const directory = await mkdtemp(join(tmpdir(), "tm-docker-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const inputDir = join(directory, "input");
  const socketsDir = join(directory, "sockets");
  await mkdir(inputDir, { mode: 0o755 });
  await mkdir(socketsDir, { mode: 0o755 });
  const lock = await readImageLock(resolve("containers/images.lock.json"));
  const options: DockerAttempt = {
    attemptId: `att_${randomUUID()}`,
    runId: `run_${randomUUID()}`,
    kind,
    imageId: lock["testmaster-runner"].imageId,
    entrypoint: ["node", "/opt/testmaster/runner/dist/forwarder/tooling.js"],
    inputDir,
    socketsDir,
    seccompPath: resolve("containers/seccomp_profile.json"),
    attemptTimeoutMs: 60000,
  };
  return { directory, options, executor: new DockerExecutor() };
}
async function runScript(environment: TestEnvironment, code: string) {
  await writeFile(join(environment.options.inputDir, "test.mjs"), code);
  return environment.executor.execute({
    ...environment.options,
    // The M0 verification tooling starts the same mandatory egress forwarder.
    command: ["node", "/run/testmaster/input/test.mjs"],
  });
}
it("doctor starts the hardened image even when its default entrypoint requires a runner session", async () => {
  const context = await environment("http");
  const { entrypoint: _entrypoint, ...probe } = context.options;
  const result = await context.executor.doctor(probe);
  expect(result.available).toBe(true);
  expect(result.diagnostics).toEqual([]);
}, 30000);
it("reaches only the approved loopback app from sandboxed Chromium and undici; blocks raw egress and host access", async () => {
  const context = await environment();
  const target = http.createServer((_request, response) => response.end("approved-fixture"));
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => target.close(() => resolve())));
  const address = target.address();
  if (!address || typeof address === "string") throw new Error("address");
  const url = `http://fixture.test:${address.port}`;
  const network: NetworkPolicy = {
    defaultAction: "deny",
    allowedOrigins: [url],
    privateTargets: [],
    allowedProtocols: ["http", "https"],
    allowRedirects: true,
    maxRedirects: 10,
    allowInsecureTls: false,
  };
  const proxy = new EgressProxy({
    socketPath: join(context.options.socketsDir, "egress.sock"),
    policy: new EgressPolicy(network, {
      networkProfile: "local-loopback",
      baseUrl: url,
      host: "127.0.0.1",
      port: address.port,
    }),
  });
  await proxy.listen();
  cleanups.push(() => proxy.close());
  const code = `
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { createSocket } from 'node:dgram';
import { chromium } from '/opt/testmaster/runner/node_modules/playwright-core/index.mjs';
import { createRequire } from 'node:module';
const { ProxyAgent, request } = createRequire('/opt/testmaster/runner/package.json')('undici');
const proxy = new ProxyAgent('http://127.0.0.1:3128');
const response = await request(${JSON.stringify(url)}, { dispatcher: proxy });
assert.equal(await response.body.text(), 'approved-fixture');
for (const denied of ['http://169.254.169.254/', 'http://192.168.1.1/', 'http://fixture.test:${address.port + 1}/']) {
  const deniedResponse = await request(denied, { dispatcher: proxy, headersTimeout: 3000 }).catch(() => null);
  assert.ok(deniedResponse === null || deniedResponse.statusCode === 403);
  if (deniedResponse) await deniedResponse.body.dump();
}
const browser = await chromium.launch({ chromiumSandbox: true, headless: true, args: ['--proxy-server=http://127.0.0.1:3128', '--proxy-bypass-list=<-loopback>'] });
const page = await browser.newPage();
await page.goto(${JSON.stringify(url)});
assert.equal(await page.locator('body').innerText(), 'approved-fixture');
for (const denied of ['http://169.254.169.254/', 'http://192.168.1.1/', 'http://fixture.test:${address.port + 1}/']) {
  const result = await page.goto(denied).catch(() => null);
  assert.ok(result === null || result.status() === 403);
}
await browser.close(); await proxy.close();
await assert.rejects(access('/var/run/docker.sock'));
await assert.rejects(access(${JSON.stringify(join(context.directory, "host-canary"))}));
await assert.rejects(writeFile('/host-write-test', 'unsafe'));
assert.notEqual(process.getuid(), 0);
assert.match(await readFile('/proc/self/status', 'utf8'), /CapEff:\\s+0000000000000000/);
assert.match(await readFile('/proc/self/status', 'utf8'), /Seccomp:\\s+2/);
const chroot = spawnSync('/usr/sbin/chroot', ['/', '/bin/true'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
assert.notEqual(chroot.status, 0);
assert.match(chroot.stderr, /Operation not permitted/);
for (const host of ['169.254.169.254', '192.168.1.1', '127.0.0.1']) {
  await assert.rejects(new Promise((resolve,reject) => { const socket = connect({host, port: ${address.port}}); socket.setTimeout(2000, () => {socket.destroy();reject(new Error('timeout'))}); socket.once('error',reject); socket.once('connect',() => {socket.destroy();resolve()}); }));
}
await assert.rejects(new Promise((resolve,reject) => {const udp=createSocket('udp4');udp.send(Buffer.from('escape'),53,'8.8.8.8',error=>{udp.close();error?reject(error):resolve()})}));
console.log('isolation-verified');
`;
  await writeFile(join(context.directory, "host-canary"), "unreadable");
  const result = await runScript(context, code);
  expect(result.code).toBe(0);
  expect(result.stdout.toString()).toContain("isolation-verified");
  expect(result.facts.user).toBe("1000:1000");
  expect(result.facts.readOnlyRootfs).toBe(true);
  expect(result.facts.capAdd).toEqual([]);
  expect(result.facts.capDrop).toContain("ALL");
  expect(result.facts.securityOpt.some((value) => value.startsWith("seccomp="))).toBe(true);
  expect(result.facts.memory).toBe(2 * 1024 ** 3);
  expect(result.facts.pidsLimit).toBe(256);
  expect(result.facts.nanoCpus).toBe(2e9);
  expect(result.facts.mounts.every((mount) => !mount.writable)).toBe(true);
}, 90000);
it("enforces the memory envelope under allocation pressure", async () => {
  const context = await environment("http");
  const result = await runScript(
    context,
    `const buffers=[]; for (;;) buffers.push(Buffer.alloc(16 * 1024 * 1024, 1));`,
  );
  expect(result.facts.memory).toBe(512 * 1024 ** 2);
  expect(result.facts.oomKilled).toBe(true);
  expect(result.code).not.toBe(0);
}, 90000);
it("contains process proliferation at the PID envelope", async () => {
  const context = await environment("http");
  const result = await runScript(
    context,
    `import { spawn } from 'node:child_process'; import assert from 'node:assert/strict';
const children=[]; let denied=false;
for(let i=0;i<256;i++) {const child=spawn('/bin/sleep',['60']); children.push(child); const failed=await new Promise(resolve=>{child.once('error',error=>resolve(error.code==='EAGAIN'));child.once('spawn',()=>resolve(false))}); if(failed){denied=true;break}}
for(const child of children) child.kill('SIGKILL'); assert.ok(denied); console.log('pids-contained');`,
  );
  expect(result.code).toBe(0);
  expect(result.stdout.toString()).toContain("pids-contained");
  expect(result.facts.pidsLimit).toBe(128);
}, 90000);
it("cancellation kills within grace and removes the container", async () => {
  const context = await environment("http");
  const controller = new AbortController();
  // Docker integration uses the platform clock: abort when the container emits its ready event, not a sleep.
  const command = async (args: readonly string[], timeout?: number) => {
    if (args[0] !== "start") return dockerCommand(args, timeout);
    const child = spawn("docker", [...args]);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      if (chunk.toString().includes("ready")) controller.abort();
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 137));
    });
    return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), droppedBytes: 0 };
  };
  await writeFile(
    join(context.options.inputDir, "test.mjs"),
    "console.log('ready'); setInterval(()=>{},1000);",
  );
  const started = performance.now();
  const result = await new DockerExecutor(command).execute(
    {
      ...context.options,
      cancellationGraceMs: 50,
      command: ["node", "/run/testmaster/input/test.mjs"],
    },
    controller.signal,
  );
  expect(result.cancelled).toBe(true);
  expect(result.code).not.toBe(0);
  expect(performance.now() - started).toBeLessThan(10000);
  expect((await dockerCommand(["inspect", `tm-att-${context.options.attemptId}`])).code).not.toBe(
    0,
  );
}, 90000);
