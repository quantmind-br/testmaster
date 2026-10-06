import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer as netServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Application, issueLocalToken } from "@testmaster/application";
import { ContractError, validateDocument } from "@testmaster/contracts";
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
function errorOf(result: unknown) {
  return object(object(result).error);
}
function mcpError(result: { content: unknown }) {
  const content = result.content as { text?: string }[];
  return errorOf(JSON.parse(String(content[0]?.text)));
}

it("shared invalid corpus is rejected identically by built CLI, real server start, stdio MCP and HTTP MCP without authoring writes", async () => {
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
        for (const fixture of invalidDocuments()) {
          // REST plus MCP HTTP each consume an authenticated request token.
          await delay(2200);
          let expected: Record<string, unknown> | undefined;
          try {
            validateDocument(fixture.schema, fixture.document);
          } catch (error) {
            expect(error).toBeInstanceOf(ContractError);
            const failure = error as ContractError;
            expected = { code: failure.code, details: failure.details };
          }
          expect(expected, fixture.name).toBeDefined();
          if (!expected) throw new Error(`Invalid fixture accepted: ${fixture.name}`);
          const path = join(session.cwd, "invalid.json");
          await writeFile(path, JSON.stringify(fixture.document));
          const command = await session.start([
            "contract",
            "validate",
            "--schema",
            fixture.schema,
            "--document",
            path,
          ]).result;
          expect(errorOf(command.json), fixture.name).toMatchObject(expected);
          const response = await fetch(`http://127.0.0.1:${port}/v1/contracts/validate`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "Idempotency-Key": randomUUID(),
            },
            body: JSON.stringify({ schema: fixture.schema, document: fixture.document }),
          });
          expect(errorOf(await response.json()), fixture.name).toMatchObject(expected);
          for (const client of clients) {
            const result = await client.callTool({
              name: "testmaster_validate_document",
              arguments: { schema: fixture.schema, document: fixture.document },
            });
            expect(result.isError, fixture.name).toBe(true);
            expect(mcpError(result), fixture.name).toMatchObject(expected);
          }
        }
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
          check: "sameErrorCodeRulePath",
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
}, 180000);

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
      const calls = [
        { name: "execute_shell", arguments: { command: "touch denied" } },
        { name: "testmaster_capabilities", arguments: { command: "touch denied" } },
        {
          name: "testmaster_normalize_requirements",
          arguments: { projectId: other.id, sourceRevisionIds: [] },
        },
      ];
      for (const [index, call] of calls.entries()) {
        const result = await client.callTool(call);
        expect(result.isError).toBe(true);
        expect(mcpError(result).code).toBe(["NOT_FOUND", "INVALID_ARGUMENT", "FORBIDDEN"][index]);
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
