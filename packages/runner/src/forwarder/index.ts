import { connect, createServer, type Socket } from "node:net";

export async function startForwarder(
  socketPath: string,
  port = 3128,
): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    return socket;
  };
  const server = createServer((client) => {
    track(client);
    const upstream = track(connect(socketPath));
    upstream.on("connect", () => client.pipe(upstream).pipe(client));
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  server.maxConnections = 128;
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(port, "127.0.0.1", () => {
    server.off("error", listening.reject);
    listening.resolve();
  });
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("forwarder_address_unavailable");
  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}
