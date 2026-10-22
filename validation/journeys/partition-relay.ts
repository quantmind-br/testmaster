import { connect, createServer as createTcpServer, type Server, type Socket } from "node:net";

export interface PartitionRelay {
  /** `https://127.0.0.1:<port>`: the TLS proxy's origin as seen through this relay. */
  readonly origin: string;
  /**
   * Blackholes the path: the client's open connections stay open but carry nothing and new ones
   * are never forwarded. The upstream side is reset unless `silentUpstream` keeps it open and
   * silent too, as when packets drop in both directions.
   */
  partition(options?: { silentUpstream?: boolean }): void;
  /** Resets the silent connections and forwards again. */
  heal(): void;
  close(): Promise<void>;
}

/**
 * A TCP relay between one client and the controller's TLS proxy. `partition()` blackholes it, as
 * when a network path drops packets: the client's connections neither close nor carry a byte.
 */
export async function startPartitionRelay(upstreamPort: number): Promise<PartitionRelay> {
  const silent = new Set<Socket>();
  const stalled = new Set<Socket>();
  const live = new Map<Socket, (silentUpstream: boolean) => void>();
  let cut = false;
  const server: Server = createTcpServer((client) => {
    client.on("error", () => undefined);
    if (cut) {
      client.pause();
      silent.add(client);
      return;
    }
    const upstream = connect(upstreamPort, "127.0.0.1");
    upstream.on("error", () => client.destroy());
    client.on("close", () => {
      // A blackholed path carries no FIN either: a stalled upstream outlives its client.
      if (!stalled.has(upstream)) upstream.destroy();
      live.delete(client);
      silent.delete(client);
    });
    upstream.on("close", () => {
      if (!silent.has(client)) client.destroy();
    });
    client.pipe(upstream);
    upstream.pipe(client);
    live.set(client, (silentUpstream) => {
      client.unpipe(upstream);
      upstream.unpipe(client);
      client.pause();
      silent.add(client);
      if (!silentUpstream) {
        upstream.destroy();
        return;
      }
      upstream.pause();
      stalled.add(upstream);
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("relay has no port");
  return {
    origin: `https://127.0.0.1:${address.port}`,
    partition(options = {}) {
      cut = true;
      for (const silence of live.values()) silence(options.silentUpstream === true);
      live.clear();
    },
    heal() {
      cut = false;
      for (const client of silent) client.destroy();
      for (const upstream of stalled) upstream.destroy();
      silent.clear();
      stalled.clear();
    },
    async close() {
      for (const socket of [...live.keys(), ...silent, ...stalled]) socket.destroy();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}
