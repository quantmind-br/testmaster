import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer as netServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { Application, issueLocalToken } from "@testmaster/application";
import {
  ContractError,
  type ErrorCode as ContractErrorCode,
  type ErrorBody,
  errorBody,
  errorRegistry,
  validateDocument,
} from "@testmaster/contracts";
import { expect, it } from "vitest";
import { cli, controlledShop, eventually, journey, object, text } from "./harness.js";
import { invalidDocuments } from "./invalid-documents.js";

async function freePort(): Promise<number> {
  const server = netServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
interface Operation {
  name: string;
  /** The code every surface must answer with, so a shared wrong failure cannot pass as parity. */
  code: ContractErrorCode;
  cli: string[];
  rest: { method: string; path: string; body?: unknown; ifMatch?: number };
  mcp: { tool: string; args: Record<string, unknown> };
}
/**
 * The `error` of a CLI or REST error envelope. The envelope's `requestId` is transport-specific (a
 * per-invocation correlation id) and is only required to exist; nothing else may sit beside
 * `schemaVersion` and `error`.
 */
function errorOf(result: unknown) {
  const { requestId, schemaVersion, error, ...rest } = object(result);
  expect(typeof requestId).toBe("string");
  expect(schemaVersion).toBe("1.0.0");
  expect(rest).toEqual({});
  return object(error);
}
/** The `error` of an MCP tool result: its JSON text carries the body alone, with no envelope. */
function mcpError(result: { content: unknown }) {
  const content = result.content as { text?: string }[];
  expect(content).toHaveLength(1);
  const { error, ...rest } = object(JSON.parse(String(content[0]?.text)));
  expect(rest).toEqual({});
  return object(error);
}

it("shared invalid corpus and unknown-resource operations get the same error body from built CLI, real server start, stdio MCP and HTTP MCP without authoring writes", async () => {
  await journey(
    "surface-invalid-corpus",
    async (session) => {
      const shop = await controlledShop();
      const clients: Client[] = [];
      let app: Application | undefined;
      try {
        await session.init(shop.url);
        const port = await freePort();
        const server = session.start(["server", "start", "--port", String(port)]);
        const ready = await eventually(
          async () => server.stdout(),
          (s) => s.includes("tokenPath"),
        );
        const receipt = object(object(JSON.parse(ready)).data);
        const tokenPath = text(receipt.tokenPath);
        const token = (await readFile(tokenPath, "utf8")).trim();
        app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
        const baseline = app.database.all("SELECT id FROM tests").length;
        const env = Object.fromEntries(
          Object.entries(session.env).filter(
            (p): p is [string, string] => typeof p[1] === "string",
          ),
        );
        const stdio = new Client({ name: "surface-parity", version: "1" });
        await stdio.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [cli, "--cwd", session.cwd, "mcp", "serve", "--token-file", tokenPath],
            env,
            stderr: "pipe",
          }),
        );
        clients.push(stdio);
        const http = new Client({ name: "surface-parity-http", version: "1" });
        await http.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          }),
        );
        clients.push(http);
        for (const fixture of invalidDocuments().filter((item) =>
          item.name.endsWith("-unknown-field"),
        )) {
          await delay(2200);
          const { fabricated: _fabricated, ...document } = object(fixture.document);
          const path = join(session.cwd, "valid.json");
          await writeFile(path, JSON.stringify(document));
          const command = await session.start([
            "contract",
            "validate",
            "--schema",
            fixture.schema,
            "--document",
            path,
          ]).result;
          expect(command.exitCode).toBe(0);
          expect(object(command.json).data).toEqual({ validated: true, schema: fixture.schema });
          const response = await fetch(`http://127.0.0.1:${port}/v1/contracts/validate`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "Idempotency-Key": randomUUID(),
            },
            body: JSON.stringify({ schema: fixture.schema, document }),
          });
          expect(object(await response.json()).data).toEqual({
            validated: true,
            schema: fixture.schema,
          });
          for (const client of clients) {
            const result = await client.callTool({
              name: "testmaster_validate_document",
              arguments: { schema: fixture.schema, document },
            });
            expect(result.isError).not.toBe(true);
            expect(result.structuredContent).toEqual({ validated: true, schema: fixture.schema });
          }
        }
        /**
         * Runs one operation on every surface and returns each surface's error body, normalized
         * only where the transport owns the field: the `requestId` of the CLI and REST envelope
         * (a per-invocation correlation id, `cli_<uuid>` or the server's `X-Correlation-ID`) is
         * dropped, and so is the envelope itself (`schemaVersion` is checked); MCP carries the body
         * alone as its tool result, with no envelope and no timestamps. Everything inside the body
         * (code, message, retryable, details, nextActions) is compared as is.
         */
        const bodies = async (operation: Operation) => {
          // REST plus MCP HTTP each consume an authenticated request token.
          await delay(2200);
          const command = await session.start(operation.cli).result;
          const response = await fetch(`http://127.0.0.1:${port}/v1${operation.rest.path}`, {
            method: operation.rest.method,
            headers: {
              Authorization: `Bearer ${token}`,
              ...(operation.rest.method === "GET" ? {} : { "Idempotency-Key": randomUUID() }),
              ...(operation.rest.body === undefined ? {} : { "Content-Type": "application/json" }),
              ...(operation.rest.ifMatch === undefined
                ? {}
                : { "If-Match": `"${operation.rest.ifMatch}"` }),
            },
            ...(operation.rest.body === undefined
              ? {}
              : { body: JSON.stringify(operation.rest.body) }),
          });
          const mcp: Record<string, unknown>[] = [];
          for (const client of clients) {
            const result = await client.callTool({
              name: operation.mcp.tool,
              arguments: operation.mcp.args,
            });
            expect(result.isError, operation.name).toBe(true);
            mcp.push(mcpError(result));
          }
          return {
            cli: { exit: command.exitCode, body: errorOf(command.json) },
            rest: { status: response.status, body: errorOf(await response.json()) },
            stdio: mcp[0],
            http: mcp[1],
          };
        };
        const assertEqualBodies = async (operation: Operation, expected?: ErrorBody) => {
          const found = await bodies(operation);
          const code = expected?.code ?? operation.code;
          // The body is the same on all four surfaces, including `retryable` and `nextActions`.
          expect(found.cli.body, `${operation.name} cli`).toEqual(expected ?? found.rest.body);
          expect(found.rest.body, `${operation.name} rest`).toEqual(found.cli.body);
          expect(found.stdio, `${operation.name} stdio mcp`).toEqual(found.cli.body);
          expect(found.http, `${operation.name} http mcp`).toEqual(found.cli.body);
          expect(found.cli.body.code, operation.name).toBe(code);
          // The transport maps the same code to its own status: HTTP status and CLI exit code.
          expect(found.rest.status, operation.name).toBe(errorRegistry[code].httpStatus);
          expect(found.cli.exit, operation.name).toBe(errorRegistry[code].cliExit);
        };
        for (const fixture of invalidDocuments()) {
          let expected: ErrorBody | undefined;
          try {
            validateDocument(fixture.schema, fixture.document);
          } catch (error) {
            expect(error).toBeInstanceOf(ContractError);
            expected = errorBody(error as ContractError);
          }
          expect(expected, fixture.name).toBeDefined();
          if (!expected) throw new Error(`Invalid fixture accepted: ${fixture.name}`);
          const path = join(session.cwd, "invalid.json");
          await writeFile(path, JSON.stringify(fixture.document));
          await assertEqualBodies(
            {
              name: fixture.name,
              code: expected.code,
              cli: ["contract", "validate", "--schema", fixture.schema, "--document", path],
              rest: {
                method: "POST",
                path: "/contracts/validate",
                body: { schema: fixture.schema, document: fixture.document },
              },
              mcp: {
                tool: "testmaster_validate_document",
                args: { schema: fixture.schema, document: fixture.document },
              },
            },
            expected,
          );
        }
        // The same equality for operations that reach the application with an unknown resource.
        const missing = (prefix: string) => `${prefix}_00000000-0000-4000-8000-000000000001`;
        const operations: Operation[] = [
          {
            name: "run-get-unknown",
            code: "NOT_FOUND",
            cli: ["run", "get", missing("run")],
            rest: { method: "GET", path: `/runs/${missing("run")}` },
            mcp: { tool: "testmaster_get_run", args: { runId: missing("run") } },
          },
          {
            name: "run-cancel-unknown",
            code: "NOT_FOUND",
            cli: ["run", "cancel", missing("run")],
            rest: { method: "POST", path: `/runs/${missing("run")}/cancel`, body: {} },
            mcp: {
              tool: "testmaster_cancel_run",
              args: { runId: missing("run"), reason: "surface parity" },
            },
          },
          {
            name: "run-analysis-unknown",
            code: "NOT_FOUND",
            cli: ["run", "analysis", missing("run")],
            rest: { method: "GET", path: `/runs/${missing("run")}/analysis` },
            mcp: { tool: "testmaster_get_analysis", args: { runId: missing("run") } },
          },
          {
            name: "test-archive-unknown",
            code: "NOT_FOUND",
            cli: ["test", "archive", missing("tst"), "--expected-version", "1"],
            rest: { method: "DELETE", path: `/tests/${missing("tst")}`, ifMatch: 1 },
            mcp: {
              tool: "testmaster_archive_test",
              args: { testId: missing("tst"), expectedVersion: 1 },
            },
          },
          {
            name: "source-archive-unknown",
            code: "NOT_FOUND",
            cli: ["source", "archive", missing("src"), "--expected-version", "1"],
            rest: { method: "DELETE", path: `/sources/${missing("src")}`, ifMatch: 1 },
            mcp: {
              tool: "testmaster_archive_source",
              args: { sourceId: missing("src"), expectedVersion: 1 },
            },
          },
          {
            name: "run-analyze-unknown",
            code: "NOT_FOUND",
            cli: ["run", "analyze", missing("run")],
            rest: { method: "POST", path: `/runs/${missing("run")}/analysis`, body: {} },
            mcp: { tool: "testmaster_analyze_run", args: { runId: missing("run") } },
          },
          {
            name: "run-analyze-provider-without-model",
            code: "INVALID_ARGUMENT",
            cli: ["run", "analyze", missing("run"), "--provider", "quantforge"],
            rest: {
              method: "POST",
              path: `/runs/${missing("run")}/analysis`,
              body: { provider: "quantforge" },
            },
            mcp: {
              tool: "testmaster_analyze_run",
              args: { runId: missing("run"), provider: "quantforge" },
            },
          },
        ];
        for (const operation of operations) await assertEqualBodies(operation);
        expect(app.database.all("SELECT id FROM tests")).toHaveLength(baseline);
        expect(app.database.all("SELECT id FROM runs")).toHaveLength(0);
        expect(app.database.all("SELECT id FROM sources")).toHaveLength(0);
        const future = await fetch(
          `http://127.0.0.1:${port}/v1/projects/${app.projects.list()[0]?.id}/tests`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "Idempotency-Key": randomUUID(),
            },
            body: JSON.stringify({
              plan: {
                ...(invalidDocuments().find(
                  (fixture) => fixture.name === "ExecutablePlan-future-major",
                )?.document as Record<string, unknown>),
              },
              origin: "manual",
            }),
          },
        );
        expect(future.status).toBe(400);
        const futureError = errorOf(await future.json());
        expect(futureError.code).toBe("INVALID_ARGUMENT");
        expect(object(futureError.details).issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: "/plan/schemaVersion", rule: "const" }),
          ]),
        );
        session.oracles.push({
          check: "sameErrorBody",
          surfaces: ["built-cli", "server-start", "stdio-mcp", "http-mcp"],
          cases: invalidDocuments().map((f) => f.name),
          authoringWrites: 0,
        });
      } finally {
        for (const client of clients) await client.close();
        app?.close();
        await shop.close();
      }
    },
    {
      class: "surface-conformance",
      runner: "built-cli-and-real-http-mcp",
      externalDependency: "local-docker-doctor",
      limitations: [
        "Read-only validation has no audit-free promise: denials are audited; no tests, sources or runs are created.",
      ],
    },
  );
}, 360000);

