import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExecutablePlan } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { FileEvidenceStore } from "@testmaster/evidence";
import { expect, it } from "vitest";
import { startShop } from "../../../../fixtures/reference-shop/src/index.js";
import { DockerExecutor, dockerCommand } from "../docker/executor.js";
import { readImageLock } from "../images/lock.js";
import { AttemptExecutor } from "./executor.js";

function plan(path: string): ExecutablePlan {
  return {
    schemaVersion: "1.0.0",
    kind: "executable",
    name: "Adversarial acceptance",
    type: "frontend",
    runner: "playwright",
    requirementRefs: [],
    steps: [
      {
        id: "open",
        kind: "action",
        operation: "navigate",
        description: "Open target",
        input: { path },
      },
      {
        id: "check",
        kind: "assertion",
        operation: "assert",
        description: "Require fixture",
        input: { locator: { by: "testId", value: "fixture" } },
        expectation: { predicate: "visible" },
      },
    ],
  };
}
async function attempt(options: {
  url: string;
  plan?: ExecutablePlan;
  script?: string;
  strictSeccomp?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "tm-adv-"));
  const inputDir = join(root, "input");
  const runtime = join(root, "runtime");
  await mkdir(inputDir);
  await mkdir(runtime);
  const ids = {
    workspaceId: uuidV7IdGenerator.next("ws"),
    runId: uuidV7IdGenerator.next("run"),
    attemptId: uuidV7IdGenerator.next("att"),
    revisionId: uuidV7IdGenerator.next("rev"),
    snapshotId: uuidV7IdGenerator.next("snp"),
  };
  const lock = await readImageLock(resolve("containers/images.lock.json"));
  const commands: string[][] = [];
  const docker = new DockerExecutor(async (args, timeout) => {
    commands.push([...args]);
    if (args[0] === "create" && options.strictSeccomp)
      return dockerCommand(
        args.map((argument) => (argument.startsWith("seccomp=") ? "seccomp=default" : argument)),
        timeout,
      );
    return dockerCommand(args, timeout);
  });
  try {
    if (options.script) await writeFile(join(inputDir, "attack.mjs"), options.script);
    const result = await new AttemptExecutor(
      new FileEvidenceStore({ rootDir: join(root, "evidence") }),
      {
        execute: (input, signal) =>
          docker.execute({ ...input, ...(options.script ? { entrypoint: ["node"] } : {}) }, signal),
      },
      runtime,
    ).execute({
      ...ids,
      kind: options.script ? "http" : "browser",
      imageId: lock["testmaster-runner"].imageId,
      inputDir,
      networkPolicy: {
        allowedOrigins: [options.url],
        networkProfile: "local-loopback",
        baseUrl: options.url,
      },
      runnerInput: { baseUrl: options.url, stepTimeoutMs: 2500 },
      ...(options.plan ? { plan: options.plan } : {}),
      ...(options.script ? { imageCommand: ["/run/testmaster/input/attack.mjs"] } : {}),
      seccompPath: resolve("containers/seccomp_profile.json"),
      attemptTimeoutMs: 20000,
      cancellationGraceMs: 100,
    });
    const manifest = JSON.parse(
      await readFile(join(result.bundle?.bundleDir ?? "", "manifest.json"), "utf8"),
    );
    const contents = new Map<string, Buffer>();
    for (const entry of manifest.entries)
      if (entry.state === "available")
        contents.set(
          entry.relativePath,
          await readFile(join(result.bundle?.bundleDir ?? "", entry.relativePath)),
        );
    return { result, manifest, contents, commands };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it.each(["js", "meta", "fetch", "iframe", "websocket"])(
  "blocks browser %s exfiltration without connecting to the external target",
  async (mode) => {
    const shop = await startShop();
    try {
      const path = `/adversarial/${mode}?target=${encodeURIComponent("http://127.0.0.1:9222/collect?token=page-canary")}`;
      const { result } = await attempt({ url: shop.url, plan: plan(path) });
      expect(result.outcome).not.toBe("passed");
      expect(
        result.events.some(
          (event) =>
            event.type === "step.finished" &&
            event.payload.stepId === "check" &&
            event.payload.status === "passed",
        ),
      ).toBe(false);
    } finally {
      await shop.close();
    }
  },
  60000,
);

it("blocks service-worker registration rather than permitting a worker fetch bypass", async () => {
  const shop = await startShop();
  try {
    const { result, contents } = await attempt({
      url: shop.url,
      plan: plan("/adversarial/worker?target=http%3A%2F%2F169.254.169.254%2F"),
    });
    expect(result.outcome).toBe("passed");
    const network =
      contents.get("browser/network.ndjson")?.toString() ??
      [...contents.values()].map((value) => value.toString()).join("\n");
    expect(network).toContain("Service Worker registration blocked");
  } finally {
    await shop.close();
  }
}, 60000);

it("a stricter seccomp profile forces Chromium sandbox failure and produces blocked without an unsafe retry", async () => {
  const shop = await startShop();
  try {
    const { result, commands } = await attempt({
      url: shop.url,
      plan: plan("/adversarial/none"),
      strictSeccomp: true,
    });
    expect(result.outcome).toBe("blocked");
    expect(result.reasonCode).toBe("security_precondition_failed");
    expect(commands.filter((args) => args[0] === "create")).toHaveLength(1);
    expect(JSON.stringify(commands)).not.toContain("--no-sandbox");
    expect(result.events.some((event) => event.type === "step.started")).toBe(false);
  } finally {
    await shop.close();
  }
}, 60000);

it("invalid TLS certificate is rejected before the page can perform login", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tm-tls-"));
  let logins = 0;
  let requests = 0;
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=fixture.test",
  ]);
  const target = createServer(
    {
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    },
    (request, response) => {
      requests++;
      if (request.url === "/login") logins++;
      response.end(
        '<h1 data-testid="fixture">Unsafe login</h1><script>fetch("/login",{method:"POST",body:"password=canary"})</script>',
      );
    },
  );
  await new Promise<void>((done) => target.listen(0, "127.0.0.1", done));
  const address = target.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  try {
    const { result } = await attempt({
      url: `https://fixture.test:${address.port}`,
      plan: plan("/"),
    });
    expect(result.outcome).not.toBe("passed");
    expect(logins).toBe(0);
    expect(requests).toBe(0);
    expect(JSON.stringify(result.events)).toContain("ERR_CERT_AUTHORITY_INVALID");
  } finally {
    await new Promise<void>((done) => target.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

it.each(["foreign-run", "oversized", "uri", "duplicate"])(
  "rejects Docker runner %s messages and preserves previous accepted observations",
  async (mode) => {
    const script = `import {readFile} from 'node:fs/promises'; import {connect} from 'node:net';
const input=JSON.parse(await readFile('/run/testmaster/input/snapshot.json','utf8'));
const socket=connect('/run/testmaster/sockets/protocol.sock'); await new Promise(done=>socket.once('connect',done)); socket.on('error',()=>{});
const event=(seq,type,payload)=>({protocolVersion:'1.0.0',seq,attemptId:input.attemptId,occurredAt:new Date().toISOString(),type,payload});
const send=message=>socket.write(JSON.stringify(message)+'\\n');
send(event(0,'runner.hello',{nonce:input.nonce})); send(event(1,'log',{level:'info',message:'valid-prior-observation'}));
await new Promise(done=>socket.write('',done));
const mode=${JSON.stringify(mode)};
if(mode==='foreign-run') send({...event(2,'log',{level:'info',message:'forged'}),runId:'run_foreign'});
if(mode==='oversized') send(event(2,'log',{level:'info',message:'x'.repeat(300000)}));
if(mode==='uri') send(event(2,'artifact.begin',{artifactId:'art_01901234-1234-7123-8123-123456789012',relativePath:'file:///etc/passwd',kind:'log',mimeType:'text/plain',sizeBytes:0}));
if(mode==='duplicate') send(event(1,'log',{level:'info',message:'forged'}));
await new Promise(done=>socket.once('close',done));`;
    const { result, contents } = await attempt({ url: "http://fixture.test:1", script });
    expect(result.outcome).toBe("inconclusive");
    expect(
      result.events.some(
        (event) => event.type === "log" && event.payload.message === "valid-prior-observation",
      ),
    ).toBe(true);
    expect(
      result.events.some((event) => event.type === "log" && event.payload.message === "forged"),
    ).toBe(false);
    expect(contents.has("logs/protocol.json")).toBe(true);
    expect([...contents.keys()].every((path) => !path.includes("file:"))).toBe(true);
  },
  60000,
);

it("controller withholds compromised runner PII corpus and malformed JSON with no raw fallback", async () => {
  const corpus =
    "Authorization: Bearer AUTH-CANARY\nSet-Cookie: session=COOKIE-CANARY\npassword=PASSWORD-CANARY email=buyer@example.test document=123.456.789-09 https://fixture.test/?token=URL-CANARY";
  const malformed = '{"password":"PARSER-CANARY",';
  const script = `import {readFile} from 'node:fs/promises'; import {connect} from 'node:net'; import {createHash} from 'node:crypto';
const input=JSON.parse(await readFile('/run/testmaster/input/snapshot.json','utf8')); const socket=connect('/run/testmaster/sockets/protocol.sock'); socket.on('error',()=>{}); await new Promise(done=>socket.once('connect',done)); let seq=0;
const send=(type,payload)=>socket.write(JSON.stringify({protocolVersion:'1.0.0',seq:seq++,attemptId:input.attemptId,occurredAt:new Date().toISOString(),type,payload})+'\\n');
send('runner.hello',{nonce:input.nonce}); send('log',{level:'info',message:${JSON.stringify(corpus)}});
for(const [index,text] of [${JSON.stringify(corpus)},${JSON.stringify(malformed)}].entries()) {const data=Buffer.from(text);const artifactId='art_01901234-1234-7123-8123-12345678901'+index; send('artifact.begin',{artifactId,relativePath:index?'bad.json':'pii.txt',kind:'log',mimeType:index?'application/json':'text/plain',sizeBytes:data.length}); send('artifact.chunk',{artifactId,data:data.toString('base64')}); send('artifact.end',{artifactId,sizeBytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});}
send('runner.finished',{outcome:'passed',reasonCode:'assertions_satisfied'}); socket.end();`;
  const { result, manifest, contents } = await attempt({ url: "http://fixture.test:1", script });
  expect(result.outcome).toBe("passed");
  for (const path of ["pii.txt", "bad.json"])
    expect(
      manifest.entries.find((entry: { relativePath: string }) => entry.relativePath === path),
    ).toMatchObject({ state: "missing", omissionReason: "redaction_failed" });
  const published =
    JSON.stringify(result.events) +
    [...contents.values()].map((bytes) => bytes.toString()).join("\n");
  for (const value of [
    "AUTH-CANARY",
    "COOKIE-CANARY",
    "PASSWORD-CANARY",
    "buyer@example.test",
    "123.456.789-09",
    "URL-CANARY",
    "PARSER-CANARY",
  ])
    expect(published).not.toContain(value);
}, 60000);
