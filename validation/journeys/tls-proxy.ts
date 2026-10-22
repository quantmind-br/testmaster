import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { createServer as createTlsServer, request as httpsRequest, type Server } from "node:https";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface TestCa {
  readonly directory: string;
  /** PEM of the CA that signed the leaf. Trusted by `HttpsClient`. */
  readonly caPem: string;
  readonly leafKey: string;
  readonly leafCert: string;
  /** base64 SHA-256 of the leaf SubjectPublicKeyInfo, for Chromium `--ignore-certificate-errors-spki-list`. */
  readonly spkiSha256: string;
}

/**
 * A throw-away CA and a `127.0.0.1`/`localhost` leaf, so browsers and clients exercise the same TLS
 * path as production (`Secure` cookies, `__Host-` prefix, HSTS-free but https-only) without
 * disabling certificate verification. Uses the system `openssl`.
 */
export async function createTestCa(directory: string): Promise<TestCa> {
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
    "/CN=TestMaster Test CA",
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
  const leafCert = await readFile(file("leaf.pem"), "utf8");
  const spki = new X509Certificate(leafCert).publicKey.export({ type: "spki", format: "der" });
  return {
    directory,
    caPem: await readFile(file("ca.pem"), "utf8"),
    leafKey: await readFile(file("leaf.key"), "utf8"),
    leafCert,
    spkiSha256: createHash("sha256").update(spki).digest("base64"),
  };
}

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export interface TlsProxy {
  /** `https://127.0.0.1:<port>` */
  readonly origin: string;
  readonly port: number;
  /** Requests seen, as `METHOD path`, for assertions about what the browser called. */
  readonly requests: string[];
  /** Every byte that crossed an upgraded connection, both directions, for confidentiality checks. */
  upgradedTraffic(): Buffer;
  /** Drops every open connection (live SSE streams included) while the listener keeps accepting new ones. */
  severConnections(): void;
  close(): Promise<void>;
}

/**
 * TLS-terminating reverse proxy in front of an HTTP upstream, standing in for Caddy. It forwards
 * `X-Forwarded-Proto: https` and the client address, replacing anything the client sent, exactly
 * as a trusted proxy must. Responses stream, so server-sent events work, and upgrades (`101`)
 * are relayed byte for byte, as Caddy's `reverse_proxy` relays them.
 */
export async function startTlsProxy(options: {
  ca: TestCa;
  /** Resolved per request: the upstream port is only known after the server starts. */
  upstreamPort: () => number;
}): Promise<TlsProxy> {
  const requests: string[] = [];
  const traffic: Buffer[] = [];
  const upgradedSockets = new Set<Duplex>();
  const forwardedHeaders = (incoming: IncomingMessage) => {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(incoming.headers))
      if (value !== undefined && !hopByHop.has(name) && !name.startsWith("x-forwarded-"))
        headers[name] = value;
    headers.host = incoming.headers.host ?? "";
    headers["x-forwarded-proto"] = "https";
    headers["x-forwarded-for"] = incoming.socket.remoteAddress ?? "127.0.0.1";
    return headers;
  };
  const statusHead = (response: IncomingMessage) => {
    const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage ?? ""}`];
    for (let index = 0; index < response.rawHeaders.length; index += 2)
      lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
    return `${lines.join("\r\n")}\r\n\r\n`;
  };
  const server: Server = createTlsServer(
    { key: options.ca.leafKey, cert: options.ca.leafCert },
    (incoming, outgoing) => {
      requests.push(`${incoming.method} ${incoming.url}`);
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: options.upstreamPort(),
          method: incoming.method,
          path: incoming.url,
          headers: forwardedHeaders(incoming),
        },
        (response) => {
          const forwarded: Record<string, string | string[]> = {};
          for (const [name, value] of Object.entries(response.headers))
            if (value !== undefined && !hopByHop.has(name)) forwarded[name] = value;
          outgoing.writeHead(response.statusCode ?? 502, forwarded);
          response.pipe(outgoing);
        },
      );
      upstream.on("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "text/plain" });
        outgoing.end("upstream unavailable");
      });
      outgoing.on("close", () => upstream.destroy());
      incoming.pipe(upstream);
    },
  );
  server.on("upgrade", (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
    requests.push(`${incoming.method} ${incoming.url}`);
    socket.on("error", () => socket.destroy());
    const upstream = httpRequest({
      host: "127.0.0.1",
      port: options.upstreamPort(),
      method: incoming.method,
      path: incoming.url,
      headers: {
        ...forwardedHeaders(incoming),
        connection: "Upgrade",
        upgrade: incoming.headers.upgrade ?? "",
      },
    });
    upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
      upstreamSocket.on("error", () => upstreamSocket.destroy());
      socket.write(statusHead(response));
      const relay = (from: Duplex, to: Duplex, first: Buffer) => {
        upgradedSockets.add(from);
        if (first.length) {
          traffic.push(Buffer.from(first));
          to.write(first);
        }
        from.on("data", (chunk: Buffer) => {
          traffic.push(Buffer.from(chunk));
          to.write(chunk);
        });
        from.on("close", () => {
          upgradedSockets.delete(from);
          to.destroy();
        });
      };
      relay(upstreamSocket, socket, upstreamHead);
      relay(socket, upstreamSocket, head);
    });
    upstream.on("response", (response) => {
      socket.write(statusHead(response));
      response.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TLS proxy has no port");
  return {
    origin: `https://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    upgradedTraffic: () => Buffer.concat(traffic),
    severConnections() {
      server.closeAllConnections();
      for (const socket of upgradedSockets) socket.destroy();
    },
    async close() {
      server.closeAllConnections();
      for (const socket of upgradedSockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface HttpsResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
  json<T = unknown>(): T;
}

/** Node `fetch` cannot be pointed at a private CA per call; this small client can. */
export class HttpsClient {
  private cookie: string | null = null;
  csrfToken: string | null = null;

  constructor(
    private readonly origin: string,
    private readonly ca: string,
  ) {}

  request(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string>; cookies?: boolean } = {},
  ): Promise<HttpsResponse> {
    const url = new URL(path, this.origin);
    const payload = options.body === undefined ? null : JSON.stringify(options.body);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(payload === null ? {} : { "content-type": "application/json" }),
      ...options.headers,
    };
    if (options.cookies !== false && this.cookie) headers.cookie = this.cookie;
    const { promise, resolve, reject } = Promise.withResolvers<HttpsResponse>();
    const call = httpsRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
        ca: this.ca,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const session = [response.headers["set-cookie"] ?? []]
            .flat()
            .map((value) => value.split(";")[0] ?? "")
            .find((value) => value.startsWith("__Host-tm_session="));
          if (session !== undefined && options.cookies !== false)
            this.cookie = session === "__Host-tm_session=" ? null : session;
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text,
            json: <T>() => JSON.parse(text) as T,
          });
        });
      },
    );
    call.on("error", reject);
    if (payload !== null) call.write(payload);
    call.end();
    return promise;
  }

  /** Mutating call as the signed-in user: CSRF token, Origin and an idempotency key. */
  mutate(method: string, path: string, body: unknown, extra: Record<string, string> = {}) {
    return this.request(method, path, {
      body,
      headers: {
        origin: this.origin,
        "idempotency-key": crypto.randomUUID(),
        ...(this.csrfToken ? { "x-csrf-token": this.csrfToken } : {}),
        ...extra,
      },
    });
  }
}