it("fabricated MCP calls are denied and audited with actor and command identity", async () => {
  await journey("surface-mcp-denials", async (session) => {
    const shop = await controlledShop();
    let app: Application | undefined;
    const client = new Client({ name: "fabricated-calls", version: "1" });
    try {
      await session.init(shop.url);
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const allowed = app.projects.list()[0];
      if (!allowed) throw new Error("No admitted project");
      const other = app.projects.create({ name: "Other project" });
      const membership = app.database.get(
        "SELECT id,version,data_json FROM memberships WHERE principal_id=?",
        app.context.principalId,
      );
      if (!membership) throw new Error("No membership");
      app.context.entities.update(
        "Membership",
        app.context.workspaceId,
        String(membership.id),
        Number(membership.version),
        {
          ...JSON.parse(String(membership.data_json)),
          projectRestrictions: [allowed.id],
          version: Number(membership.version) + 1,
        },
      );
      const token = await issueLocalToken(app);
      const env = Object.fromEntries(
        Object.entries(session.env).filter((p): p is [string, string] => typeof p[1] === "string"),
      );
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [cli, "--cwd", session.cwd, "mcp", "serve", "--token-file", token.tokenPath],
          env,
          stderr: "pipe",
        }),
      );
      const unknownTool = { name: "execute_shell", arguments: { command: "touch denied" } };
      const known = [
        { name: "testmaster_capabilities", arguments: { command: "touch denied" } },
        {
          name: "testmaster_normalize_requirements",
          arguments: { projectId: other.id, sourceRevisionIds: [] },
        },
      ];
      const calls = [unknownTool, ...known];
      // An unknown tool is a JSON-RPC protocol error (-32602), not a tool result; it is audited too.
      await expect(client.callTool(unknownTool)).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
        message: expect.stringContaining("Unknown tool: execute_shell"),
      });
      for (const [index, call] of known.entries()) {
        const result = await client.callTool(call);
        expect(result.isError).toBe(true);
        expect(mcpError(result).code).toBe(["INVALID_ARGUMENT", "FORBIDDEN"][index]);
      }
      const audits = app.database.all(
        "SELECT actor,resource_id,action FROM audit_events WHERE action='mcp.tool.denied'",
      );
      expect(audits).toHaveLength(3);
      expect(audits.map((row) => row.resource_id)).toEqual(calls.map((call) => call.name));
      expect(audits.every((row) => row.actor === app?.context.principalId)).toBe(true);
      expect(app.database.all("SELECT id FROM runs")).toHaveLength(0);
      session.oracles.push({
        check: "fabricatedCallsDeniedAndAudited",
        tools: calls.map((c) => c.name),
        auditCount: audits.length,
      });
    } finally {
      await client.close();
      app?.close();
      await shop.close();
    }
  });
}, 60000);
