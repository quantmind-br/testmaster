import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Application } from "@testmaster/application";
import { mcpToolCatalog, validateAgainstSchema } from "@testmaster/contracts";
import { expect, it } from "vitest";
import { createMcpServer } from "./server.js";

it("SDK handshake advertises contract schemas, records protocol and refuses M3", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "tm-mcp-"));
  const cwd = join(temporary, "repo");
  await mkdir(cwd);
  const app = await Application.open({
    cwd,
    home: join(temporary, "home"),
    env: { TESTMASTER_DATA_DIR: join(temporary, "data") },
  });
  try {
    const initialized = await app.init();
    const mcp = createMcpServer({
      application: app.withIdentity({
        principalId: initialized.principalId,
        scopes: ["R", "W", "X"],
      }),
      roots: [cwd],
    });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await mcp.connect(right);
    const client = new Client({ name: "security-test", version: "1" });
    await client.connect(left);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual(mcpToolCatalog.map((tool) => tool.name));
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.outputSchema?.type).toBe("object");
        const schema = { ...tool.inputSchema };
        delete schema.$id;
        expect(() => validateAgainstSchema(schema, {})).not.toThrowError(
          /compile|schema is invalid/,
        );
      }
      const capabilities = await client.callTool({
        name: "testmaster_capabilities",
        arguments: {},
      });
      expect(capabilities.isError).not.toBe(true);
      expect(capabilities.structuredContent?.protocolVersion).toBe("2025-11-25");
      const runId = "run_019bf434-20c0-7000-8000-000000000001";
      const denied = await client.callTool({
        name: "testmaster_compare_runs",
        arguments: { left: runId, right: runId },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.parse(String((denied.content as { text: string }[])[0]?.text))).toMatchObject({
        error: { code: "CAPABILITY_UNAVAILABLE", details: { milestone: "M3" } },
      });
    } finally {
      await client.close();
      await mcp.close();
    }
  } finally {
    app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

it("MCP enforces token scopes, configured/client roots and symlink confinement before services", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "tm-mcp-security-"));
  const cwd = join(temporary, "repo");
  const outside = join(temporary, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  await writeFile(join(outside, "private.ts"), "export const secret = 1");
  await symlink(outside, join(cwd, "escape"));
  const app = await Application.open({
    cwd,
    home: join(temporary, "home"),
    env: { TESTMASTER_DATA_DIR: join(temporary, "data") },
  });
  try {
    const identity = await app.init();
    const [left, right] = InMemoryTransport.createLinkedPair();
    const mcp = createMcpServer({
      application: app.withIdentity({ principalId: identity.principalId, scopes: ["R"] }),
      roots: [cwd],
    });
    await mcp.connect(right);
    const client = new Client({ name: "read-only", version: "1" });
    await client.connect(left);
    const denied = await client.callTool({
      name: "testmaster_run_tests",
      arguments: { testIds: [], environmentId: identity.environmentId, mode: "replay" },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(String((denied.content as { text: string }[])[0]?.text))).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    const writeDenied = await client.callTool({
      name: "testmaster_bootstrap",
      arguments: { projectRoot: cwd, target: "codex", scope: ["R"], mode: "replay" },
    });
    expect(writeDenied.isError).toBe(true);
    expect(JSON.parse(String((writeDenied.content as { text: string }[])[0]?.text))).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    const secretArgument = await client.callTool({
      name: "testmaster_run_tests",
      arguments: {
        testIds: [],
        environmentId: identity.environmentId,
        mode: "replay",
        password: "not-a-secret-ref",
      },
    });
    expect(secretArgument.isError).toBe(true);
    expect(
      JSON.parse(String((secretArgument.content as { text: string }[])[0]?.text)),
    ).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
    expect(app.runs.list()).toHaveLength(0);
    await client.close();
    await mcp.close();
    const elevated = createMcpServer({
      application: app.withIdentity({ principalId: identity.principalId, scopes: ["R", "W", "X"] }),
      roots: [cwd],
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await elevated.connect(b);
    const writer = new Client({ name: "writer", version: "1" }, { capabilities: { roots: {} } });
    writer.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: [{ uri: pathToFileURL(cwd).href }],
    }));
    await writer.connect(a);
    for (const root of [outside, join(cwd, "escape")]) {
      const result = await writer.callTool({
        name: "testmaster_analyze_code",
        arguments: { projectId: identity.projectId, root },
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(String((result.content as { text: string }[])[0]?.text))).toMatchObject({
        error: { code: "FORBIDDEN" },
      });
    }
    writer.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [] }));
    const excluded = await writer.callTool({
      name: "testmaster_bootstrap",
      arguments: { projectRoot: cwd, target: "codex", scope: ["R"], mode: "replay" },
    });
    expect(excluded.isError).toBe(true);
    expect(JSON.parse(String((excluded.content as { text: string }[])[0]?.text))).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    await writer.close();
    await elevated.close();
    expect(app.projects.list()).toHaveLength(1);
  } finally {
    app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
