import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DockerExecutor } from "../../packages/sandbox/src/index.js";

/**
 * Runs only in the `docker-rootless` project, whose global setup refuses any daemon that is not
 * rootless. The default `docker` project excludes this file.
 */
const rootless = process.env.TESTMASTER_EXPECT_ROOTLESS === "1";
const exec = promisify(execFile);
const docker = (args: string[]) => exec("docker", args, { env: process.env, timeout: 120_000 });
const image = "testmaster-runner:local";
const created: string[] = [];
afterEach(async () => {
  for (const name of created.splice(0)) await docker(["rm", "-f", name]).catch(() => undefined);
});
const hardened = (name: string, ...extra: string[]) => [
  "run",
  "-d",
  "--name",
  name,
  "--user",
  "1000:1000",
  "--network",
  "none",
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--memory",
  "96m",
  "--memory-swap",
  "96m",
  "--pids-limit",
  "64",
  "--entrypoint",
  "node",
  ...extra,
  image,
  "-e",
  "setTimeout(() => {}, 60000)",
];

describe.skipIf(!rootless)("rootless Docker daemon", () => {
  it("OPS-001 the executor doctor identifies the rootless daemon and finds it usable", async () => {
    const doctor = await new DockerExecutor().doctor();
    expect(doctor).toMatchObject({ available: true, mode: "rootless" });
    // Negative control: the same probe reports a rootful daemon as such.
    const info = await docker(["info", "--format", "{{json .SecurityOptions}}"]);
    expect(info.stdout).toContain("name=rootless");
  });

  it("OPS-001 container users map into the operator's subordinate uid range, never host root or the operator", async () => {
    const name = `tm-s2a-uid-${process.pid}`;
    created.push(name);
    await docker(hardened(name));
    const pid = Number((await docker(["inspect", "--format", "{{.State.Pid}}", name])).stdout);
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const hostUid = Number(/^Uid:\s+(\d+)/mu.exec(status)?.[1]);
    const subuid = (await readFile("/etc/subuid", "utf8"))
      .split("\n")
      .map((line) => line.split(":"))
      .find(([user]) => user === process.env.USER);
    const first = Number(subuid?.[1]);
    const count = Number(subuid?.[2]);
    expect(hostUid).not.toBe(0);
    expect(hostUid).not.toBe(process.getuid?.());
    expect(hostUid).toBeGreaterThanOrEqual(first);
    expect(hostUid).toBeLessThan(first + count);
  });

  it("OPS-001 memory, swap and pid limits are enforced by the rootless cgroup and visible to the container", async () => {
    const name = `tm-s2a-limits-${process.pid}`;
    created.push(name);
    await docker(hardened(name));
    const facts = JSON.parse(
      (await docker(["inspect", "--format", "{{json .HostConfig}}", name])).stdout,
    ) as {
      Memory: number;
      MemorySwap: number;
      PidsLimit: number;
      NetworkMode: string;
      ReadonlyRootfs: boolean;
    };
    expect(facts).toMatchObject({
      Memory: 96 * 1024 * 1024,
      MemorySwap: 96 * 1024 * 1024,
      PidsLimit: 64,
      NetworkMode: "none",
      ReadonlyRootfs: true,
    });
    const inside = await docker([
      "exec",
      name,
      "node",
      "-e",
      "const fs=require('node:fs');console.log(JSON.stringify({memory:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),pids:fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim()}))",
    ]);
    expect(JSON.parse(inside.stdout)).toEqual({ memory: String(96 * 1024 * 1024), pids: "64" });
  });

  it("OPS-001 a container without capabilities cannot regain privileges or write its root filesystem", async () => {
    const name = `tm-s2a-caps-${process.pid}`;
    created.push(name);
    await docker(hardened(name));
    const attempt = await docker([
      "exec",
      name,
      "node",
      "-e",
      "const fs=require('node:fs');let write='allowed';try{fs.writeFileSync('/probe','x')}catch(e){write=e.code}console.log(JSON.stringify({write,caps:fs.readFileSync('/proc/self/status','utf8').match(/CapEff:\\s+(\\w+)/)[1]}))",
    ]);
    expect(JSON.parse(attempt.stdout)).toEqual({ write: "EROFS", caps: "0000000000000000" });
  });
});
