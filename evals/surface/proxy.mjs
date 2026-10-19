// Recording reverse proxy between an agent and its model provider. Each request is forwarded
// unchanged and streamed back unchanged; the proxy stores the exact request body and appends one
// NDJSON record with what the request carried (tools, system prompt) and the usage the provider
// reported. It never times out a request: a model call runs until the provider answers or the
// agent disconnects.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** The tools a request announces, in the OpenAI chat, OpenAI responses and Anthropic shapes. */
function announcedTools(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.map((tool) => {
    const fn = tool.function ?? tool;
    const schema = fn.parameters ?? fn.input_schema ?? fn.inputSchema ?? null;
    return {
      name: String(fn.name ?? tool.type ?? "unknown"),
      bytes: Buffer.byteLength(JSON.stringify(tool)),
      schemaBytes: schema === null ? 0 : Buffer.byteLength(JSON.stringify(schema)),
      descriptionBytes: Buffer.byteLength(String(fn.description ?? "")),
    };
  });
}

function systemText(body) {
  const parts = [];
  const add = (value) => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value))
      for (const item of value)
        add(typeof item === "string" ? item : (item?.text ?? item?.content));
  };
  add(body.system);
  add(body.instructions);
  for (const message of Array.isArray(body.messages) ? body.messages : [])
    if (message.role === "system" || message.role === "developer") add(message.content);
  for (const item of Array.isArray(body.input) ? body.input : [])
    if (item?.role === "system" || item?.role === "developer") add(item.content);
  return parts.join("\n");
}

/** Usage from a JSON body or from every `data:` line of an SSE stream; later values win. */
export function reportedUsage(text) {
  const usage = {};
  const merge = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.usage && typeof value.usage === "object") Object.assign(usage, flatten(value.usage));
    if (value.message?.usage) Object.assign(usage, flatten(value.message.usage));
    if (value.response?.usage) Object.assign(usage, flatten(value.response.usage));
  };
  const candidates = text.includes("data:")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
    : [text];
  for (const candidate of candidates) {
    try {
      merge(JSON.parse(candidate));
    } catch {
      // Not JSON (for example the SSE terminator `[DONE]`).
    }
  }
  return usage;
}

/** The model the provider says answered (its fingerprint), from a JSON body or an SSE stream. */
export function reportedModel(text) {
  let model = null;
  const lines = text.includes("data:")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
    : [text];
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      const reported = value?.model ?? value?.response?.model ?? value?.message?.model;
      if (typeof reported === "string") model = reported;
    } catch {
      // Not JSON (for example the SSE terminator `[DONE]`).
    }
  }
  return model;
}

function flatten(value, prefix = "") {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === "object") Object.assign(out, flatten(item, name));
    else if (typeof item === "number") out[name] = item;
  }
  return out;
}

/**
 * Starts the proxy on a loopback port. `upstream` is the provider base URL the agent would have
 * used (for example https://api.quantforge.com.br); the agent's path is appended to it. With
 * `apiKey`, the proxy sends that credential upstream instead of the agent's, so the agent can hold
 * a placeholder and the real key never reaches a process the agent controls.
 */
export async function startProxy({ upstream, directory, marker = [], apiKey }) {
  mkdirSync(join(directory, "requests"), { recursive: true });
  const log = join(directory, "model-requests.ndjson");
  let seq = 0;
  const server = createServer(async (request, response) => {
    const id = ++seq;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    let body = {};
    try {
      body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      body = {};
    }
    writeFileSync(join(directory, "requests", `${id}.json`), raw);
    const tools = announcedTools(body);
    const system = systemText(body);
    const record = {
      seq: id,
      startedAt: new Date().toISOString(),
      method: request.method,
      path: request.url,
      model: body.model ?? null,
      requestBytes: raw.length,
      requestSha256: sha256(raw),
      systemBytes: Buffer.byteLength(system),
      // Literal strings whose presence tells which guidance reached the model (for example a
      // sentence of the installed skill).
      markers: Object.fromEntries(marker.map((text) => [text, raw.includes(text)])),
      toolCount: tools.length,
      toolBytes: tools.reduce((total, tool) => total + tool.bytes, 0),
      tools,
    };
    const headers = { ...request.headers };
    delete headers.host;
    delete headers["content-length"];
    delete headers["accept-encoding"];
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const received = [];
    let upstreamStatus = null;
    try {
      const upstreamResponse = await forward(new URL(request.url ?? "/", upstream), {
        method: request.method,
        headers,
        body: raw,
        agentResponse: response,
      });
      upstreamStatus = upstreamResponse.statusCode ?? null;
      const responseHeaders = { ...upstreamResponse.headers };
      delete responseHeaders["content-encoding"];
      delete responseHeaders["content-length"];
      delete responseHeaders["transfer-encoding"];
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      for await (const chunk of upstreamResponse) {
        received.push(chunk);
        response.write(chunk);
      }
      response.end();
      const text = Buffer.concat(received).toString("utf8");
      Object.assign(record, {
        status: upstreamResponse.statusCode,
        responseBytes: Buffer.byteLength(text),
        usage: reportedUsage(text),
        responseModel: reportedModel(text),
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      // An agent may close its side right after the last SSE event, before the upstream stream
      // ends: the usage chunk already received is still the provider's report.
      const text = Buffer.concat(received).toString("utf8");
      Object.assign(record, {
        status: upstreamStatus,
        error: String(error?.message ?? error),
        responseBytes: Buffer.byteLength(text),
        usage: reportedUsage(text),
        responseModel: reportedModel(text),
      });
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "surface proxy upstream failure" } }));
    }
    appendFileSync(log, `${JSON.stringify(record)}\n`);
  });
  // A model answer can take longer than Node's default request and keep-alive limits.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  server.timeout = 0;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    log,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Sends one request upstream with node:http(s), which has no header or body deadline (fetch would
 * cut an answer after undici's 300 s defaults). Only the agent disconnecting stops it.
 */
function forward(url, { method, headers, body, agentResponse }) {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = send(url, { method, headers }, resolve);
    outgoing.on("error", reject);
    // "close" also fires after a complete answer; destroying a finished request does nothing.
    agentResponse.on("close", () => {
      if (!agentResponse.writableFinished) outgoing.destroy(new Error("agent disconnected"));
    });
    if (body.length && !["GET", "HEAD"].includes(method ?? "GET")) outgoing.write(body);
    outgoing.end();
  });
}
