import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  type DockerAttempt,
  type DockerCommand,
  DockerExecutor,
  dockerCreateArgs,
} from "./executor.js";

const attempt: DockerAttempt = {
  attemptId: "att_example",
  runId: "run_example",
  kind: "browser",
  imageId: `sha256:${"a".repeat(64)}`,
  inputDir: "/input",
  socketsDir: "/sockets",
  seccompPath: "/seccomp.json",
};
it("refuses mutable images, root users and mount syntax injection before spawning", () => {
  for (const override of [
    { imageId: "runner:latest" },
    { user: "0:0" },
    { inputDir: "/input,readonly=false" },
    { socketsDir: "relative" },
    { attemptId: "../escape" },
  ])
    expect(() => dockerCreateArgs({ ...attempt, ...override })).toThrow();
});
it("reports unavailable daemon without selecting a process fallback", async () => {
  const calls: readonly string[][] = [];
  const command: DockerCommand = async (args) => {
    (calls as string[][]).push([...args]);
    return {
      code: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("unavailable"),
      droppedBytes: 0,
    };
  };
  expect(await new DockerExecutor(command).doctor()).toEqual({
    available: false,
    mode: "unknown",
    seccomp: false,
    cgroupVersion: null,
    diagnostics: ["docker_daemon_unavailable"],
  });
  expect(calls).toHaveLength(1);
});
it("doctor refuses missing seccomp or cgroup v2 and reports rootless/rootful accurately", async () => {
  for (const [SecurityOptions, CgroupVersion, available, mode] of [
    [[], "2", false, "rootful"],
    [["name=seccomp"], "1", false, "rootful"],
    [["name=seccomp", "name=rootless"], "2", true, "rootless"],
  ] as const) {
    const command: DockerCommand = async () => ({
      code: 0,
      stdout: Buffer.from(JSON.stringify({ SecurityOptions, CgroupVersion })),
      stderr: Buffer.alloc(0),
      droppedBytes: 0,
    });
    const result = await new DockerExecutor(command).doctor();
    expect(result.available).toBe(available);
    expect(result.mode).toBe(mode);
  }
});
it("reaps only orphan attempts whose durable lease expired", async () => {
  const removed: string[] = [];
  const command: DockerCommand = async (args) => {
    const stdout =
      args[0] === "ps"
        ? "tm-att-att_expired\ntm-att-att_live\n"
        : args[0] === "inspect"
          ? JSON.stringify([
              {
                Config: {
                  Labels: {
                    "io.testmaster.attempt": args[1]?.slice(7),
                    "io.testmaster.run": "run_example",
                    "io.testmaster.owner-pid": "123",
                  },
                },
              },
            ])
          : "";
    if (args[0] === "rm") removed.push(args[2] ?? "");
    return { code: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), droppedBytes: 0 };
  };
  expect(await new DockerExecutor(command).reapOrphans(async (id) => id === "att_expired")).toEqual(
    ["att_expired"],
  );
  expect(removed).toEqual(["tm-att-att_expired"]);
});
function info(fields: Record<string, unknown>): DockerCommand {
  return async () => ({
    code: 0,
    stdout: Buffer.from(JSON.stringify({ CgroupVersion: "2", ...fields })),
    stderr: Buffer.alloc(0),
    droppedBytes: 0,
  });
}
it("OPS-001 doctor refuses a rootless daemon that cannot enforce cgroup limits and accepts one that can", async () => {
  const rootless = ["name=seccomp", "name=rootless"];
  const enforced = await new DockerExecutor(
    info({
      SecurityOptions: rootless,
      MemoryLimit: true,
      SwapLimit: true,
      CpuCfsQuota: true,
      PidsLimit: true,
    }),
  ).doctor();
  expect(enforced).toMatchObject({ available: true, mode: "rootless", diagnostics: [] });
  for (const missing of ["MemoryLimit", "SwapLimit", "CpuCfsQuota", "PidsLimit"]) {
    const refused = await new DockerExecutor(
      info({
        SecurityOptions: rootless,
        MemoryLimit: true,
        SwapLimit: true,
        CpuCfsQuota: true,
        PidsLimit: true,
        [missing]: false,
      }),
    ).doctor();
    expect(refused).toMatchObject({
      available: false,
      mode: "rootless",
      diagnostics: ["resource_limits_unsupported"],
    });
  }
});
it("OPS-001 stops an attempt whose container lost a resource limit and removes it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tm-limits-"));
  try {
    await Promise.all(["input", "sockets"].map((name) => mkdir(join(directory, name))));
    await writeFile(join(directory, "seccomp.json"), "{}");
    const run = async (limits: { Memory: number; PidsLimit: number; NanoCpus: number }) => {
      const calls: string[][] = [];
      const command: DockerCommand = async (args) => {
        calls.push([...args]);
        const stdout =
          args[0] === "inspect"
            ? JSON.stringify([
                {
                  Image: attempt.imageId,
                  Config: { User: "1000:1000", Labels: {} },
                  HostConfig: {
                    NetworkMode: "none",
                    ReadonlyRootfs: true,
                    CapDrop: ["ALL"],
                    CapAdd: [],
                    SecurityOpt: ["seccomp=profile", "no-new-privileges"],
                    MemorySwap: limits.Memory,
                    ...limits,
                  },
                  Mounts: [],
                  State: {
                    OOMKilled: false,
                    ExitCode: 0,
                    StartedAt: "2026-01-01T00:00:00Z",
                    Error: "",
                  },
                },
              ])
            : "";
        return { code: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), droppedBytes: 0 };
      };
      const outcome = await new DockerExecutor(command)
        .execute({
          ...attempt,
          kind: "http",
          inputDir: join(directory, "input"),
          socketsDir: join(directory, "sockets"),
          seccompPath: join(directory, "seccomp.json"),
        })
        .then(
          (result) => result,
          (error: unknown) => error,
        );
      return { outcome, calls };
    };
    const enforced = { Memory: 512 * 1024 ** 2, PidsLimit: 128, NanoCpus: 1e9 };
    const control = await run(enforced);
    expect(control.outcome).toMatchObject({ code: 0 });
    for (const dropped of [
      { ...enforced, Memory: 0 },
      { ...enforced, PidsLimit: 0 },
      { ...enforced, PidsLimit: -1 },
      { ...enforced, NanoCpus: 0 },
      { ...enforced, Memory: enforced.Memory * 2 },
    ]) {
      const { outcome, calls } = await run(dropped);
      expect(outcome).toMatchObject({ message: "security_precondition_failed" });
      expect(calls.some((call) => call[0] === "start")).toBe(false);
      expect(calls.some((call) => call[0] === "rm")).toBe(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
