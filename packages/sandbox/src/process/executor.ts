import { spawn } from "node:child_process";
import { connect, createServer, type Socket } from "node:net";
import { PolicyDenied } from "../egress/policy.js";

export interface ProcessOptions {
  unsafeLocal: boolean;
  allowUnsafeProcessExecution: boolean;
  singleUser: boolean;
  socketPath: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}
export async function executeUnsafeProcess(
  options: ProcessOptions,
  signal?: AbortSignal,
): Promise<{
  isolation: "none";
  warning: string;
  code: number;
  stdout: Buffer;
  stderr: Buffer;
  droppedBytes: number;
}> {
  if (!options.unsafeLocal || !options.allowUnsafeProcessExecution || !options.singleUser)
    throw new PolicyDenied("unsafe_process_opt_in_required");
  if (signal?.aborted) throw new PolicyDenied("attempt_cancelled");
  const sockets = new Set<Socket>();
  const proxy = createServer((client) => {
    const upstream = connect(options.socketPath);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
      socket.on("close", () => sockets.delete(socket));
    }
    upstream.on("connect", () => client.pipe(upstream).pipe(client));
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  proxy.maxConnections = 128;
  const listening = Promise.withResolvers<void>();
  proxy.once("error", listening.reject);
  proxy.listen(0, "127.0.0.1", () => {
    proxy.off("error", listening.reject);
    listening.resolve();
  });
  await listening.promise;
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("proxy_address_unavailable");
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  const child = spawn(options.executable, [...options.args], {
    cwd: options.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...options.env,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: "",
      no_proxy: "",
    },
  });
  const chunks: { stream: "stdout" | "stderr"; data: Buffer }[] = [];
  let bytes = 0;
  let droppedBytes = 0;
  const collect = (stream: "stdout" | "stderr", data: Buffer) => {
    chunks.push({ stream, data });
    bytes += data.length;
    while (bytes > 10 * 1024 * 1024) {
      const first = chunks.shift();
      if (!first) break;
      bytes -= first.data.length;
      droppedBytes += first.data.length;
    }
  };
  child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
  const kill = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  };
  signal?.addEventListener("abort", kill, { once: true });
  if (signal?.aborted) kill();
  const timer = setTimeout(kill, options.timeoutMs ?? 300000);
  timer.unref();
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 137));
    });
    return {
      isolation: "none",
      warning:
        "Unsafe local execution has user privileges and can bypass local network and filesystem controls",
      code,
      stdout: Buffer.concat(
        chunks.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.data),
      ),
      stderr: Buffer.concat(
        chunks.filter((chunk) => chunk.stream === "stderr").map((chunk) => chunk.data),
      ),
      droppedBytes,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
    kill();
    for (const socket of sockets) socket.destroy();
    const closed = Promise.withResolvers<void>();
    proxy.close(() => closed.resolve());
    await closed.promise;
  }
}
