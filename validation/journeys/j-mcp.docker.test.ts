import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Application, issueLocalToken } from "@testmaster/application";
import { createServer } from "@testmaster/server";
import { expect, it } from "vitest";
import { cli, controlledShop, healthPlan, journey, object, text } from "./harness.js";

it("MCP-001–004 built CLI initialize/list/run/evidence, reattach, and HTTP token/Origin guards", async () => {
  await journey("mcp-001-004", async (session) => {
    const target = await controlledShop("healthy");
    let app: Application | undefined;
    try {
      const identity = await session.init(target.url);
      const test = await session.createTest(healthPlan());
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const issued = await issueLocalToken(app);
      await session.worker();
      const environment = Object.fromEntries(
        Object.entries(session.env).filter(
          (pair): pair is [string, string] => typeof pair[1] === "string",
        ),
      );
      const connect = async () => {
        const client = new Client({ name: "built-cli-journey", version: "1" });
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [
              cli,
              "--cwd",
              session.cwd,
              "mcp",
              "serve",
              "--transport",
              "stdio",
              "--token-file",
              issued.tokenPath,
            ],
            env: environment,
            stderr: "pipe",
          }),
        );
        return client;
      };
      let client = await connect();
      try {
        expect(
          (await client.listTools()).tools.some((tool) => tool.name === "testmaster_run_tests"),
        ).toBe(true);
        const args = {
          testIds: [text(test.id)],
          environmentId: text(identity.environmentId),
          mode: "replay",
          idempotencyKey: "mcp-journey-durable-0001",
        };
        const initial = await client.callTool({ name: "testmaster_run_tests", arguments: args });
        expect(initial.isError).not.toBe(true);
        const receipt = object(initial.structuredContent);
        const jobId = text(receipt.jobId);
        const runs = receipt.allMembers as string[];
        expect(runs).toHaveLength(1);
        await client.close();
        client = await connect();
        let progress = 0;
        const resumed = await client.callTool(
          { name: "testmaster_run_tests", arguments: { ...args, jobId, wait: true } },
          undefined,
          {
            timeout: 180000,
            onprogress: () => {
              progress++;
            },
          },
        );
        expect(resumed.isError).not.toBe(true);
        expect(object(resumed.structuredContent).allMembers).toEqual(runs);
        const duplicate = await client.callTool({ name: "testmaster_run_tests", arguments: args });
        expect(object(duplicate.structuredContent).jobId).toBe(jobId);
        expect(app.runs.list()).toHaveLength(1);
        const result = await client.callTool({
          name: "testmaster_get_run",
          arguments: { runId: runs[0] },
        });
        expect(result.structuredContent).toMatchObject({ outcome: "passed", gate: "passed" });
        expect(progress).toBeGreaterThan(0);
        session.runIds.push(text(runs[0]));
        let cursor: string | undefined;
        let count = 0;
        let pages = 0;
        let resource: string | undefined;
        do {
          const evidence = await client.callTool({
            name: "testmaster_get_evidence",
            arguments: { runId: runs[0], maxBytes: 900, ...(cursor ? { cursor } : {}) },
          });
          expect(evidence.isError, JSON.stringify(evidence.content)).not.toBe(true);
          const data = object(evidence.structuredContent);
          expect(data.integrity).toBe("verified");
          const entries = object(data.manifest).entries as unknown[];
          count += entries.length;
          pages++;
          resource ??= (data.resources as string[])[0];
          expect(
            (evidence.content as { type: string }[]).some(
              (entry) => entry.type === "resource_link",
            ),
          ).toBe((data.resources as string[]).length > 0);
          cursor = typeof data.nextCursor === "string" ? data.nextCursor : undefined;
        } while (cursor);
        expect(pages).toBeGreaterThan(1);
        expect(count).toBe((await session.committed(text(runs[0]))).manifest.entries.length);
        expect(resource).toBeDefined();
        const page = await client.readResource({ uri: text(resource) });
        const content = object(JSON.parse(String(page.contents[0]?.text)));
        expect(content.encoding).toBe("base64");
        expect(Buffer.from(text(content.data), "base64").length).toBeGreaterThan(0);
        session.oracles.push({
          check: "mcpDurableResumeAndVerifiedEvidence",
          jobId,
          runId: runs[0],
          pages,
          artifactCount: count,
          progress,
        });
      } finally {
        await client.close();
      }
      const http = await createServer({ application: app, origins: ["http://localhost:9090"] });
      try {
        const address = await http.listen({ host: "127.0.0.1", port: 0 });
        const payload = {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        };
        expect(
          (
            await fetch(`${address}/mcp`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            })
          ).status,
        ).toBe(401);
        expect(
          (
            await fetch(`${address}/mcp`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${issued.token}`,
                Origin: "https://evil.example",
              },
              body: JSON.stringify(payload),
            })
          ).status,
        ).toBe(403);
        const client = new Client({ name: "http-journey", version: "1" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${issued.token}` } },
          }),
        );
        try {
          expect((await client.listTools()).tools.length).toBeGreaterThan(0);
          const capability = await client.callTool({
            name: "testmaster_capabilities",
            arguments: {},
          });
          expect(capability.structuredContent?.protocolVersion).toBe("2025-11-25");
        } finally {
          await client.close();
        }
      } finally {
        await http.close();
      }
    } finally {
      app?.close();
      await target.close();
    }
  });
}, 240000);
