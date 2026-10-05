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
