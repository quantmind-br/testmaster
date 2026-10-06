import { lookup } from "node:dns/promises";
import { appendFile, chmod, lstat, unlink } from "node:fs/promises";
import http from "node:http";
import { connect, type Socket } from "node:net";
import { Transform } from "node:stream";
import {
  type AuthorizedTarget,
  canonicalUrl,
  type EgressPolicy,
  PolicyDenied,
  type Resolver,
} from "./policy.js";

export interface ProxyOptions {
  socketPath: string;
  policy: EgressPolicy;
  resolver?: Resolver;
  logPath?: string;
  maxLogBytes?: number;
  requestTimeoutMs?: number;
  maxBodyBytes?: number;
}
export interface EgressDecision {
  origin: string | null;
  decision: "allow" | "deny";
  reason: string;
  pinnedIp?: string;
}
function boundedStream(limit: number): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > limit ? new PolicyDenied("body_limit") : null,
        bytes > limit ? undefined : chunk,
      );
    },
  });
}
function validateHeaders(
  request: http.IncomingMessage,
  target: AuthorizedTarget | undefined,
): void {
  const hosts = request.rawHeaders.filter(
    (_header, i) => i % 2 === 0 && request.rawHeaders[i]?.toLowerCase() === "host",
  );
  if (hosts.length !== 1 || !request.headers.host) throw new PolicyDenied("host_mismatch");
  for (const name of Object.keys(request.headers)) {
    // Chromium sends this hop-by-hop hint; never forward it or allow arbitrary tokens.
    if (
      name === "proxy-connection" &&
      ["keep-alive", "close"].includes(String(request.headers[name]).toLowerCase())
    )
      continue;
    if (
      name.startsWith("proxy-") ||
      name.startsWith("x-forwarded-") ||
      name === "forwarded" ||
      name === "via"
    )
      throw new PolicyDenied("header_override");
  }
  if (
    request.headers.connection
      ?.split(",")
      .some((name) => !["close", "keep-alive"].includes(name.trim().toLowerCase()))
  )
    throw new PolicyDenied("header_override");
  if (
    target &&
    canonicalUrl(`${target.protocol}://${request.headers.host}`).authority !== target.authority
  )
    throw new PolicyDenied("host_mismatch");
}
export class EgressProxy {
  private readonly sockets = new Set<Socket>();
  private readonly server: http.Server;
  private readonly resolver: Resolver;
  private closed = false;
  private logBytes = 0;
  private logQueue: Promise<void> = Promise.resolve();
  private logFailure: Error | undefined;
  droppedDecisions = 0;
  constructor(private readonly options: ProxyOptions) {
    this.resolver =
      options.resolver ??
      (async (hostname) =>
        (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address));
    this.server = http.createServer((request, response) => {
      void this.forward(request, response);
    });
    this.server.requestTimeout = options.requestTimeoutMs ?? 30000;
    this.server.headersTimeout = options.requestTimeoutMs ?? 30000;
    this.server.maxHeadersCount = 100;
    this.server.maxConnections = 128;
    this.server.on("connection", (socket) => this.track(socket));
    this.server.on("connect", (request, socket, head) => {
      void this.tunnel(request, socket as Socket, head);
    });
    this.server.on("upgrade", (_request, socket) => socket.destroy());
    this.server.on("clientError", (_error, socket) => socket.destroy());
  }
  private track(socket: Socket): Socket {
    this.sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.sockets.delete(socket));
    if (this.closed) socket.destroy();
    return socket;
  }
  private log(decision: EgressDecision): void {
    const line = `${JSON.stringify(decision)}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.logBytes + bytes > (this.options.maxLogBytes ?? 10 * 1024 * 1024)) {
      this.droppedDecisions++;
      return;
    }
    this.logBytes += bytes;
    if (this.options.logPath)
      this.logQueue = this.logQueue
        .then(() => appendFile(this.options.logPath as string, line, { mode: 0o600 }))
        .catch((error: unknown) => {
          this.logFailure = error instanceof Error ? error : new Error("egress_log_failed");
          this.closed = true;
          for (const socket of this.sockets) socket.destroy();
          this.server.close();
        });
  }
  private async authorize(input: string): Promise<AuthorizedTarget> {
    if (this.closed) throw new PolicyDenied("proxy_closed");
    return this.options.policy.authorize(input, this.resolver);
  }
  private async forward(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    let origin: string | null = null;
    try {
      const parsed = canonicalUrl(request.url ?? "");
      origin = parsed.origin;
      if (parsed.protocol !== "http") throw new PolicyDenied("absolute_https_requires_connect");
      validateHeaders(request, parsed as AuthorizedTarget);
      const target = await this.authorize(parsed.url);
      if (this.closed) throw new PolicyDenied("proxy_closed");
      const headers: http.OutgoingHttpHeaders = {
        ...request.headers,
        host: request.headers.host,
        connection: "close",
      };
      delete headers["proxy-connection"];
      const upstream = http.request(
        {
          hostname: target.pinnedIp,
          port: target.port,
          method: request.method,
          path: target.path,
          headers,
          agent: false,
        },
        (incoming) => {
          const safeHeaders = { ...incoming.headers };
          delete safeHeaders.connection;
          delete safeHeaders["proxy-authenticate"];
          response.writeHead(incoming.statusCode ?? 502, safeHeaders);
          const limiter = boundedStream(this.options.maxBodyBytes ?? 10 * 1024 * 1024);
          limiter.on("error", () => {
            incoming.destroy();
            response.destroy();
          });
          incoming.on("error", () => response.destroy());
          incoming.pipe(limiter).pipe(response);
        },
      );
      upstream.on("socket", (socket) => this.track(socket));
      upstream.setTimeout(this.options.requestTimeoutMs ?? 30000, () =>
        upstream.destroy(new Error("request_timeout")),
      );
      // A gateway transport failure is not an HTTP response from the target.
      upstream.on("error", () => response.destroy());
      request.on("aborted", () => upstream.destroy());
      response.on("close", () => upstream.destroy());
      const limiter = boundedStream(this.options.maxBodyBytes ?? 10 * 1024 * 1024);
      limiter.on("error", () => {
        upstream.destroy();
        response.destroy();
      });
      request.pipe(limiter).pipe(upstream);
      this.log({ origin, decision: "allow", reason: "allowed", pinnedIp: target.pinnedIp });
    } catch (error) {
      this.log({
        origin,
        decision: "deny",
        reason: error instanceof PolicyDenied ? error.reason : "proxy_error",
      });
      response.writeHead(403, { connection: "close" });
      response.end("POLICY_DENIED");
    }
  }
  private async tunnel(request: http.IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    let origin: string | null = null;
    try {
      const parsed = this.options.policy.connectTarget(request.url ?? "");
      origin = parsed.origin;
      validateHeaders(request, parsed as AuthorizedTarget);
      if (request.headers["content-length"] || request.headers["transfer-encoding"])
        throw new PolicyDenied("invalid_connect");
      const target = await this.authorize(parsed.url);
      if (this.closed) throw new PolicyDenied("proxy_closed");
      const upstream = this.track(connect({ host: target.pinnedIp, port: target.port }));
      upstream.setTimeout(this.options.requestTimeoutMs ?? 30000, () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
      upstream.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
        this.log({ origin, decision: "allow", reason: "allowed", pinnedIp: target.pinnedIp });
      });
    } catch (error) {
      this.log({
        origin,
        decision: "deny",
        reason: error instanceof PolicyDenied ? error.reason : "proxy_error",
      });
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  }
  async listen(): Promise<void> {
    if (this.closed) throw new PolicyDenied("proxy_closed");
    try {
      await lstat(this.options.socketPath);
      throw new PolicyDenied("socket_path_exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const listening = Promise.withResolvers<void>();
    this.server.once("error", listening.reject);
    this.server.listen(this.options.socketPath, () => {
      this.server.off("error", listening.reject);
      listening.resolve();
    });
    await listening.promise;
    await chmod(this.options.socketPath, 0o666);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    const closed = Promise.withResolvers<void>();
    this.server.close(() => closed.resolve());
    await closed.promise;
    await this.logQueue;
    await unlink(this.options.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (this.logFailure) throw this.logFailure;
  }
}
