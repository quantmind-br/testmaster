import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Application,
  type AuthenticatedIdentity,
  auditSecurity,
  authenticateBearer,
  authenticateSession,
  correlationId,
  executeIdempotent,
  OperationalLogger,
  type ServerConfig,
  SignedCursorCodec,
  sessionCsrfMatches,
} from "@testmaster/application";
import {
  ContractError,
  errorRegistry,
  INBOUND_WEBHOOK_MAX_BYTES,
  parseStrictJson,
  routeCatalog,
  validate,
} from "@testmaster/contracts";
import { createMcpHttpHandler } from "@testmaster/mcp";
import fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HTTPMethods,
} from "fastify";
import { isPortalRequest, loadPortal, type PortalOptions, registerPortal } from "./portal.js";
import { buildRouteTable, type RouteContext } from "./routes/index.js";
import { cookieValue, csrfHeader, sessionCookieName, transportResolver } from "./transport.js";

export interface ServerOptions {
  application: Application;
  host?: string;
  mode?: "local" | "server";
  origins?: readonly string[];
  cursorTtlMs?: number;
  now?: () => number;
  mcp?: false;
  /** Deployment configuration; required (and only used) when `mode` is `"server"`. */
  server?: ServerConfig;
  mcpRoots?: readonly string[];
  /** Serve the built portal same-origin. `false` disables it; default: `apps/web/dist` if built. */
  portal?: false | PortalOptions;
}
export interface McpHttpContext {
  request: FastifyRequest;
  reply: FastifyReply;
  application: Application;
  identity: AuthenticatedIdentity;
}
export type McpHttpHandler = (context: McpHttpContext) => Promise<void>;
const contexts = new WeakMap<
  FastifyInstance,
  { options: ServerOptions; identities: WeakMap<FastifyRequest, AuthenticatedIdentity> }
