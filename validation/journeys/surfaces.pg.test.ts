import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, scaffoldPlan } from "@testmaster/application";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ServerStack, type StackUser, startServerStack } from "./server-stack.js";
import {
  type McpAnswer,
  type McpSession,
  openMcp,
  remoteCli,
  signedInClient,
} from "./surface-clients.js";
import type { HttpsClient } from "./tls-proxy.js";

/**
 * One operation, three surfaces. A browser session (the portal API), the remote-mode CLI and MCP
 * over HTTPS all reach the same persisted Run through the same server, with the same credential
 * semantics: the same object and revision afterwards, the same refusal for a viewer, and the same
 * end of access when a token is revoked.
 */
interface Seen {
  id: string;
  status: string;
  outcome: string | null;
  phase: string;
  gate: string | null;
}

let stack: ServerStack;
let workspaceId = "";
let owner: StackUser;
let viewer: StackUser;
let ownerSession: HttpsClient;
let viewerSession: HttpsClient;
let ownerToken = "";
let viewerToken = "";
let controller: Application;
let configDirectory: string;
let caFile: string;
let testId = "";
let revisionId = "";
let environmentRevisionId = "";

function seedRun(label: string): string {
  const app = controller.forWorkspaceSystem(workspaceId);
  const id = uuidV7IdGenerator.next("run");
  app.context.entities.insert("Run", {
    id,
    workspaceId,
    createdAt: new Date().toISOString(),
    testId,
    revisionId,
    environmentRevisionId,
    batchId: null,
    matrixCell: { label },
    mode: "replay",
    phase: "queued",
    status: "queued",
    outcome: null,
    origin: "surface-parity",
    gatePolicy: {},
    gate: "pending",
    cleanupOutcome: "not_required",
    analysisStatus: "not_requested",
  });
  return id;
}

function stored(runId: string): { version: number; status: string; phase: string } {
  const row = controller
    .forWorkspaceSystem(workspaceId)
    .database.get(
      "SELECT version,status,phase FROM runs WHERE workspace_id=? AND id=?",
      workspaceId,
      runId,
    );
  return {
    version: Number(row?.version),
    status: String(row?.status),
    phase: String(row?.phase),
  };
}

const seen = (run: Record<string, unknown>): Seen => ({
  id: String(run.id ?? run.runId),
  status: String(run.status),
  outcome: run.outcome === null || run.outcome === undefined ? null : String(run.outcome),
  phase: String(run.phase),
  gate: run.gate === null || run.gate === undefined ? null : String(run.gate),
});

function bearer(token: string) {
  const client = stack.anonymous();
  return {
    get: (path: string) =>
      client.request("GET", path, {
        headers: { authorization: `Bearer ${token}` },
        cookies: false,
      }),
    mutate: (method: string, path: string, body: unknown) =>
      client.request(method, path, {
        body,
        headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
        cookies: false,
      }),
  };
}

const cliOptions = () => ({ caFile, configHome: join(configDirectory, "xdg") });

/** One initialized MCP session per token: each call is then a single request against the actor rate limit. */
const mcpSessions = new Map<string, McpSession>();
async function mcpFor(token: string): Promise<McpSession> {
  const existing = mcpSessions.get(token);
  if (existing) return existing;
  const opened = await openMcp(stack, token);
  mcpSessions.set(token, opened);
  return opened;
}

