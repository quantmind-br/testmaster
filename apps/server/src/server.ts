import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  type Application,
  type ArtifactStream,
  type AuthorizationIdentity,
  auditSecurity,
  authenticateLocalToken,
  correlationId,
  executeIdempotent,
  OperationalLogger,
  SignedCursorCodec,
} from "@testmaster/application";
import {
  type BatchRequest,
  ContractError,
  errorRegistry,
  parseStrictJson,
  type RouteDefinition,
  type RunRequest,
  routeCatalog,
  type TestRevisionInput,
  validate,
  validateDocument,
} from "@testmaster/contracts";
import { createMcpHttpHandler } from "@testmaster/mcp";
import fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HTTPMethods,
} from "fastify";

export interface ServerOptions {
  application: Application;
  host?: string;
  mode?: "local" | "server";
  origins?: readonly string[];
  cursorTtlMs?: number;
  now?: () => number;
  mcp?: false;
  mcpRoots?: readonly string[];
}
export interface McpHttpContext {
  request: FastifyRequest;
  reply: FastifyReply;
  application: Application;
  identity: AuthorizationIdentity;
}
export type McpHttpHandler = (context: McpHttpContext) => Promise<void>;
const contexts = new WeakMap<
  FastifyInstance,
  { options: ServerOptions; identities: WeakMap<FastifyRequest, AuthorizationIdentity> }
