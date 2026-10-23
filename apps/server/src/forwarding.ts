import { randomUUID } from "node:crypto";
import {
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  STATUS_CODES,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { type Duplex, Transform, type TransformCallback } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { type Application, FORWARDED_HEADER, type ForwardTarget } from "@testmaster/application";
import {
  ContractError,
  errorBody,
  errorRegistry,
  REMOTE_WORKER_BODY_LIMIT_BYTES,
} from "@testmaster/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { holdConnectionOpen } from "./routes/authoring.js";

/** Headers that belong to one connection, not to the message a proxy relays. */
const connectionHeaders: Record<string, true> = {
  connection: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
  expect: true,
};
const STREAM_PATH = /^\/v1\/workers\/wrk_[0-9a-f-]+\/attempts\/(att_[0-9a-f-]+)\/tunnel(?:\?|$)/;
/** Connection failures that mean the holder is gone, not slow: its in-memory Attempt is lost. */
const holderGone: Record<string, true> = {
  ECONNREFUSED: true,
  ENOTFOUND: true,
  EHOSTUNREACH: true,
  ENETUNREACH: true,
};

/** Ends a body that outgrows its allowance; the holder bounds an uploaded bundle by the Attempt's limits. */
class BodyLimit extends Transform {
  private seen = 0;
  constructor(private readonly limit: number) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.seen += chunk.length;
    if (this.seen > this.limit)
      done(new ContractError("PAYLOAD_TOO_LARGE", "Request body exceeds the limit"));
    else done(null, chunk);
  }
}

/** Writes an HTTP refusal with the API's error envelope on a raw socket and closes it. */
function refuse(socket: Duplex, failure: ContractError): void {
  const status = errorRegistry[failure.code].httpStatus;
  const body = JSON.stringify({
    schemaVersion: "1.0.0",
    requestId: randomUUID(),
    error: errorBody(failure),
  });
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  );
}

/**
 * Cross-controller traffic of the distributed profile (ADR-035). A worker's call for an Attempt,
 * or a worker's tunnel stream, that reaches a controller which does not hold what it needs is
 * relayed byte for byte to the live controller that does. The worker's own signed proof travels
 * with it and only the holder verifies it, so the forwarder cannot mint, alter or consume a proof.
 * The hop header names the forwarder and only ever suppresses a second forward: a request that
 * carries it, from anyone, is answered here with the ordinary lost-hold answer.
 */
export class Forwarder {
  constructor(private readonly application: Application) {}

  /**
   * Relays a worker's Attempt call to the controller that holds the Attempt, streaming the request
   * body out and the response back. Answers false when this controller answers the call itself.
   * Runs before the worker proof is read, so nothing is verified or consumed here.
   */
  async relay(request: FastifyRequest, reply: FastifyReply, attemptId: string): Promise<boolean> {
    if (request.headers[FORWARDED_HEADER] !== undefined) return false;
    const target = this.application.attemptForwardTarget(attemptId);
    if (!target) return false;
    const bundle = request.method === "PUT" && /\/bundle(?:\?|$)/.test(request.raw.url ?? "");
    // The agent's next action waits for a model, which has no deadline: this hop must not cut it either.
    if (request.method === "POST" && /\/actions(?:\?|$)/.test(request.raw.url ?? ""))
      holdConnectionOpen(reply);
    const declared = request.headers["content-length"];
    if (!bundle && declared !== undefined && Number(declared) > REMOTE_WORKER_BODY_LIMIT_BYTES)
      throw new ContractError("PAYLOAD_TOO_LARGE", "Request body exceeds the limit");
    await this.send(
      request,
      reply,
      target,
      attemptId,
      bundle ? null : REMOTE_WORKER_BODY_LIMIT_BYTES,
    );
    return true;
  }

  private send(
    request: FastifyRequest,
    reply: FastifyReply,
    target: ForwardTarget,
    attemptId: string,
    limit: number | null,
  ): Promise<void> {
    const origin = new URL(target.internalOrigin);
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(request.raw.headers))
      if (value !== undefined && !connectionHeaders[name]) headers[name] = value;
    headers[FORWARDED_HEADER] = this.application.controllerIdentity.id;
    const options: RequestOptions = {
      hostname: origin.hostname.replace(/^\[|\]$/g, ""),
      port: origin.port,
      method: request.method,
      // The path and query exactly as the worker signed them.
      path: request.raw.url ?? "/",
      headers,
      // Idle sockets are closed by the holder after 5 s; a reused one would reset a POST.
      agent: false,
    };
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const upstream = (origin.protocol === "https:" ? httpsRequest : httpRequest)(
      options,
      (response) => {
        reply.hijack();
        const outgoing: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(response.headers))
          if (value !== undefined && !connectionHeaders[name]) outgoing[name] = value;
        reply.raw.writeHead(response.statusCode ?? 502, response.statusMessage, outgoing);
        response.on("error", () => reply.raw.destroy());
        response.pipe(reply.raw);
        resolve();
      },
    );
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      if (reply.raw.headersSent) {
        reply.raw.destroy();
        return;
      }
      reject(
        error instanceof ContractError
          ? error
          : holderGone[error.code ?? ""]
            ? new ContractError(
                "PRECONDITION_FAILED",
                "The worker does not hold this Attempt's lease",
                {
                  reasonCode: "lease_lost",
                  attemptId,
                },
              )
            : new ContractError("UNAVAILABLE", "The controller holding the Attempt did not answer"),
      );
    });
    // A client that goes away ends the relayed call, so a held model wait does not outlive it.
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) upstream.destroy();
    });
    if (limit === null) request.raw.pipe(upstream);
    else {
      const bounded = new BodyLimit(limit);
      bounded.on("error", (error) => upstream.destroy(error));
      request.raw.pipe(bounded).pipe(upstream);
    }
    return promise;
  }

  /**
   * Proxies a worker's tunnel stream upgrade to the controller whose relay holds the tunnel
   * session. Answers false when this controller's relay serves it (or refuses it as lost).
   * The original request head, the worker's proof included, is replayed to the relay, which is
   * the only one to verify it; bytes then flow both ways until either side ends.
   */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const match = STREAM_PATH.exec(request.url ?? "");
    const attemptId = match?.[1];
    if (!attemptId || request.headers[FORWARDED_HEADER] !== undefined) return false;
    const target = this.application.tunnelStreamForwardTarget(attemptId);
    if (!target) return false;
    const origin = new URL(target.internalOrigin);
    const tls = origin.protocol === "https:";
    const host = origin.hostname.replace(/^\[|\]$/g, "");
    const port = Number(origin.port) || (tls ? 443 : 80);
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    for (let index = 0; index < request.rawHeaders.length; index += 2)
      lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
    lines.push(`${FORWARDED_HEADER}: ${this.application.controllerIdentity.id}`);
    let connected = false;
    const open = () => {
      connected = true;
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    };
    const upstream: Socket = tls
      ? tlsConnect({ host, port, servername: host }, open)
      : netConnect({ host, port }, open);
    const end = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", () => {
      // Nothing reached the relay: it is gone, so the worker is told the tunnel is lost.
      if (!connected && !socket.destroyed) {
        refuse(
          socket,
          new ContractError("FORBIDDEN", "The Attempt's Run has no live tunnel on this relay", {
            reasonCode: "tunnel_lost",
            attemptId,
          }),
        );
        upstream.destroy();
        return;
      }
      end();
    });
    upstream.on("close", () => connected && end());
    socket.on("close", end);
    return true;
  }
}
