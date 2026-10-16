import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecutablePlan, type RunnerEvent, validate } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { FileEvidenceStore } from "@testmaster/evidence";
import { expect, it } from "vitest";
import { type DockerCommand, DockerExecutor } from "../docker/executor.js";
import { AttemptExecutor } from "./executor.js";

const inspected = (imageId: string) =>
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
      State: { OOMKilled: false, ExitCode: 0, StartedAt: new Date().toISOString(), Error: "" },
    },
  ]);

it("keeps a plan step id and the evidence path it names when the id contains a secret value, and still redacts what the target returned", async () => {
  const root = await mkdtemp(join(tmpdir(), "event-identifiers-test-"));
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
  const secretRef = uuidV7IdGenerator.next("sec");
  // The secret is the username `root`; the plan step id contains it, as on a real login test.
  const stepId = "assert_root_url";
  const evidencePath = `http/${stepId}.json`;
  const fixture = JSON.parse(
    await readFile("packages/contracts/fixtures/valid/backend.json", "utf8"),
  ) as { value: ExecutablePlan };
  const plan = validate<ExecutablePlan>("ExecutablePlan", {
    ...fixture.value,
    steps: fixture.value.steps.map((step) =>
      step.id === "check-status" ? { ...step, id: stepId } : step,
    ),
  });
  const bytes = Buffer.from('{"ok":true}');
  const command: DockerCommand = async (args) => {
    if (args[0] === "inspect")
      return {
        code: 0,
        stdout: Buffer.from(inspected(imageId)),
        stderr: Buffer.alloc(0),
        droppedBytes: 0,
      };
    if (args[0] === "start") {
      const config = JSON.parse(await readFile(join(inputDir, "snapshot.json"), "utf8"));
      const socket = connect(join(runtime, "testmaster", ids.attemptId, "protocol.sock"));
      await once(socket, "connect");
      const artifactId = uuidV7IdGenerator.next("art");
      const released = Promise.withResolvers<void>();
      socket.on("data", (chunk) => {
        if (chunk.toString("utf8").includes('"secret.value"')) released.resolve();
      });
      const send = (messages: [string, unknown][], first: number) => {
        for (const [offset, [type, payload]] of messages.entries())
          socket.write(
            `${JSON.stringify({ protocolVersion: "1.0.0", seq: first + offset, attemptId: ids.attemptId, occurredAt: new Date().toISOString(), type, payload })}\n`,
          );
      };
      send(
        [
          ["runner.hello", { nonce: config.nonce }],
          ["secret.request", { requestId: "secret-1", secretRef, secretVersion: 1 }],
        ],
        0,
      );
      // The supervisor holds the secret value before anything below is sent.
      await released.promise;
      send(
        [
          ["step.started", { stepId, index: 0 }],
          [
            "artifact.begin",
            {
              artifactId,
              relativePath: evidencePath,
              kind: "http",
              mimeType: "application/json",
              sizeBytes: bytes.byteLength,
            },
          ],
          ["artifact.chunk", { artifactId, data: bytes.toString("base64") }],
          [
            "artifact.end",
            {
              artifactId,
              sizeBytes: bytes.byteLength,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          ],
          [
            "step.finished",
            {
              stepId,
              index: 0,
              status: "passed",
              // A code run's title is text the test framework produced, so it is redacted too.
              title: "log in as root",
              observed: "logged in as root",
              expected: "logged in as root",
              durationMs: 1,
              // The second path was never begun as an artifact, so nothing vouches for it.
              evidencePaths: [evidencePath, "http/other-root.json"],
            },
          ],
          ["step.started", { stepId: "unplanned-root-step", index: 1 }],
          ["runner.finished", { outcome: "passed", reasonCode: "assertions_satisfied" }],
        ],
        2,
      );
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
      kind: "http",
      imageId,
      inputDir,
      plan,
      networkPolicy: {
        allowedOrigins: ["http://127.0.0.1:1"],
        networkProfile: "local-loopback",
        baseUrl: "http://127.0.0.1:1",
      },
      secretRefs: [{ secretRef, secretVersion: 1, resolve: async () => "root" }],
      seccompPath: join(process.cwd(), "containers/seccomp_profile.json"),
    });
    expect(result.outcome).toBe("passed");
    const payloadOf = (type: RunnerEvent["type"], index: number) =>
      result.events.filter((event) => event.type === type)[index]?.payload;
    // The frozen plan step keeps its exact id, and so does the artifact path that names it.
    expect(payloadOf("step.started", 0)).toMatchObject({ stepId });
    expect(payloadOf("step.finished", 0)).toMatchObject({
      stepId,
      // Values observed from the target, and the title a step was given, stay redacted.
      title: "log in as [REDACTED]",
      observed: "logged in as [REDACTED]",
      expected: "logged in as [REDACTED]",
      evidencePaths: [evidencePath, "http/other-[REDACTED].json"],
    });
    // A name the plan does not declare is not an identifier: it is redacted like any other text.
    expect(payloadOf("step.started", 1)).toMatchObject({ stepId: "unplanned-[REDACTED]-step" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
