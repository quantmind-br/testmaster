import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { FileEvidenceStore } from "@testmaster/evidence";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type DockerCommand, DockerExecutor } from "../docker/executor.js";
import { AttemptExecutor } from "./executor.js";

beforeEach(() => {
  // Only the monotonic clock is faked: the unix socket I/O stays real, time moves by hand.
  vi.useFakeTimers({ toFake: ["performance"] });
});
afterEach(() => {
  vi.useRealTimers();
});

it("stops the attempt clock while a runner's model request is being resolved and restarts it with the answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-clock-test-"));
  const runtime = join(root, "runtime");
  const inputDir = join(root, "input");
  await mkdir(runtime);
  await mkdir(inputDir);
  const ids = {
    workspaceId: uuidV7IdGenerator.next("ws"),
    runId: uuidV7IdGenerator.next("run"),
    attemptId: uuidV7IdGenerator.next("att"),
    revisionId: uuidV7IdGenerator.next("rev"),
    snapshotId: uuidV7IdGenerator.next("snp"),
  };
  const imageId = `sha256:${"1".repeat(64)}`;
  const answer = Promise.withResolvers<null>();
  const requested = Promise.withResolvers<void>();
  const elapsed = { whilePending: 0, afterAnswer: 0 };
  const command: DockerCommand = async (args, _timeoutMs, clock) => {
    if (args[0] === "inspect")
      return {
        code: 0,
        stdout: Buffer.from(
          JSON.stringify([
            {
              Image: imageId,
              Config: { User: "1000:1000", Labels: {} },
              HostConfig: {
                NetworkMode: "none",
                ReadonlyRootfs: true,
                CapDrop: ["ALL"],
                CapAdd: [],
                SecurityOpt: ["seccomp=profile", "no-new-privileges"],
                Memory: 1,
                MemorySwap: 1,
                NanoCpus: 1,
                PidsLimit: 128,
              },
              Mounts: [],
              State: {
                OOMKilled: false,
                ExitCode: 0,
                StartedAt: new Date().toISOString(),
                Error: "",
              },
            },
          ]),
        ),
        stderr: Buffer.alloc(0),
        droppedBytes: 0,
      };
    if (args[0] === "start") {
      if (!clock) throw new Error("the attempt clock was not handed to the docker executor");
      const input = JSON.parse(await readFile(join(inputDir, "snapshot.json"), "utf8"));
      const socket = connect(join(runtime, "testmaster", ids.attemptId, "protocol.sock"));
      await once(socket, "connect");
      const send = (seq: number, type: string, payload: unknown) =>
        socket.write(
          `${JSON.stringify({ protocolVersion: "1.0.0", seq, attemptId: ids.attemptId, occurredAt: new Date().toISOString(), type, payload })}\n`,
        );
      const answered = Promise.withResolvers<void>();
      socket.on("data", (chunk) => {
        if (chunk.toString("utf8").includes('"agent.action"')) answered.resolve();
      });
      send(0, "runner.hello", { nonce: input.nonce });
      send(1, "agent.request", { stepId: "explore-1", observation: {} });
      await requested.promise;
      const watch = clock.stopwatch();
      vi.advanceTimersByTime(60_000);
      elapsed.whilePending = watch.elapsed();
      answer.resolve(null);
      await answered.promise;
      vi.advanceTimersByTime(40);
      elapsed.afterAnswer = watch.elapsed();
      send(2, "runner.finished", { outcome: "passed", reasonCode: "assertions_satisfied" });
      socket.end();
      await once(socket, "close");
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), droppedBytes: 0 };
  };
  try {
    const result = await new AttemptExecutor(
      new FileEvidenceStore({ rootDir: join(root, "evidence"), maxObjectBytes: 1024 * 1024 }),
      new DockerExecutor(command),
      runtime,
    ).execute({
      ...ids,
      kind: "browser",
      imageId,
      inputDir,
      networkPolicy: {
        allowedOrigins: ["http://127.0.0.1:1"],
        networkProfile: "local-loopback",
        baseUrl: "http://127.0.0.1:1",
      },
      seccompPath: join(process.cwd(), "containers/seccomp_profile.json"),
      resolveAction: async () => {
        requested.resolve();
        return answer.promise;
      },
    });
    expect(result.outcome).toBe("passed");
    // A minute of waiting for the model costs the attempt nothing; time after the answer counts.
    expect(elapsed).toEqual({ whilePending: 0, afterAnswer: 40 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
