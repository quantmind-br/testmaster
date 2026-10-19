// Local OpenAI-compatible upstream for the agent-target probe. It records every request body and
// answers chat completions with a fixed "ready" message, so an agent can finish one turn without a
// real provider. It never times out a request.
import { createServer } from "node:http";

export const STUB_MODEL = "tm-stub-model";

const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function chatCompletion(response, model, stream) {
  const id = "chatcmpl-tm-stub";
  const created = Math.floor(Date.now() / 1000);
  if (!stream) {
    json(response, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ready" },
          finish_reason: "stop",
        },
      ],
      usage,
    });
    return;
  }
  const chunk = (choice, extra = {}) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [choice], ...extra })}\n\n`;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(
    chunk({ index: 0, delta: { role: "assistant", content: "ready" }, finish_reason: null }),
  );
  response.write(chunk({ index: 0, delta: {}, finish_reason: "stop" }, { usage }));
  response.end("data: [DONE]\n\n");
}

async function answer(requests, request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const path = new URL(request.url ?? "/", "http://stub").pathname;
  requests.push({ method: request.method, path, raw });
  if (request.method === "GET" && path.endsWith("/models")) {
    json(response, 200, {
      object: "list",
      data: [{ id: STUB_MODEL, object: "model", created: 0, owned_by: "testmaster" }],
    });
    return;
  }
  if (request.method === "POST" && path.endsWith("/chat/completions")) {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    chatCompletion(
      response,
      typeof body.model === "string" ? body.model : STUB_MODEL,
      body.stream === true,
    );
    return;
  }
  json(response, 404, {
    error: { message: `stub upstream has no route ${request.method} ${path}`, type: "not_found" },
  });
}

/** Starts the stub on a loopback port; `base` is the OpenAI base URL including `/v1`. */
export async function startStubUpstream() {
  const requests = [];
  // Node does not await a request listener: an agent that disconnects mid-request must not turn
  // into an unhandled rejection that ends the whole probe.
  const server = createServer((request, response) => {
    answer(requests, request, response).catch(() => response.destroy());
  });
  // An agent may keep a connection open between requests; no Node default limit may cut it.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  server.timeout = 0;
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
  return {
    base: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
