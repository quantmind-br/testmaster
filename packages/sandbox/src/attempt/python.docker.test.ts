import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunnerEvent } from "@testmaster/contracts";
import { RunnerSessionValidator } from "@testmaster/contracts";
import { expect, it } from "vitest";
import { startShop } from "../../../../fixtures/reference-shop/src/index.js";
import { DockerExecutor } from "../docker/executor.js";
import { EgressPolicy } from "../egress/policy.js";
import { EgressProxy } from "../egress/proxy.js";
import { readImageLock } from "../images/lock.js";

async function runPython(code: string, mutant = "healthy") {
  const shop = await startShop({ mutant });
  const directory = await mkdtemp(join(tmpdir(), "tm-python-"));
  const inputDir = join(directory, "input");
  const socketsDir = join(directory, "sockets");
  await mkdir(join(inputDir, "code"), { recursive: true, mode: 0o755 });
  await mkdir(socketsDir, { mode: 0o755 });
  const lock = await readImageLock(resolve("containers/images.lock.json"));
  const imageId = lock["testmaster-runner-python"].imageId;
  const attemptId = `att_${randomUUID()}`;
  const nonce = randomUUID();
  const port = Number(new URL(shop.url).port);
  const baseUrl = `http://fixture.test:${port}`;
  const validator = new RunnerSessionValidator({ attemptId, nonce });
  const events: RunnerEvent[] = [];
  const artifacts = new Map<string, Buffer[]>();
  const errors: unknown[] = [];
  const connections = new Set<Socket>();
  let ended: (() => void) | undefined;
  const streamEnded = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const protocol = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => {
      connections.delete(socket);
      ended?.();
    });
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => {
      pending += data;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = validator.accept(line);
          events.push(event);
          if (event.type === "artifact.begin") artifacts.set(event.payload.artifactId, []);
          if (event.type === "artifact.chunk")
            artifacts
              .get(event.payload.artifactId)
              ?.push(Buffer.from(event.payload.data, "base64"));
        } catch (error) {
          errors.push(error);
          socket.destroy();
        }
      }
    });
  });
  const proxy = new EgressProxy({
    socketPath: join(socketsDir, "egress.sock"),
    policy: new EgressPolicy(
      {
        defaultAction: "deny",
        allowedOrigins: [baseUrl],
        privateTargets: [],
        allowedProtocols: ["http", "https"],
        allowRedirects: true,
        maxRedirects: 10,
        allowInsecureTls: false,
      },
      { networkProfile: "local-loopback", baseUrl, host: "127.0.0.1", port },
    ),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      protocol.once("error", reject);
      protocol.listen(join(socketsDir, "protocol.sock"), resolve);
    });
    await chmod(join(socketsDir, "protocol.sock"), 0o666);
    await proxy.listen();
    await writeFile(join(inputDir, "code", "test_case.py"), code);
    await writeFile(
      join(inputDir, "python.json"),
      JSON.stringify({
        attemptId,
        nonce,
        files: ["test_case.py"],
        baseUrl,
        imageId,
        timeoutMs: 45000,
      }),
    );
    const result = await new DockerExecutor().execute({
      attemptId,
      runId: `run_${randomUUID()}`,
      kind: "python",
      imageId,
      inputDir,
      socketsDir,
      seccompPath: resolve("containers/seccomp_profile.json"),
      command: ["--input", "/run/testmaster/input/python.json"],
      attemptTimeoutMs: 50000,
    });
    await streamEnded;
    expect(errors).toEqual([]);
    expect(validator.exit().complete).toBe(true);
    const terminal = events.find((event) => event.type === "runner.finished");
    if (terminal?.type !== "runner.finished") throw new Error(result.stderr.toString());
    const metadataBegin = events.find(
      (event) =>
        event.type === "artifact.begin" && event.payload.relativePath === "python/runtime.json",
    );
    if (metadataBegin?.type !== "artifact.begin") throw new Error("runtime metadata missing");
    const metadata = JSON.parse(
      Buffer.concat(artifacts.get(metadataBegin.payload.artifactId) ?? []).toString(),
    );
    expect(metadata.imageId).toBe(imageId);
    expect(metadata.packages).toEqual({
      pytest: "9.1.1",
      "pytest-asyncio": "1.4.0",
      requests: "2.34.2",
      playwright: "1.63.0",
    });
    expect(result.facts.networkMode).toBe("none");
    expect(result.facts.user).toBe("1000:1000");
    return { terminal: terminal.payload, events, result };
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise<void>((resolve) => protocol.close(() => resolve()));
    await proxy.close();
    await shop.close();
    await rm(directory, { recursive: true, force: true });
  }
}

it("pytest requests detects degraded health using real isolated proxy traffic", async () => {
  const code = await readFile(resolve("python/tests/docker/test_requests.py"), "utf8");
  expect((await runPython(code)).terminal.outcome).toBe("passed");
  const mutant = await runPython(code, "health-degraded");
  expect(mutant.terminal.outcome).toBe("failed");
  expect(
    mutant.events.some(
      (event) => event.type === "step.finished" && event.payload.status === "failed",
    ),
  ).toBe(true);
}, 120000);

it("pytest sync and async Playwright detect missing password validation", async () => {
  const code = await readFile(resolve("python/tests/docker/test_browser.py"), "utf8");
  expect((await runPython(code)).terminal.outcome).toBe("passed");
  expect((await runPython(code, "no-password-validation")).terminal.outcome).toBe("failed");
}, 150000);

it("Python raw sockets cannot bypass egress and missing dependencies never download", async () => {
  const code = await readFile(resolve("python/tests/docker/test_isolation.py"), "utf8");
  expect((await runPython(code)).terminal.outcome).toBe("passed");
  const missing = await runPython(
    "import testmaster_missing_package_3939\ndef test_unused(): assert True\n",
  );
  expect(missing.terminal.outcome).toBe("blocked");
  expect(
    missing.events.some(
      (event) => event.type === "log" && event.payload.message.includes("missing_package"),
    ),
  ).toBe(true);
}, 120000);

it("Python subprocess cannot install dependencies or restore download tools at runtime", async () => {
  const result = await runPython(`import importlib.util
import subprocess
import sys

def test_runtime_install_is_denied():
    assert importlib.util.find_spec('pip') is None
    commands = [
        [sys.executable, '-m', 'pip', 'install', 'testmaster_unapproved_dependency'],
        [sys.executable, '-m', 'ensurepip'],
        ['pip', 'install', 'testmaster_unapproved_dependency'],
        ['uv', 'pip', 'install', 'testmaster_unapproved_dependency'],
        ['npm', 'install', 'testmaster_unapproved_dependency'],
    ]
    for command in commands:
        try:
            result = subprocess.run(command, capture_output=True, timeout=15)
            assert result.returncode != 0, command
        except FileNotFoundError:
            pass
    assert importlib.util.find_spec('testmaster_unapproved_dependency') is None
`);
  expect(result.terminal.outcome).toBe("passed");
  expect(result.result.facts.imageId).toMatch(/^sha256:[a-f0-9]{64}$/u);
}, 90000);