/** Structured payload of an MCP answer, wherever the server put it. */
function mcpPayload(answer: McpAnswer): Record<string, unknown> {
  const structured = answer.result?.structuredContent;
  if (structured) return structured;
  const text = answer.result?.content?.[0]?.text;
  if (!text) throw new Error(`MCP answer has no payload: ${answer.raw}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/** The Run as each surface reports it, plus the ETag of the REST read. */
async function readEverywhere(runId: string, session: HttpsClient, token: string) {
  const portal = await session.request("GET", `/v1/runs/${runId}`);
  expect(portal.status, "portal API read").toBe(200);
  const portalRun = portal.json<{ data: Record<string, unknown> }>().data;
  const cliRead = await remoteCli<Record<string, unknown>>(stack, cliOptions(), token, [
    "run",
    "get",
    runId,
  ]);
  expect(cliRead.code, `CLI read: ${JSON.stringify(cliRead.document)}`).toBe(0);
  const mcp = await (await mcpFor(token)).call("testmaster_get_run", { runId });
  expect(mcp.result?.isError, `MCP read: ${mcp.raw}`).not.toBe(true);
  const mcpPayloadRun = mcpPayload(mcp);
  const mcpRun = (mcpPayloadRun.run ?? mcpPayloadRun) as Record<string, unknown>;
  return {
    portal: seen(portalRun),
    cli: seen(cliRead.document.data as Record<string, unknown>),
    mcp: seen(mcpRun),
    etag: String(portal.headers.etag),
    // The MCP RunResult does not carry the revision; REST and the CLI both report the Run itself.
    revisions: {
      portal: String(portalRun.revisionId),
      cli: String((cliRead.document.data as Record<string, unknown>).revisionId),
    },
  };
}

beforeAll(async () => {
  stack = await startServerStack({ workspaces: 1 });
  workspaceId = stack.workspaceId;
  owner = stack.owner;
  viewer = await stack.addMember("viewer");
  ownerSession = await signedInClient(stack, owner);
  viewerSession = await signedInClient(stack, viewer);
  ownerToken = await stack.issueToken(owner.principalId, ["R", "W", "X", "A"]);
  viewerToken = await stack.issueToken(viewer.principalId, ["R"]);
  controller = await stack.scope();
  vi.spyOn(Application.prototype, "preflight").mockResolvedValue();
  const app = controller.forWorkspaceSystem(workspaceId);
  const project = app.projects.create({ name: "Surface parity shop" });
  const test = app.tests.create({ projectId: project.id, plan: scaffoldPlan("backend") });
  testId = test.id;
  revisionId = String(test.activeRevisionId);
  const environment = app.environments.create({
    projectId: project.id,
    name: "staging",
    baseUrl: "http://127.0.0.1:9",
  });
  environmentRevisionId = String(app.environments.get(environment.id).activeRevisionId);
  configDirectory = await mkdtemp(join(tmpdir(), "tm-surfaces-"));
  caFile = join(configDirectory, "ca.pem");
  await writeFile(caFile, stack.ca.caPem);
}, 600_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await stack?.stop();
  if (configDirectory) await rm(configDirectory, { recursive: true, force: true });
});

describe("one operation through the portal API, the remote CLI and MCP", () => {
  it("UX-001 M4-01 cancelling a Run through the portal session, the remote CLI and MCP persists the same object and revision", async () => {
    const runs = { portal: seedRun("portal"), cli: seedRun("cli"), mcp: seedRun("mcp") };
    const receipts: Record<string, { result?: string; status?: string }> = {};
    for (const surface of ["portal", "cli", "mcp"] as const) {
      const runId = runs[surface];
      const before = await readEverywhere(runId, ownerSession, ownerToken);
      expect(before.portal, `${surface} before`).toMatchObject({
        status: "queued",
        phase: "queued",
      });
      expect(before.cli, `${surface} before`).toEqual(before.portal);
      expect(before.mcp, `${surface} before`).toEqual(before.portal);
      expect(before.etag).toBe(`"${stored(runId).version}"`);

      if (surface === "portal") {
        const cancelled = await ownerSession.mutate("POST", `/v1/runs/${runId}/cancel`, {});
        expect(cancelled.status).toBe(200);
        receipts.portal = cancelled.json<{ data: { result: string; status: string } }>().data;
      } else if (surface === "cli") {
        const cancelled = await remoteCli<{ result: string; status: string }>(
          stack,
          cliOptions(),
          ownerToken,
          ["run", "cancel", runId],
        );
        expect(cancelled.code, JSON.stringify(cancelled.document)).toBe(0);
        receipts.cli = cancelled.document.data as { result: string; status: string };
      } else {
        const cancelled = await (await mcpFor(ownerToken)).call("testmaster_cancel_run", {
          runId,
          reason: "surface parity",
        });
        expect(cancelled.result?.isError, cancelled.raw).not.toBe(true);
        receipts.mcp = mcpPayload(cancelled) as { result: string; status: string };
      }

      // The same persisted object, whichever surface changed it and whichever reads it.
      const after = await readEverywhere(runId, ownerSession, ownerToken);
      expect(after.portal, `${surface} after`).toMatchObject({
        status: "cancelled",
        outcome: "cancelled",
        phase: "completed",
        gate: "failed",
      });
      expect(after.revisions, `${surface} revision`).toEqual({
        portal: revisionId,
        cli: revisionId,
      });
      expect(after.cli, `${surface} after`).toEqual(after.portal);
      expect(after.mcp, `${surface} after`).toEqual(after.portal);
      // One revision step, visible as the ETag, equal to what the database holds.
      expect(after.etag).toBe(`"${stored(runId).version}"`);
      expect(stored(runId).version).toBe(Number(before.etag.replaceAll('"', "")) + 1);
      expect(stored(runId)).toMatchObject({ status: "cancelled", phase: "completed" });
    }
    // The receipts agree: the same operation answered the same way on every surface.
    expect(receipts.cli).toMatchObject({ result: "requested", status: "cancelled" });
    expect(receipts.mcp).toMatchObject({
      result: receipts.portal?.result,
      status: receipts.portal?.status,
    });
    expect(receipts.cli).toMatchObject({
      result: receipts.portal?.result,
      status: receipts.portal?.status,
    });
    // Repeating it from another surface is the same no-op answer everywhere and moves no revision.
    const settled = stored(runs.portal).version;
    const repeatedCli = await remoteCli<{ result: string }>(stack, cliOptions(), ownerToken, [
      "run",
      "cancel",
      runs.portal,
    ]);
    const repeatedMcp = await (await mcpFor(ownerToken)).call("testmaster_cancel_run", {
      runId: runs.portal,
      reason: "again",
    });
    const repeatedPortal = await ownerSession.mutate("POST", `/v1/runs/${runs.portal}/cancel`, {});
    expect(repeatedCli.document.data?.result).toBe("already_terminal");
    expect(mcpPayload(repeatedMcp).result).toBe("already_terminal");
    expect(repeatedPortal.json<{ data: { result: string } }>().data.result).toBe(
      "already_terminal",
    );
    expect(stored(runs.portal).version).toBe(settled);
  }, 240_000);

  it("UX-001 UX-005 a viewer is refused the same operation on every surface, and the Run keeps its state and revision", async () => {
    const runId = seedRun("guard");
    const before = stored(runId);
    // Positive control: the viewer reads the Run on every surface.
    const readable = await readEverywhere(runId, viewerSession, viewerToken);
    expect(readable.portal).toMatchObject({ status: "queued" });
    expect(readable.cli).toEqual(readable.portal);
    expect(readable.mcp).toEqual(readable.portal);

    const portal = await viewerSession.mutate("POST", `/v1/runs/${runId}/cancel`, {});
    const rest = await bearer(viewerToken).mutate("POST", `/v1/runs/${runId}/cancel`, {});
    const cli = await remoteCli(stack, cliOptions(), viewerToken, ["run", "cancel", runId]);
    const mcp = await (await mcpFor(viewerToken)).call("testmaster_cancel_run", {
      runId,
      reason: "not allowed",
    });
    expect(portal.status).toBe(403);
    expect(rest.status).toBe(403);
    expect(portal.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
    expect(rest.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
    expect(cli.code).not.toBe(0);
    expect(cli.document.error?.code).toBe("FORBIDDEN");
    expect(mcp.result?.isError === true || mcp.error !== undefined, mcp.raw).toBe(true);
    expect(mcp.raw).toMatch(/FORBIDDEN|not authorized/i);
    // Nothing moved: state, phase and revision are exactly as before the four attempts.
    expect(stored(runId)).toEqual(before);

    // The viewer's refusal is the credential's, not the Run's: the owner cancels it on any surface.
    const owner = await remoteCli<{ result: string }>(stack, cliOptions(), ownerToken, [
      "run",
      "cancel",
      runId,
    ]);
    expect(owner.document.data?.result).toBe("requested");
    expect(stored(runId).status).toBe("cancelled");
  }, 240_000);

  it("UX-001 M4-01 revoking a token ends it on the portal API, the remote CLI and MCP at once", async () => {
    const admin = await stack.addMember("org_admin");
    const adminSession = await signedInClient(stack, admin);
    const issued = await adminSession.mutate("POST", "/v1/tokens", {
      name: "surface parity",
      scopes: ["R"],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(issued.status).toBe(201);
    const { token, metadata } = issued.json<{ data: { token: string; metadata: { id: string } } }>()
      .data;
    const runId = seedRun("revocation");
    // Positive control on every surface while the token is live, MCP over a session opened before revocation.
    const live = await mcpFor(token);
    expect((await bearer(token).get(`/v1/runs/${runId}`)).status).toBe(200);
    expect((await remoteCli(stack, cliOptions(), token, ["run", "get", runId])).code).toBe(0);
    expect((await live.call("testmaster_get_run", { runId })).result?.isError).not.toBe(true);

    expect(
      (await adminSession.mutate("DELETE", `/v1/tokens/${metadata.id}`, undefined)).status,
    ).toBe(200);
    const rest = await bearer(token).get(`/v1/runs/${runId}`);
    const cli = await remoteCli(stack, cliOptions(), token, ["run", "get", runId]);
    const mcp = await live.call("testmaster_get_run", { runId });
    const fresh = await openMcp(stack, token);
    const reopened = await fresh.call("testmaster_get_run", { runId });
    expect(rest.status).toBe(401);
    expect(cli.code).not.toBe(0);
    expect(cli.document.error?.code).toBe("UNAUTHENTICATED");
    expect(mcp.status).toBe(401);
    expect(mcp.raw).not.toContain(runId);
    expect(reopened.status).toBe(401);
  }, 240_000);
});
