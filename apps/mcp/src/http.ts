import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  type Application,
  type AuthorizationIdentity,
  authenticateLocalToken,
} from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import { createMcpServer, type TestMasterMcp } from "./server.js";

export interface McpHttpRequest {
  application: Application;
  identity: AuthorizationIdentity;
  request: { raw: IncomingMessage; body?: unknown; headers: IncomingMessage["headers"] };
  reply: { raw: ServerResponse; hijack(): unknown };
}
export function createMcpHttpHandler(options: { roots: readonly string[]; maxSessions?: number }) {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; mcp: TestMasterMcp; authority: string }
  >();
  const handler = async ({
    application,
    identity,
    request,
    reply,
  }: McpHttpRequest): Promise<void> => {
    const authority = JSON.stringify(identity);
    const sessionId = request.headers["mcp-session-id"];
    let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (session && session.authority !== authority)
      throw new ContractError("FORBIDDEN", "MCP session authority does not match token");
    if (!session) {
      if (sessionId) throw new ContractError("NOT_FOUND", "MCP session is unavailable");
      if (!isInitializeRequest(request.body))
        throw new ContractError("INVALID_ARGUMENT", "Initialize MCP before using a session");
      if (sessions.size >= (options.maxSessions ?? 32))
        throw new ContractError("QUOTA_EXCEEDED", "MCP session limit reached");
      const token = request.headers.authorization?.slice(7) ?? "";
      const mcp = createMcpServer({
        application,
        roots: options.roots,
        authenticate: () => {
          authenticateLocalToken(application, token);
        },
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, mcp, authority });
        },
      });
      // SDK transport accessors explicitly include undefined, unlike its optional Transport properties under exactOptionalPropertyTypes.
      await mcp.connect(transport as Transport);
      mcp.server.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      session = { transport, mcp, authority };
    }
    reply.hijack();
    await session.transport.handleRequest(request.raw, reply.raw, request.body);
  };
  return {
    handler,
    async close(): Promise<void> {
      await Promise.all([...sessions.values()].map((session) => session.mcp.close()));
      sessions.clear();
    },
  };
}
