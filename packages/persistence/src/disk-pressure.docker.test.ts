import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("OPS-023 physical tmpfs ENOSPC preserves SQLite integrity and reserves recovery space without fictitious artifacts", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const lock = JSON.parse(
    await readFile(resolve(root, "containers/images.lock.json"), "utf8"),
  ) as Record<string, { imageId: string }>;
  const image = lock["testmaster-runner"]?.imageId;
  expect(image).toBeTruthy();
  const script = `
    import { PersistenceDatabase } from '/workspace/packages/persistence/dist/index.js';
    import { FileEvidenceStore } from '/workspace/packages/evidence/dist/index.js';
    import { uuidV7IdGenerator } from '/workspace/packages/domain/dist/index.js';
    import { open, stat, unlink, readFile } from 'node:fs/promises';
    const database = await PersistenceDatabase.open('/space/testmaster.db');
    const reserve = await stat('/space/.control-plane.reserve');
    if(reserve.blocks * 512 < 4 * 1024 * 1024) throw new Error('Sparse reserve');
    const workspaceId=uuidV7IdGenerator.next('ws');
    database.run("INSERT INTO workspaces(workspace_id,id,created_at,name,mode,settings_version,quota_policy_id) VALUES(?,?,?, 'disk', 'single-user',1,'local')",workspaceId,workspaceId,new Date().toISOString());
    const stage = await new FileEvidenceStore({rootDir:'/space',maxObjectBytes:64*1024*1024}).openAttempt({workspaceId:uuidV7IdGenerator.next('ws'),runId:uuidV7IdGenerator.next('run'),attemptId:uuidV7IdGenerator.next('att'),revisionId:uuidV7IdGenerator.next('rev'),snapshotId:uuidV7IdGenerator.next('snp')});
    const writer = await stage.beginArtifact({relativePath:'overflow.bin',kind:'log',mimeType:'application/octet-stream'});
    const filler = await open('/space/filler','wx');
    let artifactFull=false;
    try {for(;;) await filler.writeFile(Buffer.alloc(65536));} catch(error) {if(error.code!=='ENOSPC') throw error;}
    await filler.close();
    try {await writer.write(Buffer.alloc(65536));} catch(error) {artifactFull=error.code==='ENOSPC';}
    if(!artifactFull) throw new Error('Artifact did not hit physical ENOSPC');
    let dbFull=false;
    try {database.withTx(()=>database.run("INSERT INTO operational_state(key,value) VALUES('full',?)",'x'.repeat(2*1024*1024)));} catch(error) {dbFull=/full/.test(error.message);}
    if(!dbFull) throw new Error('DB did not hit physical ENOSPC');
    const refill=await open('/space/filler','a');
    try{for(;;)await refill.writeFile(Buffer.alloc(65536));}catch(error){if(error.code!=='ENOSPC')throw error;}finally{await refill.close();}
    let auditFull=false;
    try{database.withTx(()=>database.run("INSERT INTO audit_events(workspace_id,id,created_at,actor,action,resource_id,request_id,timestamp,data_json) VALUES(?,?,?,?,?,?,?,?,?)",workspaceId,uuidV7IdGenerator.next('aud'),new Date().toISOString(),'local','disk.full','disk','request',new Date().toISOString(),'x'.repeat(2*1024*1024)));}catch(error){auditFull=/full/.test(error.message);}
    if(!auditFull)throw new Error('Audit did not hit physical ENOSPC');
    await unlink('/space/filler');
    try {await stat('/space/.control-plane.reserve');throw new Error('Reserve not released');}catch(error){if(error.code!=='ENOENT')throw error;}
    database.withTx(()=>database.run("INSERT INTO operational_state(key,value) VALUES('recovered','true')"));
    if(database.get('PRAGMA integrity_check').integrity_check!=='ok')throw new Error('Database corrupt');
    const bundle=await stage.commit({redactionPolicyHash:'0'.repeat(64)});
    const manifest=JSON.parse(await readFile(bundle.bundleDir+'/manifest.json','utf8'));
    if(manifest.entries[0].state!=='missing'||manifest.entries[0].omissionReason!=='storage_unavailable')throw new Error('Fictitious artifact');
    database.close();console.log(JSON.stringify({artifactFull,dbFull,reserveReleased:true,integrity:'ok'}));
  `;
  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--interactive",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/space:rw,nosuid,nodev,size=16m,mode=1777",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=16m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--security-opt",
      `seccomp=${resolve(root, "containers/seccomp_profile.json")}`,
      "--user",
      "1000:1000",
      "--memory",
      "256m",
      "--memory-swap",
      "256m",
      "--pids-limit",
      "64",
      "--mount",
      `type=bind,source=${root},target=/workspace,readonly`,
      "--entrypoint",
      "node",
      image ?? "",
      "--input-type=module",
    ],
    { stdio: "pipe" },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.end(script);
  const code = await completed;
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout.trim())).toEqual({
    artifactFull: true,
    dbFull: true,
    reserveReleased: true,
    integrity: "ok",
  });
}, 60_000);
