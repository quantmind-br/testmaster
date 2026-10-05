import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerEvent } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { FileEvidenceStore } from "@testmaster/evidence";
import { expect, it } from "vitest";
import { type DockerCommand, DockerExecutor } from "../docker/executor.js";
import { AttemptExecutor } from "./executor.js";

async function scenario(
  mode: "valid" | "regressive" | "missing" | "second" | "quota" | "capture" | "capture-missing",
) {
  const root = await mkdtemp(join(tmpdir(), "protocol-test-"));
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
  let secondClosed = false;
  let removed = false;
  const command: DockerCommand = async (args) => {
    if (args[0] === "rm") removed = true;
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
      const input = JSON.parse(await readFile(join(inputDir, "snapshot.json"), "utf8"));
      const socket = connect(join(runtime, "testmaster", ids.attemptId, "protocol.sock"));
      await once(socket, "connect");
      const send = (seq: number, type: string, payload: unknown) =>
        socket.write(
          `${JSON.stringify({ protocolVersion: "1.0.0", seq, attemptId: ids.attemptId, occurredAt: new Date().toISOString(), type, payload })}\n`,
        );
      send(0, "runner.hello", { nonce: input.nonce });
      if (mode === "capture" || mode === "capture-missing") {
        send(1, "variable.captured", {
          name: "token",
          valueType: "string",
          sensitive: true,
          value: { literal: "protocol-capture-canary" },
        });
        send(2, "runner.finished", { outcome: "passed", reasonCode: "assertions_satisfied" });
      }
      if (mode === "second") {
        const second = connect(join(runtime, "testmaster", ids.attemptId, "protocol.sock"));
        second.on("error", () => {});
        await once(second, "close");
        secondClosed = true;
      }
      if (mode === "quota")
        send(1, "artifact.begin", {
          artifactId: uuidV7IdGenerator.next("art"),
          relativePath: "oversized.txt",
          kind: "log",
          mimeType: "text/plain",
          sizeBytes: 100,
        });
      else if (mode !== "missing" && mode !== "capture" && mode !== "capture-missing")
        send(mode === "regressive" ? 0 : 1, "runner.finished", {
          outcome: "passed",
          reasonCode: "assertions_satisfied",
        });
      await new Promise((resolve) => setTimeout(resolve, 30));
      socket.end();
      await new Promise((resolve) => setTimeout(resolve, 10));
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
      kind: "http",
      imageId,
      inputDir,
      networkPolicy: {
        allowedOrigins: ["http://127.0.0.1:1"],
        networkProfile: "local-loopback",
        baseUrl: "http://127.0.0.1:1",
      },
      seccompPath: join(process.cwd(), "containers/seccomp_profile.json"),
      ...(mode === "capture"
        ? {
            protectCapture: async (
              capture: Extract<RunnerEvent, { type: "variable.captured" }>["payload"],
            ) => {
              expect(capture.value).toEqual({ literal: "protocol-capture-canary" });
              return {
                name: capture.name,
                valueType: capture.valueType,
                sensitive: true,
                encryptedValueRef: "encrypted-capture-ref",
              };
            },
          }
        : {}),
    });
    return { result, secondClosed, removed };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
it.each(["regressive", "missing"] as const)("refuses %s protocol as inconclusive", async (mode) => {
  const { result, removed } = await scenario(mode);
  expect(result.outcome).toBe("inconclusive");
  expect(result.reasonCode).toBe("insufficient_evidence");
  expect(removed).toBe(true);
});
it("refuses a second socket without changing the authenticated attempt", async () => {
  const { result, secondClosed } = await scenario("second");
  expect(secondClosed).toBe(true);
  expect(result.outcome).toBe("passed");
});
it("removes sensitive capture plaintext before public events", async () => {
  const { result } = await scenario("capture");
  expect(result.outcome).toBe("passed");
  expect(JSON.stringify(result.events)).not.toContain("protocol-capture-canary");
  expect(result.events.find((event) => event.type === "variable.captured")?.payload).toMatchObject({
    encryptedValueRef: "encrypted-capture-ref",
  });
});
it("refuses sensitive captures when encrypted storage is unavailable", async () => {
  const { result } = await scenario("capture-missing");
  expect(result.outcome).toBe("blocked");
  expect(result.reasonCode).toBe("missing_secret");
  expect(JSON.stringify(result.events)).not.toContain("protocol-capture-canary");
});