>();
export function registerMcpHttp(app: FastifyInstance, handler: McpHttpHandler): void {
  const ctx = contexts.get(app);
  if (!ctx) throw new Error("MCP requires a TestMaster server");
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (request, reply) => {
      const identity = ctx.identities.get(request);
      if (!identity) throw new ContractError("UNAUTHENTICATED", "Capability token required");
      await handler({
        request,
        reply,
        identity,
        application: ctx.options.application.withIdentity(identity, request.id),
      });
    },
  });
}
export function createServer(options: ServerOptions): FastifyInstance {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1")
    throw new ContractError("POLICY_DENIED", "Local server binds 127.0.0.1 only");
  if (options.mode === "server")
    throw new ContractError("CAPABILITY_UNAVAILABLE", "Multi-user server requires M4", {
      capability: "server-mode",
      milestone: "M4",
    });
  const app = fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024,
    requestTimeout: 30000,
    connectionTimeout: 30000,
    keepAliveTimeout: 5000,
  });
  const identities = new WeakMap<FastifyRequest, AuthorizationIdentity>();
  contexts.set(app, { options, identities });
  const codec = new SignedCursorCodec(
    options.application,
    options.cursorTtlMs ?? 300000,
    options.now ?? Date.now,
  );
  const buckets = new Map<string, { tokens: number; at: number }>();
  // One loopback installation has one failure budget. Neither token guesses nor
  // attacker-controlled forwarding headers can create fresh buckets.
  const authFailures = { tokens: 20, at: (options.now ?? Date.now)() };
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    try {
      done(null, parseStrictJson(body as Buffer, 10 * 1024 * 1024));
    } catch (error) {
      done(error as Error);
    }
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
    const origin = request.headers.origin;
    if (origin && !(options.origins ?? []).includes(origin))
      throw new ContractError("FORBIDDEN", "Origin is not allowed");
    if (request.url.split("?")[0] === "/v1/health/live") return;
    const authorization = request.headers.authorization;
    const match = typeof authorization === "string" ? /^Bearer (\S+)$/.exec(authorization) : null;
    const authenticationNow = (options.now ?? Date.now)();
    authFailures.tokens = Math.min(
      20,
      authFailures.tokens + Math.max(0, authenticationNow - authFailures.at) / 1000,
    );
    authFailures.at = authenticationNow;
    if (authFailures.tokens < 1)
      throw new ContractError("RATE_LIMITED", "Local authentication rate exceeded");
    let identity: AuthorizationIdentity;
    try {
      identity = authenticateLocalToken(options.application, match?.[1] ?? "");
    } catch (error) {
      authFailures.tokens--;
      throw error;
    }
    auditSecurity(
      options.application.withIdentity(identity).context,
      "auth",
      "local-api",
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
        ? options.application.withIdentity(identity).context
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
  for (const route of routeCatalog)
    app.route({
      method: route.method as HTTPMethods,
      url: `/v1${route.path.replace(/\{(\w+)\}/g, ":$1")}`,
      handler: async (request, reply) => {
        const identity = identities.get(request);
        const service = identity
          ? options.application.withIdentity(identity, request.id)
          : options.application;
        if (!implementedMilestones.has(route.milestone))
          throw new ContractError(
            "CAPABILITY_UNAVAILABLE",
            "Capability is not implemented in this milestone",
            { capability: route.path, milestone: route.milestone },
          );
        if (route.scope !== "public") {
          const scope = route.scope === "upload token" ? "W" : route.scope.split(":").at(-1);
          // Named resource actions are never implied by W/X; the service evaluates them per resource.
          if (namedActions.has(scope ?? "")) {
            if (!identity) throw new ContractError("UNAUTHENTICATED", "Authentication is required");
          } else if (
            !["R", "W", "X", "A"].includes(scope ?? "") ||
            !identity?.scopes.includes(scope as "R" | "W" | "X" | "A")
          )
            throw new ContractError("FORBIDDEN", "Session scope is insufficient", { scope });
        }
        const params = request.params as Record<string, string>;
        const id = params.id ?? "";
        const query = request.query as Record<string, string>;
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (route.method !== "GET" && route.requestSchema !== "Binary")
          validate(route.requestSchema, body);
        const mutation = !["GET", "HEAD"].includes(route.method);
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
        const version = (): number => {
          if (match === undefined)
            throw new ContractError("PRECONDITION_REQUIRED", "If-Match is required");
          if (typeof match !== "string" || !/^"[1-9]\d*"$/.test(match))
            throw new ContractError("INVALID_ARGUMENT", "If-Match must be a quoted version");
          return Number(match.slice(1, -1));
        };
        const page = (rows: Record<string, unknown>[]) => {
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
                .filter(([key]) => key !== "cursor" && key !== "limit")
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
        };
        if (route.path === "/health/ready") {
          const result = await service.readiness();
          return reply
            .code(result.status === "ready" ? 200 : 503)
            .send({ schemaVersion: "1.0.0", requestId: request.id, data: result, warnings: [] });
        }
        if (route.path === "/contracts/validate")
          return reply.send({
            schemaVersion: "1.0.0",
            requestId: request.id,
            data: validateDocument(String(body.schema), body.document),
            warnings: [],
          });
        if (route.path === "/runs/{id}/events" || route.path === "/discovery/{id}/events") {
          const job = route.path === "/discovery/{id}/events";
          if (job) service.discovery.get(id);
          else service.runs.get(id);
          const last = request.headers["last-event-id"];
          let after = -1;
          if (last !== undefined) {
            if (typeof last !== "string")
              throw new ContractError("INVALID_ARGUMENT", "Invalid event cursor");
            const binding = JSON.stringify([
              service.context.workspaceId,
              identity?.principalId,
              id,
              route.path,
            ]);
            after = Number(codec.decode(last, binding).id);
            if (!Number.isSafeInteger(after) || after < 0)
              throw new ContractError("INVALID_ARGUMENT", "Invalid event sequence");
          }
          reply.hijack();
          reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          let stopped = false;
          let polling = false;
          const send = () => {
            if (stopped || polling) return;
            polling = true;
            try {
              authenticateLocalToken(
                options.application,
                request.headers.authorization?.slice(7) ?? "",
              );
              const events = job
                ? service.discovery.events(id, after)
                : service.runs.events(id, after);
              for (const row of events) {
                const seq = Number(row.seq);
                const cursor = codec.encode({
                  binding: JSON.stringify([
                    service.context.workspaceId,
                    identity?.principalId,
                    id,
                    route.path,
                  ]),
                  cutoff: new Date().toISOString(),
                  createdAt: String(row.occurredAt),
                  id: String(seq),
                });
                const event = {
                  schemaVersion: "1.0.0",
                  eventId: row.id,
                  seq,
                  type: row.type,
                  ...(job ? { jobId: id } : { runId: id }),
                  attemptId:
                    row.payload && typeof row.payload === "object" && "attemptId" in row.payload
                      ? row.payload.attemptId
                      : null,
                  occurredAt: row.occurredAt,
                  payload: row.payload,
                };
                if (
                  !reply.raw.write(
                    `id: ${cursor}\nevent: ${row.type}\ndata: ${JSON.stringify(event)}\n\n`,
                  )
                ) {
                  stop();
                  return;
                }
                after = seq;
              }
              const phase = job ? service.discovery.get(id).job.phase : service.runs.get(id).phase;
              if (
                ["completed", "cancelled", "failed"].includes(phase) &&
                (!job || events.length < 100)
              )
                stop();
            } catch {
              stop();
            } finally {
              polling = false;
            }
          };
          const poll = setInterval(send, 100);
          const heartbeat = setInterval(() => {
            if (!reply.raw.write(": heartbeat\n\n")) stop();
          }, 15000);
          const stop = () => {
            if (stopped) return;
            stopped = true;
            clearInterval(poll);
            clearInterval(heartbeat);
            reply.raw.end();
          };
          reply.raw.on("close", stop);
          send();
          return;
        }
        const execution = {
          key: typeof key === "string" ? key : "",
          uploadToken: request.headers["x-upload-token"] as string | undefined,
          range: request.headers.range,
        };
        const operation = () => dispatch(service, route, id, body, version, page, query, execution);
        const data =
          mutation && synchronousRoutes[`${route.method} ${route.path}`] && !("codeRef" in body)
            ? executeIdempotent(
                service,
                `${route.method} ${route.path}:${id}`,
                key as string,
                { body, ifMatch: match ?? null },
                operation,
              )
            : await operation();
        if (data && typeof data === "object" && "version" in data)
          reply.header("ETag", `"${data.version}"`);
        if (route.method === "GET" && route.path === "/artifacts/{id}") {
          const artifact = data as ArtifactStream;
          const filename = `artifact-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.bin`;
          reply
            .header("ETag", `"${artifact.entry.sha256}"`)
            .header("Accept-Ranges", "bytes")
            .header("Content-Disposition", `attachment; filename="${filename}"`)
            .header("X-Content-Type-Options", "nosniff")
            .header("Cache-Control", "private, no-store")
            .header(
              "Content-Security-Policy",
              "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            )
            .type(artifact.entry.mimeType);
          if (execution.range) {
            const range = /^bytes=(\d+)-(\d+)$/.exec(execution.range);
            reply
              .code(206)
              .header(
                "Content-Range",
                `bytes ${range?.[1]}-${range?.[2]}/${artifact.entry.sizeBytes}`,
              );
          }
          return reply.send(Readable.from(artifact.stream));
        }
        reply.code(
          route.method === "POST" &&
            [
              "/runs",
              "/batches",
              "/projects/{id}/discovery",
              "/projects/{id}/proposal-batches",
            ].includes(route.path)
            ? 202
            : route.method === "POST" &&
                [
                  "/projects",
                  "/projects/{id}/environments",
                  "/projects/{id}/tests",
                  "/tests/{id}/revisions",
                  "/uploads",
                ].includes(route.path)
              ? 201
              : 200,
        );
        return { schemaVersion: "1.0.0", requestId: request.id, data, warnings: [] };
      },
    });
  if (options.mcp !== false) {
    const adapter = createMcpHttpHandler({
      roots: options.mcpRoots ?? [options.application.config.cwd],
    });
    registerMcpHttp(app, adapter.handler);
    app.addHook("onClose", () => adapter.close());
  }
  const listen = app.listen.bind(app);
  app.listen = ((listenOptions: { host?: string; port?: number }, ...args: unknown[]) => {
    if (listenOptions?.host && listenOptions.host !== "127.0.0.1")
      throw new ContractError("POLICY_DENIED", "Local server binds 127.0.0.1 only");
    return Reflect.apply(listen, app, [{ ...listenOptions, host: "127.0.0.1" }, ...args]);
  }) as FastifyInstance["listen"];
  return app;
}
/** Milestones whose routes are implemented locally; M4+ (App, schedules, server profiles) stay unavailable. */
const implementedMilestones: ReadonlySet<string> = new Set(["M0", "M1", "M2", "M3"]);
const namedActions: ReadonlySet<string> = new Set(["approve", "delete"]);
const synchronousRoutes: Record<string, true> = Object.fromEntries(
  [
    "POST /projects",
    "PATCH /projects/{id}",
    "POST /projects/{id}/archive",
    "POST /projects/{id}/environments",
    "PATCH /environments/{id}",
    "DELETE /environments/{id}",
    "POST /projects/{id}/default-environment",
    "POST /projects/{id}/tests",
    "PATCH /tests/{id}",
    "DELETE /tests/{id}",
    "POST /tests/{id}/revisions",
    "POST /tests/{id}/promote",
    "POST /runs/{id}/cancel",
    "POST /batches/{id}/cancel",
    "POST /approvals",
    "POST /approvals/{id}/revoke",
    "POST /uploads",
    "DELETE /sources/{id}",
    "PATCH /projects/{id}/requirements",
    "PATCH /proposals/{id}",
    "POST /discovery/{id}/cancel",
    "POST /healing-proposals/{id}/reject",
    "PUT /tests/{id}/quarantine",
    "DELETE /tests/{id}/quarantine",
    "DELETE /artifacts/{id}",
  ].map((key) => [key, true]),
);
function dispatch(
  app: Application,
  route: RouteDefinition,
  id: string,
  body: Record<string, unknown>,
  version: () => number,
  page: (rows: Record<string, unknown>[]) => unknown,
  query: Record<string, string>,
  execution: { key: string; uploadToken: string | undefined; range: string | undefined },
): unknown {
  const op = `${route.method} ${route.path}`;
  switch (op) {
    case "GET /health/live":
      return { status: "alive" };
    case "GET /health/ready":
      return app.readiness();
    case "GET /capabilities":
      return app.capabilities();
    case "GET /projects":
      return page(app.projects.list());
    case "POST /projects":
      if (body.workspaceId && body.workspaceId !== app.context.workspaceId)
        throw new ContractError("FORBIDDEN", "Workspace mismatch");
      return app.projects.create({ name: body.name as string });
    case "GET /projects/{id}":
      return app.projects.get(id);
    case "PATCH /projects/{id}": {
      const { workspaceId, ...patch } = body;
      if (workspaceId && workspaceId !== app.context.workspaceId)
        throw new ContractError("FORBIDDEN", "Workspace mismatch");
      return app.projects.update(id, patch, version());
    }
    case "POST /projects/{id}/archive":
      return app.projects.archive(id, version());
    case "GET /projects/{id}/environments":
      return page(app.environments.list(id));
    case "POST /projects/{id}/environments": {
      if ((body.authRefs as string[] | undefined)?.length)
        throw new ContractError("CAPABILITY_UNAVAILABLE", "Auth profiles require M4", {
          capability: "auth-profiles",
          milestone: "M4",
        });
      const { authRefs, ...input } = body;
      return app.environments.create({ projectId: id, ...input } as Parameters<
        typeof app.environments.create
      >[0]);
    }
    case "GET /environments/{id}":
      return app.environments.get(id);
    case "PATCH /environments/{id}": {
      const { authRefs, ...input } = body;
      if ((authRefs as string[] | undefined)?.length)
        throw new ContractError("CAPABILITY_UNAVAILABLE", "Auth profiles require M4", {
          capability: "auth-profiles",
          milestone: "M4",
        });
      return app.environments.update(id, input, version());
    }
    case "DELETE /environments/{id}":
      return app.environments.archive(id, version());
    case "POST /projects/{id}/default-environment":
      return app.environments.setDefault(id, body.environmentId as string, version());
    case "GET /secrets":
      return page(app.secrets.list());
    case "POST /secrets":
      if (typeof body.value !== "string")
        throw new ContractError("INVALID_ARGUMENT", "Secret value is required");
      return app.secrets.set(body.name as string, body.value, {
        allowedOrigins: body.allowedOrigins as string[],
        idempotencyKey: execution.key,
      });
    case "DELETE /secrets/{id}":
      return app.secrets.remove(id, execution.key);
    case "GET /projects/{id}/tests":
      return page(
        app.tests
          .list(id)
          .filter(
            (test) =>
              (!query.type ||
                app.revisions.get(String(test.activeRevisionId)).plan?.type === query.type) &&
              (!query.priority || test.priority === query.priority) &&
              (!query.tag || test.tags.includes(query.tag)),
          ),
      );
    case "POST /projects/{id}/tests": {
      const input = body as TestRevisionInput;
      if ("codeRef" in input) {
        if (input.origin !== "imported")
          throw new ContractError(
            "INVALID_ARGUMENT",
            "Code references must retain imported provenance",
          );
        return app.codeImport
          .createTestFromReference({
            projectId: id,
            codeRef: input.codeRef,
            idempotencyKey: execution.key,
          })
          .then((result) => result.test);
      }
      if (input.origin !== "manual")
        throw new ContractError("INVALID_ARGUMENT", "Only manual plans may be authored directly");
      return app.tests.create({ projectId: id, plan: input.plan });
    }
    case "GET /tests/{id}":
      return app.tests.get(id);
    case "PATCH /tests/{id}":
      return app.tests.update(id, body, version());
    case "DELETE /tests/{id}":
      return app.tests.archive(id, version());
    case "GET /tests/{id}/revisions":
      return page(app.revisions.list(id));
    case "POST /tests/{id}/revisions": {
      const input = body as TestRevisionInput;
      if ("codeRef" in input) {
        if (input.origin !== "imported")
          throw new ContractError(
            "INVALID_ARGUMENT",
            "Code references must retain imported provenance",
          );
        return app.codeImport.createRevision(id, input.codeRef, input.parentId, execution.key);
      }
      if (input.origin !== "manual")
        throw new ContractError("INVALID_ARGUMENT", "Only manual plans may be authored directly");
      return app.revisions.create(id, input.plan, input.parentId);
    }
    case "POST /tests/{id}/promote": {
      const current = app.tests.get(id);
      if (current.activeRevisionId !== body.expectedActiveRevisionId)
        throw new ContractError("REVISION_CONFLICT", "Active revision changed");
      const rev = app.revisions.get(body.revisionId as string);
      if (rev.testId !== id)
        throw new ContractError("INVALID_ARGUMENT", "Revision belongs to another test");
      return app.revisions.promote(rev.id, version());
    }
    case "POST /runs":
      return app.runs.admit({ ...body, origin: "api" } as RunRequest, {
        idempotencyKey: execution.key,
      });
    case "GET /runs":
      return page(
        app.runs
          .list()
          .filter(
            (run) =>
              (!query.testId || run.testId === query.testId) &&
              (!query.status || run.status === query.status) &&
              (!query.since || String(run.createdAt) >= query.since) &&
              (!query.projectId || app.tests.get(run.testId).projectId === query.projectId),
          ),
      );
    case "GET /runs/{id}":
      return app.runs.get(id);
    case "POST /runs/{id}/cancel":
      return app.runs.cancel(id);
    case "POST /runs/{id}/rerun":
      return app.runs.rerun(id, { ...body, idempotencyKey: execution.key } as Parameters<
        typeof app.runs.rerun
      >[1]);
    case "GET /runs/{id}/steps":
      return page(app.runs.steps(id, query.attemptId));
    case "GET /runs/{id}/bundle":
      return app.artifacts.get(id, query.attemptId ? { attemptId: query.attemptId } : {});
    case "POST /batches":
      return app.batches.admit(body as BatchRequest, { idempotencyKey: execution.key });
    case "GET /batches/{id}":
      return app.batches.get(id);
    case "POST /batches/{id}/cancel": {
      const batch = app.batches.get(id);
      return {
        batchId: id,
        members: (batch.memberRuns as string[]).map((runId) => app.runs.cancel(runId)),
      };
    }
    case "GET /artifacts/{id}": {
      const range = execution.range ? /^bytes=(\d+)-(\d+)$/.exec(execution.range) : null;
      if (execution.range && !range)
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Only a single explicit byte range is supported",
        );
      return app.artifacts.stream(
        id,
        range ? { range: { start: Number(range[1]), end: Number(range[2]) } } : {},
      );
    }
    case "POST /uploads":
      return app.uploads.create(body as unknown as Parameters<typeof app.uploads.create>[0]);
    case "PUT /uploads/{id}/bytes": {
      if (!execution.uploadToken) throw new ContractError("FORBIDDEN", "Upload token is required");
      return app.uploads.write(
        id,
        body as unknown as AsyncIterable<Uint8Array>,
        execution.uploadToken,
      );
    }
    case "POST /uploads/{id}/complete":
      return app.uploads.complete(id, execution.key);
    case "GET /projects/{id}/sources":
      return page(app.sources.list(id));
    case "POST /projects/{id}/sources":
      return app.sources.add({
        projectId: id,
        ...body,
        idempotencyKey: execution.key,
        ...(body.sourceId ? { expectedVersion: version() } : {}),
      } as Parameters<typeof app.sources.add>[0]);
    case "GET /sources/{id}":
      return app.sources.get(id);
    case "DELETE /sources/{id}":
      return app.sources.archive(id, version());
    case "GET /projects/{id}/requirements":
      return app.requirements.snapshot(id);
    case "PATCH /projects/{id}/requirements":
      return app.requirements.apply(
        id,
        body.requirements as Parameters<typeof app.requirements.apply>[1],
        version(),
      );
    case "POST /projects/{id}/discovery": {
      if (body.projectId !== id)
        throw new ContractError("INVALID_ARGUMENT", "Project path and request differ");
      const scope = body.scope as string[];
      if (scope.length > 1 || scope.some((value) => value !== "codebase" && value !== "diff"))
        throw new ContractError("INVALID_ARGUMENT", "Discovery scope must select codebase or diff");
      const budget = body.budget;
      if (!budget || typeof budget !== "object" || Array.isArray(budget))
        throw new ContractError("INVALID_ARGUMENT", "Discovery budget must be an object");
      const settings = budget as Record<string, unknown>;
      if (
        Object.keys(settings).some((key) => !["root", "base", "head", "workingTree"].includes(key))
      )
        throw new ContractError("INVALID_ARGUMENT", "Unsupported discovery setting");
      if (
        ["root", "base", "head"].some(
          (key) => settings[key] !== undefined && typeof settings[key] !== "string",
        ) ||
        (settings.workingTree !== undefined && typeof settings.workingTree !== "boolean")
      )
        throw new ContractError("INVALID_ARGUMENT", "Invalid discovery setting");
      return app.discovery.discover({
        projectId: id,
        sourceRevisionIds: body.sourceRevisionIds as string[],
        ...(scope[0] ? { scope: scope[0] as "codebase" | "diff" } : {}),
        ...settings,
        ...(body.inputsFingerprint ? { inputsFingerprint: body.inputsFingerprint as string } : {}),
        idempotencyKey: execution.key,
      } as Parameters<typeof app.discovery.discover>[0]);
    }
    case "GET /discovery/{id}":
      return app.discovery.get(id);
    case "POST /discovery/{id}/retry":
      return app.discovery.retry(id, { ...body, idempotencyKey: execution.key });
    case "POST /discovery/{id}/cancel":
      return app.discovery.cancel(id);
    case "POST /projects/{id}/proposal-batches": {
      const scope = body.scope as string[];
      if (
        new Set(scope).size !== scope.length ||
        scope.some((type) => type !== "frontend" && type !== "backend" && type !== "integration") ||
        (scope.includes("integration") && scope.length !== 1)
      )
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Proposal scope must select integration alone or distinct frontend and/or backend types",
        );
      // Both types let the model choose per requirement; none keeps the backend default.
      const type =
        scope.length === 2
          ? "auto"
          : (scope[0] as "frontend" | "backend" | "integration" | undefined);
      const refs = body.inputRefs as { sourceRevisionId?: string }[];
      const requirementIds = refs.length
        ? app.requirements
            .list(id)
            .filter((requirement) =>
              requirement.sourceRefs.some((ref) =>
                refs.some((input) => input.sourceRevisionId === ref.sourceRevisionId),
              ),
            )
            .map((requirement) => requirement.id)
        : undefined;
      return app.proposals.generate({
        projectId: id,
        idempotencyKey: execution.key,
        budget: body.budget as { deadlineMs?: number },
        ...(type ? { type } : {}),
        ...(requirementIds ? { requirementIds } : {}),
      });
    }
    case "GET /proposal-batches/{id}":
      return app.proposals.detail(id);
    case "PATCH /proposals/{id}": {
      if (body.id !== id)
        throw new ContractError("INVALID_ARGUMENT", "Proposal identity differs from path");
      const detail = app.proposals.detail(body.batchId as string);
      const existing = detail.proposals.find((proposal) => proposal.id === id);
      if (
        !existing ||
        existing.state !== body.state ||
        JSON.stringify(existing.requirementRefs) !== JSON.stringify(body.requirementRefs) ||
        JSON.stringify(existing.evidenceRefs) !== JSON.stringify(body.evidenceRefs)
      )
        throw new ContractError("INVALID_ARGUMENT", "Only proposal plan content may be edited");
      return app.proposals.edit(
        id,
        body.plan as Parameters<typeof app.proposals.edit>[1],
        version(),
      );
    }
    case "POST /proposal-batches/{id}/accept": {
      const expectedVersion = version();
      if (body.expectedVersion !== expectedVersion)
        throw new ContractError("REVISION_CONFLICT", "If-Match and expectedVersion differ");
      return app.proposals.accept(id, {
        proposalIds: body.proposalIds as string[],
        expectedVersion,
        idempotencyKey: execution.key,
      });
    }
    case "POST /proposal-batches/{id}/reject": {
      const expectedVersion = version();
      if (body.expectedVersion !== expectedVersion)
        throw new ContractError("REVISION_CONFLICT", "If-Match and expectedVersion differ");
      return app.proposals.reject(id, {
        proposalIds: body.proposalIds as string[],
        expectedVersion,
        idempotencyKey: execution.key,
      });
    }
    case "GET /resources":
      return page(app.resources.list(query.runId));
    case "POST /resources/{id}/cleanup":
      return app.resources.cleanup(id, {
        ...(body.approval ? { approvalId: body.approval as string } : {}),
        ownerProof: body.ownerProof,
        expectedVersion: version(),
        idempotencyKey: execution.key,
      });
    case "GET /usage":
      return app.usage.get({
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.runId ? { runId: query.runId } : {}),
        ...(query.model ? { model: query.model } : {}),
        ...(query.since ? { since: query.since } : {}),
        ...(query.until ? { until: query.until } : {}),
      });
    case "POST /projects/{id}/budget":
      return app.usage.setBudget(id, body as { tokens: number });
    case "GET /revisions/{id}/code": {
      const revision = app.revisions.get(id);
      return app.codeExport.export(revision.testId, {
        revisionId: id,
        format: revision.runnerKind === "pytest" ? "pytest" : "playwright",
      });
    }
    case "GET /approvals":
      return page(app.approvals.list());
    case "POST /approvals":
      return app.approvals.create(body as unknown as Parameters<typeof app.approvals.create>[0]);
    case "POST /approvals/{id}/revoke":
      return app.approvals.revoke(id);
    case "GET /runs/{id}/analysis": {
      const analysis = app.analysis.get(id);
      if (!analysis) throw new ContractError("NOT_FOUND", "Analysis does not exist", { runId: id });
      return analysis;
    }
    case "POST /runs/{id}/analysis":
      return app.analysis.analyze(id, body as Parameters<typeof app.analysis.analyze>[1]);
    case "POST /runs/{id}/healing-proposals":
      return app.healing.propose(id, body as Parameters<typeof app.healing.propose>[1]);
    case "GET /healing-proposals/{id}":
      return app.healing.get(id);
    case "GET /healing-proposals/{id}/review":
      return app.healing.review(id);
    case "POST /healing-proposals/{id}/approve":
      return app.healing.approve(id, Number(body.expectedVersion));
    case "POST /healing-proposals/{id}/reject":
      return app.healing.reject(id, String(body.reason));
    case "GET /tests/{id}/quarantine": {
      const record = app.quarantine.get(id);
      if (!record) throw new ContractError("NOT_FOUND", "Test is not quarantined", { testId: id });
      return record;
    }
    case "PUT /tests/{id}/quarantine":
      return app.quarantine.set(id, body as unknown as Parameters<typeof app.quarantine.set>[1]);
    case "DELETE /tests/{id}/quarantine": {
      const record = app.quarantine.get(id);
      if (!record) throw new ContractError("NOT_FOUND", "Test is not quarantined", { testId: id });
      app.quarantine.remove(id, version());
      return record;
    }
    case "POST /run-comparisons":
      return app.comparisons.runs(
        String(body.leftRunId),
        String(body.rightRunId),
        body.page as Parameters<typeof app.comparisons.runs>[2],
      );
    case "POST /batch-comparisons":
      return app.comparisons.batches(
        String(body.leftBatchId),
        String(body.rightBatchId),
        body.page as Parameters<typeof app.comparisons.batches>[2],
      );
    case "POST /flake-studies":
      return app.flake.study(body as unknown as Parameters<typeof app.flake.study>[0], {
        idempotencyKey: execution.key,
      });
    case "GET /flake-studies/{id}":
      return app.flake.report(
        id,
        query.includeStudyIds ? query.includeStudyIds.split(",").filter(Boolean) : undefined,
      );
    case "POST /execution-previews":
      return app.selection.preview(body as unknown as Parameters<typeof app.selection.preview>[0]);
    case "POST /selective-runs":
      return app.selection.run(body as unknown as Parameters<typeof app.selection.run>[0], {
        idempotencyKey: execution.key,
      });
    case "DELETE /artifacts/{id}":
      return app.retention.requestDeletion(id);
    case "GET /deletion-operations/{id}":
      return app.retention.deletionStatus(id);
    default:
      throw new ContractError("CAPABILITY_UNAVAILABLE", "Application service is unavailable", {
        capability: route.path,
        milestone: route.milestone,
      });
  }
}
