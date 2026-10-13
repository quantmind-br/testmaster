/**
 * Test-only fixtures for notification delivery: a throw-away TLS CA, an HTTPS receiver with
 * programmable behaviour, a small SMTP server (implicit TLS, STARTTLS or plain) and a reference
 * webhook consumer. Nothing here is imported by production code.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { join } from "node:path";
import { createSecureContext, createServer as createTlsServer, TLSSocket } from "node:tls";
import { promisify } from "node:util";
import type { EgressOptions } from "../notifications/https.js";
import { verifyNotification } from "../notifications/signature.js";

const exec = promisify(execFile);
function portOf(server: { address(): AddressInfo | string | null }): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server is not listening");
  return address.port;
}

export interface TestTls {
  readonly caPem: string;
  readonly keyPem: string;
  readonly certPem: string;
}

/** A CA plus a `127.0.0.1` leaf signed by it, so clients verify certificates instead of disabling checks. */
export async function createTestTls(directory: string): Promise<TestTls> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = (name: string) => join(directory, name);
  const openssl = (...args: string[]) => exec("openssl", args, { cwd: directory });
  await openssl(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    file("ca.key"),
    "-out",
    file("ca.pem"),
    "-subj",
    "/CN=TestMaster Notification Test CA",
    "-days",
    "2",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  );
  await openssl(
    "req",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    file("leaf.key"),
    "-out",
    file("leaf.csr"),
    "-subj",
    "/CN=127.0.0.1",
  );
  await writeFile(
    file("leaf.ext"),
    [
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=serverAuth",
    ].join("\n"),
  );
  await openssl(
    "x509",
    "-req",
    "-in",
    file("leaf.csr"),
    "-CA",
    file("ca.pem"),
    "-CAkey",
    file("ca.key"),
    "-CAcreateserial",
    "-out",
    file("leaf.pem"),
    "-days",
    "2",
    "-extfile",
    file("leaf.ext"),
  );
  return {
    caPem: await readFile(file("ca.pem"), "utf8"),
    keyPem: await readFile(file("leaf.key"), "utf8"),
    certPem: await readFile(file("leaf.pem"), "utf8"),
  };
}

/** Egress options that trust the test CA and open exactly the given loopback ports. */
export function loopbackEgress(tls: TestTls, ports: readonly number[] = []): EgressOptions {
  return {
    ca: tls.caPem,
    privateTargets: ports.map((port) => ({ hostname: "127.0.0.1", cidr: "127.0.0.0/8", port })),
    timeoutMs: 2000,
  };
}
/** Adds a loopback exception for one more receiver to an existing options object (read at call time). */
export function allowLoopbackPort(egress: EgressOptions, port: number): void {
  egress.privateTargets = [
    ...(egress.privateTargets ?? []),
    { hostname: "127.0.0.1", cidr: "127.0.0.0/8", port },
  ];
}

export interface ReceivedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}
export interface ReceiverReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Read the request, then never answer (the client times out after it sent everything). */
  hang?: boolean;
  /** Read the request, then drop the connection without a response. */
  destroy?: boolean;
}
export interface HttpsReceiver {
  readonly origin: string;
  readonly port: number;
  readonly url: string;
  readonly requests: ReceivedRequest[];
  /** Decides each response; defaults to 200. The second argument is the 1-based request number. */
  behave: (decide: (request: ReceivedRequest, count: number) => ReceiverReply) => void;
  close(): Promise<void>;
}

