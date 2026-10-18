// Transparent reverse proxy in front of an experiment target (PLAN.md §10, fidelity). Every agent
// session reaches the target through it, so the origin the tests are bound to stays the same when
// the proxy later serves a seed's injected defect (`setMutant`: response rules, or a defective
// instance as the upstream); `setMutant(null)` restores the clean target. Requests are forwarded unchanged,
// including Host, so the target builds its URLs for the proxy origin. No request has a deadline.
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** A rule matches a request by method, pathname (regex source) and exact query values. */
function matches(rule, method, url) {
  if (rule.method && rule.method !== method) return false;
  if (!new RegExp(rule.path).test(url.pathname)) return false;
  for (const [key, value] of Object.entries(rule.query ?? {}))
    if (url.searchParams.get(key) !== value) return false;
  return true;
}

/** Splits an RFC 6901 pointer into its unescaped tokens. */
const tokens = (pointer) =>
  pointer === ""
    ? []
    : pointer
        .slice(1)
        .split("/")
        .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));

function applyJson(document, { pointer, op, value }) {
  const path = tokens(pointer);
  if (path.length === 0) return op === "replace" ? value : document;
  let parent = document;
  for (const token of path.slice(0, -1)) {
    parent = parent?.[token];
    if (parent === undefined || parent === null) return document;
  }
  const last = path.at(-1);
  if (parent === null || typeof parent !== "object" || !(last in parent)) return document;
  if (op === "remove") {
    if (Array.isArray(parent)) parent.splice(Number(last), 1);
    else delete parent[last];
  } else if (op === "replace") parent[last] = value;
  else if (op === "emptyArray" && Array.isArray(parent[last])) parent[last] = [];
  else if (op === "eachRemove" && Array.isArray(parent[last]))
    for (const item of parent[last]) if (item && typeof item === "object") delete item[value];
  return document;
}

/** The defective response of one rule; `body` is the clean upstream body. */
export function mutate(rule, { status, headers, body }) {
  const out = { status, headers: { ...headers }, body };
  for (const action of rule.actions) {
    if (action.type === "status") out.status = action.status;
    else if (action.type === "dropHeader") delete out.headers[action.name.toLowerCase()];
    else if (action.type === "text")
      out.body = Buffer.from(out.body.toString("utf8").replaceAll(action.from, action.to));
    else if (action.type === "json") {
      let document;
      try {
        document = JSON.parse(out.body.toString("utf8"));
      } catch {
        continue;
      }
      out.body = Buffer.from(JSON.stringify(applyJson(document, action)));
    } else throw new Error(`Unknown mutation action ${action.type}`);
  }
  delete out.headers["content-encoding"];
  delete out.headers["transfer-encoding"];
  out.headers["content-length"] = String(out.body.length);
  return out;
}

/**
 * Starts the proxy on `port` (0 picks one) of 127.0.0.1. `upstream` is the target origin, for
 * example http://127.0.0.1:20411. `onRequest` receives `{method, path, status, mutated}`.
 */
export async function startTargetProxy({ upstream, port = 0, onRequest = () => {} }) {
  const clean = new URL(upstream);
  let target = clean;
  let send = target.protocol === "https:" ? httpsRequest : httpRequest;
  let rules = null;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://proxy");
    const rule = rules?.find((candidate) => matches(candidate, request.method, url));
    const headers = { ...request.headers };
    // A mutated response is rewritten, so ask the target for an uncompressed body.
    if (rule) delete headers["accept-encoding"];
    const upstreamRequest = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: request.method,
        path: request.url,
        headers,
      },
      (upstreamResponse) => {
        if (!rule) {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
          onRequest({
            method: request.method,
            path: url.pathname,
            status: upstreamResponse.statusCode,
            mutated: false,
          });
          return;
        }
        const chunks = [];
        upstreamResponse.on("data", (chunk) => chunks.push(chunk));
        upstreamResponse.on("end", () => {
          const out = mutate(rule, {
            status: upstreamResponse.statusCode ?? 502,
            headers: upstreamResponse.headers,
            body: Buffer.concat(chunks),
          });
          response.writeHead(out.status, out.headers);
          response.end(out.body);
          onRequest({
            method: request.method,
            path: url.pathname,
            status: out.status,
            mutated: true,
          });
        });
      },
    );
    upstreamRequest.on("error", (error) => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end(`target proxy: ${error.message}`);
    });
    request.pipe(upstreamRequest);
  });
  // Upgrades (WebSocket, HMR) are tunnelled byte for byte.
  server.on("upgrade", (request, socket, head) => {
    const upstreamRequest = send({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: request.headers,
    });
    upstreamRequest.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}`];
      for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2)
        lines.push(
          `${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}`,
        );
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    upstreamRequest.on("error", () => socket.destroy());
    upstreamRequest.end();
  });
  // A test may hold a request open as long as the target does.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 5_000;
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    /**
     * Serves a seed's defect: `{rules}` rewrites matching responses of the clean target and
     * `{upstream}` forwards everything to a defective instance instead (a fixture with built-in
     * mutants). `null` restores the clean target.
     */
    setMutant(mutant) {
      rules = mutant?.rules ?? null;
      target = mutant?.upstream ? new URL(mutant.upstream) : clean;
      send = target.protocol === "https:" ? httpsRequest : httpRequest;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
