import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startForwarder } from "./index.js";

it("forwards bytes over unix IPC and destroys active sockets on shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tm-forwarder-"));
  const path = join(directory, "egress.sock");
  const server = createServer((socket) => socket.pipe(socket));
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(path, listening.resolve);
  await listening.promise;
  const forwarder = await startForwarder(path, 0);
  const socket = connect({ host: "127.0.0.1", port: forwarder.port });
  socket.on("error", () => socket.destroy());
  try {
    const received = Promise.withResolvers<Buffer>();
    socket.once("data", received.resolve);
    socket.once("connect", () => socket.write("hello-unix"));
    expect((await received.promise).toString()).toBe("hello-unix");
    const closed = Promise.withResolvers<void>();
    socket.once("close", closed.resolve);
    await forwarder.close();
    await closed.promise;
  } finally {
    socket.destroy();
    await forwarder.close();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    await rm(directory, { recursive: true, force: true });
  }
});