export async function startHttpsReceiver(tls: TestTls, path = "/hook"): Promise<HttpsReceiver> {
  const requests: ReceivedRequest[] = [];
  const hanging: Array<() => void> = [];
  let decide: (request: ReceivedRequest, count: number) => ReceiverReply = () => ({ status: 200 });
  const server: HttpsServer = createHttpsServer(
    { key: tls.keyPem, cert: tls.certPem },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(req.headers))
          if (typeof value === "string") headers[name] = value;
        const received: ReceivedRequest = {
          method: req.method ?? "",
          path: req.url ?? "",
          headers,
          body: Buffer.concat(chunks),
        };
        requests.push(received);
        const reply = decide(received, requests.length);
        if (reply.hang) {
          hanging.push(() => res.destroy());
          return;
        }
        if (reply.destroy) {
          req.socket.destroy();
          return;
        }
        res.writeHead(reply.status ?? 200, reply.headers ?? {});
        res.end(reply.body ?? "ok");
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = portOf(server);
  return {
    origin: `https://127.0.0.1:${port}`,
    port,
    url: `https://127.0.0.1:${port}${path}`,
    requests,
    behave: (next) => {
      decide = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const release of hanging) release();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface SmtpMessage {
  from: string;
  recipients: string[];
  data: string;
  authUser: string | null;
}
export interface SmtpServerOptions {
  mode: "tls" | "starttls" | "plain";
  user: string;
  password: string;
  /** Reply to the end of DATA; default `250 queued`. */
  dataReply?: () => string | null;
}
export interface SmtpServer {
  readonly port: number;
  readonly messages: SmtpMessage[];
  /** Number of connections that completed the greeting. */
  readonly sessions: () => number;
  setDataReply(reply: () => string | null): void;
  close(): Promise<void>;
}

/** A tiny SMTP server: AUTH PLAIN/LOGIN, one message per transaction, programmable DATA reply. */
export async function startSmtpServer(
  tls: TestTls,
  options: SmtpServerOptions,
): Promise<SmtpServer> {
  const messages: SmtpMessage[] = [];
  const sockets = new Set<Socket>();
  let sessions = 0;
  let dataReply = options.dataReply ?? (() => "250 queued");
  const context = createSecureContext({ key: tls.keyPem, cert: tls.certPem });

  function converse(socket: Socket, secured: boolean) {
    let buffer = "";
    let mode: "command" | "data" | "auth-user" | "auth-pass" = "command";
    let from = "";
    let recipients: string[] = [];
    let data = "";
    let user: string | null = null;
    let authed = false;
    const send = (line: string) => socket.write(`${line}\r\n`);
    const decode = (text: string) => Buffer.from(text, "base64").toString("utf8");
    const finishAuth = (name: string, password: string) => {
      if (name === options.user && password === options.password) {
        authed = true;
        user = name;
        send("235 authenticated");
      } else send("535 authentication failed");
    };
    send("220 test ESMTP");
    sessions += 1;
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (mode === "data") {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          mode = "command";
          const reply = dataReply();
          if (reply === null) return;
          if (reply.startsWith("250")) messages.push({ from, recipients, data, authUser: user });
          send(reply);
          from = "";
          recipients = [];
          data = "";
          continue;
        }
        const newline = buffer.indexOf("\r\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        if (mode === "auth-user") {
          user = decode(line);
          mode = "auth-pass";
          send("334 UGFzc3dvcmQ6");
          continue;
        }
        if (mode === "auth-pass") {
          mode = "command";
          finishAuth(user ?? "", decode(line));
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          const lines = ["250-test", "250-AUTH PLAIN LOGIN"];
          if (options.mode === "starttls" && !secured) lines.push("250-STARTTLS");
          lines.push("250 8BITMIME");
          socket.write(`${lines.join("\r\n")}\r\n`);
        } else if (upper === "STARTTLS" && options.mode === "starttls" && !secured) {
          send("220 ready");
          socket.removeAllListeners("data");
          const upgraded = new TLSSocket(socket, { isServer: true, secureContext: context });
          sockets.add(upgraded);
          converse(upgraded, true);
          return;
        } else if (upper.startsWith("AUTH PLAIN")) {
          const [, name = "", password = ""] = decode(line.slice(11)).split("\0");
          finishAuth(name, password);
        } else if (upper.startsWith("AUTH LOGIN")) {
          mode = "auth-user";
          send("334 VXNlcm5hbWU6");
        } else if (upper.startsWith("MAIL FROM")) {
          if (!authed) send("530 authentication required");
          else {
            from = line.slice(10).replace(/[<>]/gu, "").trim();
            send("250 ok");
          }
        } else if (upper.startsWith("RCPT TO")) {
          recipients.push(line.slice(8).replace(/[<>]/gu, "").trim());
          send("250 ok");
        } else if (upper === "DATA") {
          mode = "data";
          send("354 go ahead");
        } else if (upper === "QUIT") {
          send("221 bye");
          socket.end();
          return;
        } else if (upper === "RSET" || upper === "NOOP") send("250 ok");
        else send("502 unsupported");
      }
    });
    socket.on("error", () => {});
  }

  const server: NetServer =
    options.mode === "tls"
      ? createTlsServer({ key: tls.keyPem, cert: tls.certPem }, (socket) => {
          sockets.add(socket);
          converse(socket, true);
        })
      : createNetServer((socket) => {
          sockets.add(socket);
          converse(socket, false);
        });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: portOf(server),
    messages,
    sessions: () => sessions,
    setDataReply: (reply) => {
      dataReply = reply;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export interface ConsumerResult {
  status: 200 | 401;
  outcome: "accepted" | "duplicate" | "rejected";
  reason?: string;
}
/**
 * Reference consumer (INT-027): validates the original bytes against the shared secret(s),
 * rejects tampering and stale timestamps, and dedupes on the delivery ID.
 */
export function createReferenceConsumer(
  secrets: readonly string[],
  now: () => Date = () => new Date(),
) {
  const seen = new Set<string>();
  const accepted: Array<{ deliveryId: string; body: Buffer }> = [];
  return {
    accepted,
    handle(request: ReceivedRequest): ConsumerResult {
      const deliveryId = request.headers["testmaster-delivery-id"] ?? "";
      const verdict = verifyNotification({
        header: request.headers["testmaster-signature"],
        deliveryId,
        body: request.body,
        secrets,
        now: now(),
      });
      if (!verdict.valid) return { status: 401, outcome: "rejected", reason: verdict.reason };
      if (seen.has(deliveryId)) return { status: 200, outcome: "duplicate" };
      seen.add(deliveryId);
      accepted.push({ deliveryId, body: request.body });
      return { status: 200, outcome: "accepted" };
    },
  };
}
