import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { buildSchema, graphql } from "graphql";

export const mutants = Object.freeze(["server-error-on-negative-limit"]);

/** Absolute location of the SDL served by `startGraphql`. */
export const schemaUrl = new URL("../schema.graphql", import.meta.url);

const catalog = Object.freeze([
  { id: "p-1", name: "Notebook", priceCents: 1250 },
  { id: "p-2", name: "Pencil", priceCents: 150 },
  { id: "p-3", name: "Backpack", priceCents: 4900 },
]);

const maxBodyBytes = 1024 * 1024;

/** Raised by the defective resolver; the HTTP layer turns it into a 500 response. */
class InjectedServerError extends Error {}

class PayloadTooLarge extends Error {}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new PayloadTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const send = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
};

/**
 * @typedef {object} GraphqlInstance
 * @property {string} url Endpoint URL, including the `/graphql` path.
 * @property {() => Promise<void>} close
 */
/** @returns {Promise<GraphqlInstance>} */
export async function startGraphql({ port = 0, host = "127.0.0.1", mutant = "healthy" } = {}) {
  if (mutant !== "healthy" && !mutants.includes(mutant))
    throw new Error(`Unknown mutant: ${mutant}`);
  const schema = buildSchema(await readFile(schemaUrl, "utf8"));
  const rootValue = {
    products: ({ limit }) => {
      if (limit !== undefined && limit !== null && limit < 0) {
        if (mutant === "server-error-on-negative-limit") throw new InjectedServerError();
        return [];
      }
      return limit === undefined || limit === null ? [...catalog] : catalog.slice(0, limit);
    },
    product: ({ id }) => catalog.find((product) => product.id === id) ?? null,
  };
  const server = createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url, "http://graphql.invalid");
      if (pathname !== "/graphql")
        return send(response, 404, { errors: [{ message: "Not found" }] });
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        return send(response, 405, { errors: [{ message: "Only POST is supported" }] });
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(request));
      } catch (error) {
        if (error instanceof PayloadTooLarge)
          return send(response, 413, { errors: [{ message: "Payload too large" }] });
        return send(response, 400, { errors: [{ message: "Body must be valid JSON" }] });
      }
      if (
        typeof payload?.query !== "string" ||
        (payload.variables !== undefined &&
          payload.variables !== null &&
          (typeof payload.variables !== "object" || Array.isArray(payload.variables)))
      )
        return send(response, 400, {
          errors: [{ message: "Expected a JSON object with a string query and object variables" }],
        });
      const result = await graphql({
        schema,
        source: payload.query,
        rootValue,
        variableValues: payload.variables ?? undefined,
        operationName:
          typeof payload.operationName === "string" ? payload.operationName : undefined,
      });
      if (result.errors?.some((error) => error.originalError instanceof InjectedServerError))
        return send(response, 500, { errors: [{ message: "Internal server error" }] });
      return send(response, 200, result);
    } catch {
      return send(response, 500, { errors: [{ message: "Internal server error" }] });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  let closed = false;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${server.address().port}/graphql`,
    async close() {
      if (closed) return;
      closed = true;
      server.closeIdleConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
