import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Application, entity, scaffoldPlan } from "@testmaster/application";
import { mcpToolCatalog, validateAgainstSchema } from "@testmaster/contracts";
import { assertionsHash } from "@testmaster/planner";
import { expect, it } from "vitest";
import { createMcpServer, type TestMasterMcp } from "./server.js";

it("SDK handshake advertises contract schemas, records protocol and dispatches M3 comparison", async () => {
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
      const missing = await client.callTool({
        name: "testmaster_compare_runs",
        arguments: { left: runId, right: runId },
      });
      expect(missing.isError).toBe(true);
      expect(JSON.parse(String((missing.content as { text: string }[])[0]?.text))).toMatchObject({
        error: { code: "NOT_FOUND" },
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

it("MCP analysis emits readable layers and unchanged JSON while reads need no execution scope", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-mcp-diagnosis-"));
  const app = await Application.open({ cwd, home: join(cwd, "home"), env: {} });
  const clients: Client[] = [];
  const servers: TestMasterMcp[] = [];
  try {
    const init = await app.init();
    const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
    const run = app.runs.resolve({ testId: test.id, environmentId: init.environmentId });
    Object.assign(run, { phase: "completed", status: "failed", outcome: "failed", gate: "failed" });
    app.context.entities.insert("Run", run);
    const connect = async (scopes: ("R" | "W" | "X")[]) => {
      const server = createMcpServer({ application: app.withIdentity({ principalId: init.principalId, scopes }), roots: [cwd] });
      servers.push(server);
      const [left, right] = InMemoryTransport.createLinkedPair();
      await server.connect(right);
      const client = new Client({ name: "diagnosis-test", version: "1" });
      clients.push(client);
      await client.connect(left);
      return client;
    };
    const executor = await connect(["R", "X"]);
    const analyzed = await executor.callTool({ name: "testmaster_analyze_run", arguments: { runId: run.id } });
    expect(analyzed.isError).not.toBe(true);
    const content = analyzed.content as { type: string; text: string }[];
    expect(content[0]?.text).toContain("Diagnosis\nFailure:");
    expect(content[0]?.text).toContain("Next step:");
    expect(content[0]?.text).toContain("Automatic healing:");
    expect(JSON.parse(content[1]?.text ?? "null")).toEqual(analyzed.structuredContent);
    expect(analyzed.structuredContent).toEqual(app.analysis.get(run.id));
    const reader = await connect(["R"]);
    const before = app.database.all("SELECT * FROM analyses");
    const read = await reader.callTool({ name: "testmaster_get_analysis", arguments: { runId: run.id } });
    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toEqual(analyzed.structuredContent);
    expect(app.database.all("SELECT * FROM analyses")).toEqual(before);
    const denied = await reader.callTool({ name: "testmaster_analyze_run", arguments: { runId: run.id } });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(String((denied.content as { text: string }[])[0]?.text)).error.code).toBe("FORBIDDEN");
    const empty = app.runs.resolve({ testId: test.id, environmentId: init.environmentId });
    app.context.entities.insert("Run", empty);
    const missing = await reader.callTool({ name: "testmaster_get_analysis", arguments: { runId: empty.id } });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(String((missing.content as { text: string }[])[0]?.text)).error.code).toBe("NOT_FOUND");

    const revision = app.revisions.get(String(run.revisionId));
    if (!revision.plan) throw new Error("Missing fixture plan");
    const proposal = entity(app.context, "hea", {
      failedRunId: run.id, testId: test.id, analysisId: null, baseRevisionId: revision.id,
      candidateRevisionId: revision.id, diff: "Manual review only", changes: [], evidenceRefs: [],
      preservedAssertionsHash: assertionsHash(revision.plan),
      risk: "read", status: "proposed", approvalMode: null, reviewerId: null, policyHash: null,
      verificationRunId: null, modelCallId: null, limitations: ["Multiple locator candidates require manual review"],
    });
    app.context.entities.insert("HealingProposal", proposal);
    const review = await reader.callTool({ name: "testmaster_review_healing", arguments: { proposalId: proposal.id } });
    expect(review.isError).not.toBe(true);
    const reviewContent = review.content as { text: string }[];
    expect(reviewContent[0]?.text).toContain("Healing review");
    expect(reviewContent[0]?.text).toContain("Multiple locator candidates require manual review");
    expect(reviewContent[0]?.text).toContain("--expected-version");
    expect(JSON.parse(reviewContent[1]?.text ?? "null")).toEqual(review.structuredContent);
    expect(review.structuredContent).toEqual(await app.healing.review(proposal.id));
    expect(app.context.entities.get("HealingProposal", init.workspaceId, proposal.id)).toEqual(proposal);
    const tools = (await reader.listTools()).tools;
    expect(tools.find((tool) => tool.name === "testmaster_review_healing")?.annotations?.readOnlyHint).toBe(true);
  } finally {
    for (const client of clients) await client.close();
    for (const server of servers) await server.close();
    app.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
