import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { expect, it } from "vitest";
import { FileEvidenceStore } from "../../packages/evidence/src/index.js";
import { AttemptExecutor } from "../../packages/sandbox/src/attempt/executor.js";
import { DockerExecutor, dockerCommand } from "../../packages/sandbox/src/docker/executor.js";
import { readImageLock } from "../../packages/sandbox/src/images/lock.js";

/**
 * NFR-003 / SEC-030: tenant A's hostile attempt runs in the real sandbox image next to tenant B's
 * evidence directory, secret value and network service. B's data lives on the same host and in the
 * same evidence root, exactly as in the server profile.
 */
const secretCanary = "TENANT-B-SECRET-CANARY-c40b7e";
const evidenceCanary = "TENANT-B-EVIDENCE-CANARY-9a17d2";

async function digestTree(directory: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  const visit = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else
        entries[path.slice(directory.length)] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
    }
  };
  await visit(directory);
  return entries;
}

function close(server: Server): Promise<void> {
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  return closed.promise;
}

async function listen(handler: Parameters<typeof createServer>[1], host: string) {
  const server: Server = createServer(handler);
  const listening = Promise.withResolvers<void>();
  server.listen(0, host, () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return { server, port: address.port };
}

function attackScript(options: {
  bPath: string;
  bPort: number;
  bHosts: string[];
  evidenceRoot: string;
  ownUrl: string;
  secretCanary: string;
  evidenceCanary: string;
}) {
  return `import {readFile, readdir} from 'node:fs/promises'; import {connect} from 'node:net'; import {createHash} from 'node:crypto';
const input=JSON.parse(await readFile('/run/testmaster/input/snapshot.json','utf8'));
const o=${JSON.stringify(options)};
const socket=connect('/run/testmaster/sockets/protocol.sock'); socket.on('error',()=>{}); await new Promise(done=>socket.once('connect',done)); let seq=0;
const send=(type,payload)=>socket.write(JSON.stringify({protocolVersion:'1.0.0',seq:seq++,attemptId:input.attemptId,occurredAt:new Date().toISOString(),type,payload})+'\\n');
send('runner.hello',{nonce:input.nonce});
const lines=[];
const probe=async(name,fn)=>{try{lines.push(name+'='+await fn())}catch(error){lines.push(name+'=error:'+(error&&error.code||String(error).slice(0,40)))}};
await probe('read_b_evidence',async()=>{const text=await readFile(o.bPath,'utf8'); return 'READ:'+text.length});
await probe('list_evidence_root',async()=>'LISTED:'+(await readdir(o.evidenceRoot)).length);
await probe('read_input_control',async()=>'OWN:'+(await readFile('/run/testmaster/input/snapshot.json','utf8')).length);
await probe('mounts_mention_host_evidence',async()=>String((await readFile('/proc/self/mountinfo','utf8')).includes(o.evidenceRoot)));
await probe('env_has_b_secret',async()=>String(JSON.stringify(process.env).includes(o.secretCanary)));
await probe('env_has_b_evidence',async()=>String(JSON.stringify(process.env).includes(o.evidenceCanary)));
await probe('tree_has_canary',async()=>{let hit=false; for(const root of ['/run','/tmp','/home','/mnt','/media','/opt','/srv']){let names=[]; try{names=await readdir(root,{recursive:true})}catch{continue} for(const name of names.slice(0,5000)){ if(String(name).includes('canary')) hit=true }} return String(hit)});
const tcp=(host,port)=>new Promise(done=>{const s=connect({host,port,timeout:1500}); s.once('connect',()=>{s.destroy();done('CONNECTED')}); s.once('timeout',()=>{s.destroy();done('timeout')}); s.once('error',error=>done('error:'+error.code))});
for(const host of o.bHosts) await probe('net_b_'+host.replace(/[^0-9a-z]/gi,'_'),()=>tcp(host,o.bPort));
const viaProxy=url=>new Promise(done=>{const s=connect('/run/testmaster/sockets/egress.sock'); let data=''; s.setTimeout(8000,()=>{s.destroy();done('timeout')}); s.on('connect',()=>s.write('GET '+url+' HTTP/1.1\\r\\nHost: '+new URL(url).host+'\\r\\nConnection: close\\r\\n\\r\\n')); s.on('data',chunk=>{data+=chunk}); s.on('close',()=>done(data.split('\\r\\n')[0]||'empty')); s.on('error',error=>done('error:'+error.code))});
await probe('proxy_own_target',()=>viaProxy(o.ownUrl));
await probe('proxy_b_target',()=>viaProxy('http://127.0.0.1:'+o.bPort+'/secret'));
const data=Buffer.from(lines.join('\\n')+'\\n'); const artifactId='art_01901234-1234-7123-8123-123456789abc';
send('artifact.begin',{artifactId,relativePath:'findings.txt',kind:'log',mimeType:'text/plain',sizeBytes:data.length});
send('artifact.chunk',{artifactId,data:data.toString('base64')});
send('artifact.end',{artifactId,sizeBytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
send('runner.finished',{outcome:'passed',reasonCode:'assertions_satisfied'}); socket.end();`;
}

it("NFR-003 SEC-030 M4-01 a hostile attempt of tenant A cannot read tenant B's evidence, secret or network service", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-isolation-docker-"));
  const evidenceRoot = join(root, "evidence");
  const inputDir = join(root, "input");
  const runtime = join(root, "runtime");
  await Promise.all(
    [evidenceRoot, inputDir, runtime].map((path) => mkdir(path, { recursive: true })),
  );
  const workspaceA = uuidV7IdGenerator.next("ws");
  const workspaceB = uuidV7IdGenerator.next("ws");
  const store = new FileEvidenceStore({ rootDir: evidenceRoot });
  // Tenant B: committed evidence carrying a canary, a secret value file and a live network service.
  const idsB = {
    workspaceId: workspaceB,
    runId: uuidV7IdGenerator.next("run"),
    attemptId: uuidV7IdGenerator.next("att"),
    revisionId: uuidV7IdGenerator.next("rev"),
    snapshotId: uuidV7IdGenerator.next("snp"),
  };
  const stageB = await store.openAttempt(idsB);
  const writerB = await stageB.beginArtifact({
    relativePath: "b-private.txt",
    kind: "log",
    mimeType: "text/plain",
  });
  await writerB.write(Buffer.from(`${evidenceCanary}\n`));
  const entryB = await writerB.end();
  await stageB.commit({ redactionPolicyHash: "0".repeat(64) });
  const bPath = join(
    evidenceRoot,
    "runs",
    workspaceB,
    idsB.runId,
    idsB.attemptId,
    entryB.relativePath,
  );
  const secretFile = join(root, "vault-b.key");
  await writeFile(secretFile, secretCanary, { mode: 0o600 });
  let bRequests = 0;
  const targetB = await listen((_request, response) => {
    bRequests++;
    response.end(secretCanary);
  }, "0.0.0.0");
  let aRequests = 0;
  const targetA = await listen((_request, response) => {
    aRequests++;
    response.end("tenant-a-fixture");
  }, "127.0.0.1");
  const ownUrl = `http://127.0.0.1:${targetA.port}/health`;
  const before = await digestTree(join(evidenceRoot, "runs", workspaceB));
  const script = attackScript({
    bPath,
    bPort: targetB.port,
    bHosts: ["127.0.0.1", "host.docker.internal", "172.17.0.1"],
    evidenceRoot,
    ownUrl,
    secretCanary,
    evidenceCanary,
  });
  await writeFile(join(inputDir, "attack.mjs"), script);
  const lock = await readImageLock(resolve("containers/images.lock.json"));
  const commands: string[][] = [];
  const docker = new DockerExecutor(async (args, timeout) => {
    commands.push([...args]);
    return dockerCommand(args, timeout);
  });
  const previous = process.env.TENANT_B_SECRET;
  process.env.TENANT_B_SECRET = secretCanary;
  try {
    const ids = {
      workspaceId: workspaceA,
      runId: uuidV7IdGenerator.next("run"),
      attemptId: uuidV7IdGenerator.next("att"),
      revisionId: uuidV7IdGenerator.next("rev"),
      snapshotId: uuidV7IdGenerator.next("snp"),
    };
    const result = await new AttemptExecutor(
      store,
      { execute: (input, signal) => docker.execute({ ...input, entrypoint: ["node"] }, signal) },
      runtime,
    ).execute({
      ...ids,
      kind: "http",
      imageId: lock["testmaster-runner"].imageId,
      inputDir,
      networkPolicy: {
        allowedOrigins: [new URL(ownUrl).origin],
        networkProfile: "local-loopback",
        baseUrl: new URL(ownUrl).origin,
      },
      runnerInput: { baseUrl: new URL(ownUrl).origin, stepTimeoutMs: 2500 },
      imageCommand: ["/run/testmaster/input/attack.mjs"],
      seccompPath: resolve("containers/seccomp_profile.json"),
      attemptTimeoutMs: 60000,
      cancellationGraceMs: 100,
    });
    expect(result.outcome, JSON.stringify(result.events.slice(-3))).toBe("passed");
    const manifest = JSON.parse(
      await readFile(join(result.bundle?.bundleDir ?? "", "manifest.json"), "utf8"),
    ) as { entries: { relativePath: string; state: string }[] };
    expect(manifest.entries.find((entry) => entry.relativePath === "findings.txt")?.state).toBe(
      "available",
    );
    const findings = (await readFile(join(result.bundle?.bundleDir ?? "", "findings.txt"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => line.split("=") as [string, string]);
    const found = Object.fromEntries(findings);
    // Positive controls: the sandbox could read its own input, so the probe harness works.
    expect(found.read_input_control).toMatch(/^OWN:\d+$/);
    // B's evidence, mounts, environment and file tree are not reachable from A's container.
    expect(found.read_b_evidence).toBe("error:ENOENT");
    expect(found.list_evidence_root).toBe("error:ENOENT");
    expect(found.mounts_mention_host_evidence).toBe("false");
    expect(found.env_has_b_secret).toBe("false");
    expect(found.env_has_b_evidence).toBe("false");
    expect(found.tree_has_canary).toBe("false");
    // B's network service, on every address a container could try, never saw a request.
    for (const [name, value] of findings.filter(([key]) => key.startsWith("net_b_")))
      expect(value, name).not.toBe("CONNECTED");
    // The egress proxy is the only way out: it forwards A's allowed origin and refuses B's service.
    expect(found.proxy_own_target).toMatch(/^HTTP\/1\.1 200/);
    expect(aRequests).toBeGreaterThan(0);
    expect(found.proxy_b_target).not.toMatch(/^HTTP\/1\.1 200/);
    expect(found.proxy_b_target).toMatch(/^HTTP\/1\.1 (4\d\d|5\d\d)/);
    expect(bRequests).toBe(0);
    // Nothing of B reaches A's bundle, events or the Docker command lines.
    const published =
      JSON.stringify(result.events) +
      (await readFile(join(result.bundle?.bundleDir ?? "", "findings.txt"), "utf8")) +
      JSON.stringify(commands);
    for (const value of [secretCanary, evidenceCanary, workspaceB, secretFile, bPath])
      expect(published).not.toContain(value);
    // B's evidence tree is byte-identical afterwards and A wrote only under A's own prefix.
    expect(await digestTree(join(evidenceRoot, "runs", workspaceB))).toEqual(before);
    expect((await stat(join(evidenceRoot, "runs", workspaceA))).isDirectory()).toBe(true);
    expect(commands.flat().some((argument) => argument.includes(workspaceB))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.TENANT_B_SECRET;
    else process.env.TENANT_B_SECRET = previous;
    await Promise.all([targetA.server, targetB.server].map(close));
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