>();
/** Per-route settings read by the authentication hook. */
interface RouteConfig {
  auth: "token" | "public" | "signature";
  /** Cookies are never read; `/mcp` is a bearer-only transport. */
  bearerOnly?: boolean;
}
interface PresentedCredential {
  kind: "bearer" | "session";
  secret: string;
}
/** Routes without explicit config (404s) are authenticated like any other route. */
function routeConfig(request: FastifyRequest): RouteConfig {
  // Fastify types route config as an open object; only routes registered here set these keys.
  const config = (request.routeOptions.config ?? {}) as Partial<RouteConfig>;
  return { auth: config.auth ?? "token", ...(config.bearerOnly ? { bearerOnly: true } : {}) };
}
export function registerMcpHttp(app: FastifyInstance, handler: McpHttpHandler): void {
  const ctx = contexts.get(app);
  if (!ctx) throw new Error("MCP requires a TestMaster server");
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    config: { auth: "token", bearerOnly: true } satisfies RouteConfig,
    handler: async (request, reply) => {
      const identity = ctx.identities.get(request);
      if (!identity) throw new ContractError("UNAUTHENTICATED", "Capability token required");
      await handler({
        request,
        reply,
        identity,
        application: ctx.options.application.forIdentity(identity, request.id),
      });
    },
  });
}
export function createServer(options: ServerOptions): FastifyInstance {
  const server = options.mode === "server" ? options.server : undefined;
  if (options.mode === "server" && !server)
    throw new ContractError("INVALID_ARGUMENT", "Server mode requires a server configuration");
  if (!server) {
    const host = options.host ?? "127.0.0.1";
    if (host !== "127.0.0.1")
      throw new ContractError("POLICY_DENIED", "Local server binds 127.0.0.1 only");
  }
  const app = fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024,
    requestTimeout: 30000,
    connectionTimeout: 30000,
    keepAliveTimeout: 5000,
  });
  const identities = new WeakMap<FastifyRequest, AuthenticatedIdentity>();
  const credentials = new WeakMap<FastifyRequest, PresentedCredential>();
  contexts.set(app, { options, identities });
  const portal = options.portal === false ? null : loadPortal(options.portal);
  const codec = new SignedCursorCodec(
    options.application,
    options.cursorTtlMs ?? 300000,
    options.now ?? Date.now,
  );
  const buckets = new Map<string, { tokens: number; at: number }>();
  const allowedOrigins = [
    ...(options.origins ?? []),
    ...(server ? [...server.server.origins, server.server.publicOrigin] : []),
  ];
  const resolveTransport = transportResolver(server?.server.trustedProxies ?? []);
  // The local profile has one failure budget for the whole loopback installation; neither token
  // guesses nor forwarding headers can create fresh buckets. Server mode budgets per client address.
  const authBudgets = new Map<string, { tokens: number; at: number }>();
  const takeBudget = (key: string) => {
    const now = (options.now ?? Date.now)();
    const budget = authBudgets.get(key) ?? { tokens: 20, at: now };
    budget.tokens = Math.min(20, budget.tokens + Math.max(0, now - budget.at) / 1000);
    budget.at = now;
    authBudgets.delete(key);
    authBudgets.set(key, budget);
    if (authBudgets.size > 10000) authBudgets.delete(authBudgets.keys().next().value as string);
    if (budget.tokens < 1) throw new ContractError("RATE_LIMITED", "Authentication rate exceeded");
    return budget;
  };
  app.removeContentTypeParser("application/json");
  // Signature routes verify the provider's HMAC over the exact bytes, so the parsers keep the raw
  // body and leave parsing and content-type policy to the adapter, after the signature check.
  const rawBodies = new WeakMap<FastifyRequest, Buffer>();
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    if (routeConfig(request).auth === "signature") {
      rawBodies.set(request, body as Buffer);
      done(null, null);
      return;
    }
    try {
      done(null, parseStrictJson(body as Buffer, 10 * 1024 * 1024));
    } catch (error) {
      done(error as Error);
    }
  });
  app.addContentTypeParser("*", { parseAs: "buffer" }, (request, body, done) => {
    if (routeConfig(request).auth === "signature") {
      rawBodies.set(request, body as Buffer);
      done(null, null);
      return;
    }
    done(Object.assign(new Error("Unsupported media type"), { statusCode: 415 }));
  });
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
    done(null, payload);
  });
  const logs = new OperationalLogger(
    join(options.application.config.dataDir, "logs", "api"),
    options.application.config.logRetentionDays,
    options.now ?? Date.now,
  );
  app.addHook("onClose", async () => logs.flush());
  app.addHook("onResponse", async (request, reply) => {
    logs.record({
      component: "api",
      event: "request.completed",
      correlationId: request.id,
      statusCode: reply.statusCode,
    });
  });
  app.addHook("onRequest", async (request, reply) => {
    request.id = correlationId();
    request.id = correlationId(request.headers["x-correlation-id"] ?? request.id);
    reply.header("X-Correlation-ID", request.id);
    if (portal && isPortalRequest(request.method, request.url)) return;
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.includes(origin))
      throw new ContractError("FORBIDDEN", "Origin is not allowed");
    if (request.url.split("?")[0] === "/v1/health/live") return;
    const view = server ? resolveTransport(request) : null;
    if (view && view.scheme !== "https")
      throw new ContractError("FORBIDDEN", "HTTPS is required", { reason: "tls_required" });
    const route = routeConfig(request);
    const budget = takeBudget(view?.clientIp ?? "local");
    // Public and signed routes never authenticate here, but every call spends the caller's budget.
    if (route.auth !== "token") {
      budget.tokens--;
      return;
    }
    const authorization = request.headers.authorization;
    const bearer = typeof authorization === "string" ? /^Bearer (\S+)$/.exec(authorization) : null;
    // Cookies are only read for browser sessions in server mode; a bearer header always wins.
    const cookie =
      server && !bearer && !route.bearerOnly
        ? cookieValue(request.headers.cookie, sessionCookieName)
        : null;
    // Requests that present no credential at all cannot guess anything, so they cost no budget in
    // server mode; the local profile keeps its single installation-wide failure budget.
    if (!bearer && !cookie) {
      if (!server) budget.tokens--;
      throw new ContractError("UNAUTHENTICATED", "A valid capability token is required");
    }
    let identity: AuthenticatedIdentity;
    try {
      identity = cookie
        ? authenticateSession(options.application, cookie)
        : authenticateBearer(options.application, bearer?.[1] ?? "");
    } catch (error) {
      budget.tokens--;
      throw error;
    }
    credentials.set(
      request,
      cookie ? { kind: "session", secret: cookie } : { kind: "bearer", secret: bearer?.[1] ?? "" },
    );
    if (cookie && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      // Cookie-authenticated writes must come from an allowed origin and echo the CSRF token.
      const supplied = request.headers[csrfHeader];
      if (
        !origin ||
        !sessionCsrfMatches(
          options.application,
          identity.credential.id,
          typeof supplied === "string" ? supplied : undefined,
        )
      )
        throw new ContractError("FORBIDDEN", "CSRF validation failed", { reason: "csrf" });
    }
    auditSecurity(
      options.application.forIdentity(identity).context,
      "auth",
      identity.credential.kind === "local" ? "local-api" : `${identity.credential.kind}-api`,
      "allowed",
      request.id,
    );
    identities.set(request, identity);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const now = Date.now();
      const bucket = buckets.get(identity.principalId) ?? { tokens: 20, at: now };
      bucket.tokens = Math.min(20, bucket.tokens + (now - bucket.at) / 1000);
      bucket.at = now;
      if (bucket.tokens < 1)
        throw new ContractError("RATE_LIMITED", "Actor admission rate exceeded");
      bucket.tokens--;
      buckets.set(identity.principalId, bucket);
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode;
    const failure =
      error instanceof ContractError
        ? error
        : new ContractError(
            statusCode === 413
              ? "PAYLOAD_TOO_LARGE"
              : statusCode === 400
                ? "INVALID_ARGUMENT"
                : "INTERNAL",
            statusCode === 400 ? "Malformed request" : "Request failed",
          );
    const metadata = errorRegistry[failure.code];
    if (["UNAUTHENTICATED", "FORBIDDEN", "POLICY_DENIED", "RATE_LIMITED"].includes(failure.code)) {
      const identity = identities.get(request);
      const context = identity
        ? options.application.forIdentity(identity).context
        : { ...options.application.context, principalId: "unauthenticated:local" };
      auditSecurity(
        context,
        identity ? "api.authorization" : "auth",
        "local-api",
        "denied",
        request.id,
      );
    }
    if (failure.code === "RATE_LIMITED") reply.header("Retry-After", "1");
    reply.code(metadata.httpStatus).send({
      schemaVersion: "1.0.0",
      requestId: request.id,
      error: {
        code: failure.code,
        message: failure.message,
        retryable: metadata.retryable,
        details: failure.details,
        nextActions: [],
      },
    });
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      schemaVersion: "1.0.0",
      requestId: request.id,
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
        retryable: false,
        details: {},
        nextActions: [],
      },
    }),
  );
  app.get("/v1/openapi.json", async (_request, reply) =>
    reply
      .type("application/json")
      .send(await readFile(new URL("../../../packages/contracts/openapi.json", import.meta.url))),
  );
  const routes = buildRouteTable();
  for (const route of routeCatalog)
    app.route({
      method: route.method as HTTPMethods,
      url: `/v1${route.path.replace(/\{(\w+)\}/g, ":$1")}`,
      config: { auth: route.auth } satisfies RouteConfig,
      ...(route.auth === "signature" ? { bodyLimit: INBOUND_WEBHOOK_MAX_BYTES } : {}),
      handler: async (request, reply) => {
        const identity = identities.get(request) ?? null;
        const service = identity
          ? options.application.forIdentity(identity, request.id)
          : options.application;
        const entry = routes.get(`${route.method} ${route.path}`);
        if (!entry)
          throw new ContractError(
            "CAPABILITY_UNAVAILABLE",
            "Capability is not implemented in this milestone",
            { capability: route.path, milestone: route.milestone },
          );
        if (route.scope !== "public" && route.auth !== "signature") {
          const scope = route.scope === "upload token" ? "W" : route.scope.split(":").at(-1);
          // Named resource actions are never implied by W/X; the service evaluates them per resource.
          if (namedActions[scope ?? ""]) {
            if (!identity) throw new ContractError("UNAUTHENTICATED", "Authentication is required");
          } else if (
            !["R", "W", "X", "A"].includes(scope ?? "") ||
            !identity?.scopes.includes(scope as "R" | "W" | "X" | "A")
          )
            throw new ContractError("FORBIDDEN", "Session scope is insufficient", { scope });
        }
        const params = request.params as Record<string, string>;
        const query = request.query as Record<string, string>;
        const body = request.body ?? {};
        if (route.method !== "GET" && route.requestSchema !== "Binary")
          validate(route.requestSchema, body);
        // Checked before the idempotent transaction: an audit row written inside it would roll back with the refusal.
        if (
          identity &&
          route.method !== "GET" &&
          typeof body === "object" &&
          "workspaceId" in body &&
          typeof body.workspaceId === "string" &&
          body.workspaceId !== identity.workspaceId
        ) {
          auditSecurity(
            service.context,
            "tenant.violation",
            body.workspaceId,
            "denied",
            request.id,
          );
          throw new ContractError("FORBIDDEN", "Workspace mismatch");
        }
        // Signed webhooks come from third parties that cannot send Idempotency-Key; their dedupe is the delivery ID.
        const mutation = route.auth !== "signature" && !["GET", "HEAD"].includes(route.method);
        const key = request.headers["idempotency-key"];
        if (
          mutation &&
          route.requestSchema !== "Binary" &&
          (typeof key !== "string" || key.length < 16 || key.length > 128)
        )
          throw new ContractError(
            "INVALID_ARGUMENT",
            "Idempotency-Key must contain 16–128 characters",
          );
        const match = request.headers["if-match"];
        const context: RouteContext = {
          service,
          identity,
          params,
          query,
          body,
          rawBody: route.auth === "signature" ? (rawBodies.get(request) ?? null) : null,
          idempotencyKey: typeof key === "string" ? key : null,
          ifMatch: () => {
            if (match === undefined)
              throw new ContractError("PRECONDITION_REQUIRED", "If-Match is required");
            if (typeof match !== "string" || !/^"[1-9]\d*"$/.test(match))
              throw new ContractError("INVALID_ARGUMENT", "If-Match must be a quoted version");
            return Number(match.slice(1, -1));
          },
          page: (rows) => {
            const limit = query.limit === undefined ? 50 : Number(query.limit);
            if (!Number.isInteger(limit) || limit < 1 || limit > 100)
              throw new ContractError("INVALID_ARGUMENT", "Page size must be 1–100");
            const binding = JSON.stringify([
              service.context.workspaceId,
              identity?.principalId,
              route.path,
              params,
              Object.fromEntries(
                Object.entries(query)
                  .filter(([name]) => name !== "cursor" && name !== "limit")
                  .sort(),
              ),
            ]);
            const cursor = query.cursor ? codec.decode(query.cursor, binding) : null;
            const cutoff = cursor?.cutoff ?? new Date().toISOString();
            const selected = rows
              .filter(
                (row) =>
                  String(row.createdAt ?? "") <= cutoff &&
                  (!cursor ||
                    String(row.createdAt ?? "") < cursor.createdAt ||
                    (row.createdAt === cursor.createdAt && String(row.id) < cursor.id)),
              )
              .sort(
                (a, b) =>
                  String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")) ||
                  String(b.id).localeCompare(String(a.id)),
              );
            const items = selected.slice(0, limit);
            const last = items.at(-1);
            const hasMore = selected.length > limit;
            return {
              items,
              hasMore,
              nextCursor:
                hasMore && last
                  ? codec.encode({
                      binding,
                      cutoff,
                      createdAt: String(last.createdAt ?? ""),
                      id: String(last.id),
                    })
                  : null,
            };
          },
          cursors: codec,
          reauthenticate: () => {
            const credential = credentials.get(request);
            if (!credential)
              throw new ContractError("UNAUTHENTICATED", "Authentication is required");
            if (credential.kind === "session")
              authenticateSession(options.application, credential.secret);
            else authenticateBearer(options.application, credential.secret);
          },
          request,
          reply,
        };
        const operation = () => entry.handler(context);
        const data =
          mutation && entry.synchronous && !(typeof body === "object" && "codeRef" in body)
            ? executeIdempotent(
                service,
                `${route.method} ${route.path}:${params.id ?? ""}`,
                key as string,
                { body, ifMatch: match ?? null },
                operation as () => unknown,
              )
            : await operation();
        // Handlers that stream or answer on their own have already taken over the reply.
        if (reply.sent) return reply;
        if (data && typeof data === "object" && "version" in data)
          reply.header("ETag", `"${data.version}"`);
        reply.code(entry.status);
        return { schemaVersion: "1.0.0", requestId: request.id, data, warnings: [] };
      },
    });
  if (portal) registerPortal(app, portal);
  if (options.mcp !== false) {
    const adapter = createMcpHttpHandler({
      roots: options.mcpRoots ?? [options.application.config.cwd],
    });
    registerMcpHttp(app, adapter.handler);
    app.addHook("onClose", () => adapter.close());
  }
  if (!server) {
    const listen = app.listen.bind(app);
    app.listen = ((listenOptions: { host?: string; port?: number }, ...args: unknown[]) => {
      if (listenOptions?.host && listenOptions.host !== "127.0.0.1")
        throw new ContractError("POLICY_DENIED", "Local server binds 127.0.0.1 only");
      return Reflect.apply(listen, app, [{ ...listenOptions, host: "127.0.0.1" }, ...args]);
    }) as FastifyInstance["listen"];
  }
  return app;
}
const namedActions: Record<string, true> = { approve: true, delete: true };
