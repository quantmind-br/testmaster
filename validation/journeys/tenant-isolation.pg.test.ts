import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, scaffoldPlan } from "@testmaster/application";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FileEvidenceStore } from "../../packages/evidence/src/index.js";
import { cli } from "./harness.js";
import { type ServerStack, startServerStack } from "./server-stack.js";

/**
 * Two organizations in one PostgreSQL database behind the real server profile (child process,
 * TLS proxy, RLS owner role). Every probe is made as tenant B against tenant A's data and compared
 * with a request for an identifier that does not exist, so no answer reveals whether A's object
 * exists. A positive control with A's own credential precedes every denial.
 */
const canary = "CANARY-tenant-a-secret-5d1e";
const sharedBytes = Buffer.from("identical artifact bytes in both tenants\n".repeat(64));
const sharedHash = createHash("sha256").update(sharedBytes).digest("hex");

interface Tenant {
  workspaceId: string;
  projectId: string;
  environmentId: string;
  testId: string;
  runIds: string[];
  artifactId: string;
  secretId: string;
  storageKey: string;
  token: string;
  ownerPrincipalId: string;
}

let stack: ServerStack;
let a: Tenant;
let b: Tenant;
let caFile: string;
let caDirectory: string;

async function seed(
  controller: Application,
  index: number,
  label: string,
  evidenceRoot: string,
): Promise<Tenant> {
  const workspace = stack.workspaces[index] as {
    workspaceId: string;
    owner: { principalId: string };
  };
  const app = controller.forWorkspaceSystem(workspace.workspaceId);
  const project = app.projects.create({ name: `${label} shop` });
  const environment = app.environments.create({
    projectId: project.id,
    name: "staging",
    baseUrl: "http://127.0.0.1:9",
  });
  const test = app.tests.create({ projectId: project.id, plan: scaffoldPlan("backend") });
  const secret = await app.secrets.set("payments-key", `${label}-${canary}`, {
    allowedOrigins: ["http://127.0.0.1:9"],
  });
  // Admission checks for a live worker before it looks up the objects it was asked to run.
  app.context.entities.insert("Worker", {
    id: uuidV7IdGenerator.next("wrk"),
    workspaceId: workspace.workspaceId,
    identityRef: `tenant-isolation-${label}`,
    capabilities: ["http"],
    imageDigests: [],
    labels: {},
    state: "ready",
    lastHeartbeatAt: new Date().toISOString(),
  });
  const revisionId = String(test.activeRevisionId);
  const environmentRevisionId = app.environments.get(environment.id).activeRevisionId;
  const now = new Date().toISOString();
  const runIds: string[] = [];
  let artifactId = "";
  let storageKey = "";
  for (let n = 0; n < 2; n++) {
    const runId = uuidV7IdGenerator.next("run");
    runIds.push(runId);
    app.context.entities.insert("Run", {
      id: runId,
      workspaceId: workspace.workspaceId,
      createdAt: new Date(Date.parse(now) + n).toISOString(),
      testId: test.id,
      revisionId,
      environmentRevisionId,
      batchId: null,
      matrixCell: {},
      mode: "replay",
      phase: "completed",
      status: "passed",
      outcome: "passed",
      origin: "tenant-isolation",
      gatePolicy: {},
      gate: "passed",
      cleanupOutcome: "not_required",
      analysisStatus: "not_requested",
    });
    if (n > 0) continue;
    const attemptId = uuidV7IdGenerator.next("att");
    const snapshotId = uuidV7IdGenerator.next("snp");
    const jobId = uuidV7IdGenerator.next("job");
    app.database.run(
      "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,state,available_at,fence) VALUES(?,?,?,?,?,?,?,1)",
      workspace.workspaceId,
      jobId,
      now,
      "execution",
      runId,
      "completed",
      now,
    );
    app.context.entities.insert(
      "Attempt",
      {
        id: attemptId,
        workspaceId: workspace.workspaceId,
        createdAt: now,
        runId,
        number: 1,
        workerId: null,
        seed: 0,
        phase: "completed",
        startedAt: now,
        endedAt: now,
        outcome: "passed",
      },
      { jobId, fence: 1, leaseOwner: "tenant-isolation" },
    );
    const stage = await new FileEvidenceStore({ rootDir: evidenceRoot }).openAttempt({
      workspaceId: workspace.workspaceId,
      runId,
      attemptId,
      snapshotId,
      revisionId,
    });
    const writer = await stage.beginArtifact({
      relativePath: "shared.txt",
      kind: "download",
      mimeType: "text/plain",
    });
    await writer.write(sharedBytes);
    const entry = await writer.end();
    const committed = await stage.commit({ redactionPolicyHash: "0".repeat(64) });
    app.context.entities.insert("Snapshot", {
      id: snapshotId,
      workspaceId: workspace.workspaceId,
      createdAt: now,
      runId,
      attemptId,
      revisionId,
      manifestHash: committed.manifestSha256,
      committedAt: now,
      redactionPolicyHash: "0".repeat(64),
    });
    artifactId = entry.artifactId;
    storageKey = `runs/${workspace.workspaceId}/${runId}/${attemptId}/${entry.relativePath}`;
    app.context.entities.insert("Artifact", {
      id: artifactId,
      workspaceId: workspace.workspaceId,
      createdAt: now,
      runId,
      attemptId,
      revisionId,
      snapshotId,
      kind: entry.kind,
      hash: entry.sha256,
      bytes: entry.sizeBytes,
      mime: entry.mimeType,
      redactionStatus: entry.redactionStatus,
      storageKey,
      state: entry.state,
    });
  }
  return {
    workspaceId: workspace.workspaceId,
    projectId: project.id,
    environmentId: environment.id,
    testId: test.id,
    runIds,
    artifactId,
    secretId: secret.id,
    storageKey,
    token: await stack.issueToken(workspace.owner.principalId, ["R", "W", "X", "A"], [], index),
    ownerPrincipalId: workspace.owner.principalId,
  };
}

beforeAll(async () => {
  stack = await startServerStack({ workspaces: 2 });
  const controller = await stack.scope();
  vi.spyOn(Application.prototype, "preflight").mockResolvedValue();
  const evidenceRoot = controller.config.dataDir;
  a = await seed(controller, 0, "A", evidenceRoot);
  b = await seed(controller, 1, "B", evidenceRoot);
  caDirectory = await mkdtemp(join(tmpdir(), "tm-isolation-ca-"));
  caFile = join(caDirectory, "ca.pem");
  await writeFile(caFile, stack.ca.caPem);
}, 600_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await stack?.stop();
  if (caDirectory) await rm(caDirectory, { recursive: true, force: true });
});

const bearer = (token: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  ...extra,
});
function get(token: string, path: string, headers: Record<string, string> = {}) {
  return stack
    .anonymous()
    .request("GET", path, { headers: bearer(token, headers), cookies: false });
}
function send(
  token: string,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return stack.anonymous().request(method, path, {
    ...(body === undefined ? {} : { body }),
    headers: bearer(token, {
      origin: stack.baseUrl,
      "idempotency-key": randomUUID(),
      ...headers,
    }),
    cookies: false,
  });
}
interface Envelope {
  data?: {
    items?: { id: string }[];
    nextCursor?: string | null;
    id?: string;
    workspaceId?: string;
  };
  error?: { code: string; message: string };
}
const envelope = (response: { json<T>(): T }) => response.json<Envelope>();

/** Normalizes the per-request ID and every typed identifier so two refusals can be compared byte for byte. */
const scrub = (text: string) =>
  text
    .replace(/"requestId":"[^"]+"/g, '"requestId":"<request>"')
    .replace(/\b(prj|tst|env|run|art|sec)_[0-9a-f]{8}-[0-9a-f-]{27}\b/g, "<id>");
describe("tenant isolation through the server profile", () => {
  it("SEC-030 NFR-003 M4-01 tenant B reading tenant A's objects by identifier gets the answer for a missing identifier", async () => {
    const missing = {
      project: "prj_01900000-0000-7000-8000-00000000dead",
      test: "tst_01900000-0000-7000-8000-00000000dead",
      environment: "env_01900000-0000-7000-8000-00000000dead",
      run: "run_01900000-0000-7000-8000-00000000dead",
      artifact: "art_01900000-0000-7000-8000-00000000dead",
    };
    const paths = (ids: {
      project: string;
      test: string;
      environment: string;
      run: string;
      artifact: string;
    }) => [
      `/v1/projects/${ids.project}`,
      `/v1/projects/${ids.project}/tests`,
      `/v1/projects/${ids.project}/environments`,
      `/v1/tests/${ids.test}`,
      `/v1/environments/${ids.environment}`,
      `/v1/runs/${ids.run}`,
      `/v1/runs/${ids.run}/steps`,
      `/v1/runs/${ids.run}/bundle`,
      `/v1/artifacts/${ids.artifact}`,
    ];
    const own = paths({
      project: a.projectId,
      test: a.testId,
      environment: a.environmentId,
      run: a.runIds[0] as string,
      artifact: a.artifactId,
    });
    const absent = paths(missing);
    for (const [index, path] of own.entries()) {
      // Positive control: the owner of the object reads it.
      const granted = await get(a.token, path);
      expect(granted.status, `A ${path}`).toBe(200);
      const foreign = await get(b.token, path);
      const unknown = await get(b.token, absent[index] as string);
      expect(foreign.status, `B ${path}`).toBe(unknown.status);
      expect(foreign.status, `B ${path}`).not.toBe(200);
      expect(envelope(foreign).error?.code, `B ${path}`).toBe(envelope(unknown).error?.code);
      // Same body once the request ID and the identifier the caller itself sent are normalized.
      expect(scrub(foreign.text), `B ${path}`).toBe(scrub(unknown.text));
      expect(foreign.text).not.toContain(canary);
    }
    // The same holds for a browser session of B: cookie credentials do not widen the scope.
    const session = await stack.ownerClient(1).request("GET", `/v1/runs/${a.runIds[0]}`);
    expect(session.status).toBe(404);
    // Mutations by identifier are refused the same way and change nothing in A.
    const before = (await get(a.token, "/v1/runs")).json<Envelope>().data?.items?.length;
    const attempts: [string, string, unknown, Record<string, string>][] = [
      ["PATCH", `/v1/projects/${a.projectId}`, { name: "Hijacked" }, { "if-match": '"1"' }],
      ["POST", `/v1/runs/${a.runIds[0]}/cancel`, {}, {}],
      ["POST", "/v1/runs", { testId: a.testId, environmentId: b.environmentId }, {}],
      ["POST", "/v1/runs", { testId: b.testId, environmentId: a.environmentId }, {}],
      ["DELETE", `/v1/environments/${a.environmentId}`, undefined, { "if-match": '"1"' }],
    ];
    for (const [method, path, body, headers] of attempts) {
      const refused = await send(b.token, method, path, body, headers);
      expect(refused.status, `${method} ${path} -> ${refused.text}`).toBe(404);
    }
    expect((await get(a.token, "/v1/runs")).json<Envelope>().data?.items?.length).toBe(before);
    const project = await get(a.token, `/v1/projects/${a.projectId}`);
    expect(envelope(project).data).toMatchObject({ id: a.projectId, name: "A shop" });
  });

  it("SEC-030 NFR-003 list filters and cursors never cross the tenant boundary", async () => {
    const listed = envelope(await get(b.token, "/v1/runs")).data?.items?.map((run) => run.id);
    expect([...(listed ?? [])].sort()).toEqual([...b.runIds].sort());
    // A filter naming A's project or test yields nothing of A's.
    for (const query of [`projectId=${a.projectId}`, `testId=${a.testId}`]) {
      const filtered = await get(b.token, `/v1/runs?${query}`);
      const ids = envelope(filtered).data?.items?.map((run) => run.id) ?? [];
      expect(
        ids.filter((id) => a.runIds.includes(id)),
        query,
      ).toEqual([]);
    }
    // A's first page carries a cursor; B cannot continue it, but can continue its own.
    const firstA = envelope(await get(a.token, "/v1/runs?limit=1")).data;
    expect(firstA?.items).toHaveLength(1);
    expect(firstA?.nextCursor).toBeTruthy();
    const reusedByB = await get(
      b.token,
      `/v1/runs?limit=1&cursor=${encodeURIComponent(String(firstA?.nextCursor))}`,
    );
    expect(reusedByB.status).toBe(400);
    expect(envelope(reusedByB).error?.code).toBe("INVALID_ARGUMENT");
    const firstB = envelope(await get(b.token, "/v1/runs?limit=1")).data;
    const nextB = await get(
      b.token,
      `/v1/runs?limit=1&cursor=${encodeURIComponent(String(firstB?.nextCursor))}`,
    );
    expect(nextB.status).toBe(200);
    expect(envelope(nextB).data?.items?.every((run) => b.runIds.includes(run.id))).toBe(true);
    const nextA = await get(
      a.token,
      `/v1/runs?limit=1&cursor=${encodeURIComponent(String(firstA?.nextCursor))}`,
    );
    expect(nextA.status).toBe(200);
  });

  it("SEC-030 NFR-003 an event stream of tenant A's Run is not served to tenant B", async () => {
    const stream = (token: string, runId: string) => {
      const { promise, resolve, reject } = Promise.withResolvers<{
        status: number;
        body: string;
      }>();
      const url = new URL(`/v1/runs/${runId}/events`, stack.baseUrl);
      const call = httpsRequest(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "GET",
          headers: { accept: "text/event-stream", authorization: `Bearer ${token}` },
          ca: stack.ca.caPem,
        },
        (response) => {
          let body = "";
          const finish = () => {
            call.destroy();
            resolve({ status: response.statusCode ?? 0, body });
          };
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
            if (body.includes("\n\n")) finish();
          });
          response.on("end", finish);
        },
      );
      call.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
      });
      call.setTimeout(10_000, () => call.destroy(new Error("stream timed out")));
      call.end();
      return promise;
    };
    const own = await stream(a.token, a.runIds[0] as string);
    expect(own.status).toBe(200);
    const foreign = await stream(b.token, a.runIds[0] as string);
    expect(foreign.status).toBe(404);
    expect(foreign.body).not.toContain("event:");
    const unknown = await stream(b.token, "run_01900000-0000-7000-8000-00000000dead");
    expect(unknown.status).toBe(404);
    expect(scrub(foreign.body)).toBe(scrub(unknown.body));
  });

  it("SEC-030 NFR-003 M4-01 the MCP HTTP tools answer tenant B's token only about tenant B's Runs", async () => {
    const mcp = async (token: string, tool: string, args: Record<string, unknown>) => {
      const client = stack.anonymous();
      const headers = bearer(token, {
        accept: "application/json, text/event-stream",
        origin: stack.baseUrl,
      });
      const parse = (text: string) => {
        const line = text.split("\n").find((value) => value.startsWith("data:"));
        return JSON.parse(line ? line.slice(5) : text) as {
          result?: {
            isError?: boolean;
            structuredContent?: Record<string, unknown>;
            content?: { text: string }[];
          };
          error?: { message: string };
        };
      };
      const initialized = await client.request("POST", "/mcp", {
        headers,
        cookies: false,
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "tenant-isolation", version: "1" },
          },
        },
      });
      expect(initialized.status).toBe(200);
      const session = String(initialized.headers["mcp-session-id"]);
      const sessionHeaders = {
        ...headers,
        "mcp-session-id": session,
        "mcp-protocol-version": "2025-06-18",
      };
      await client.request("POST", "/mcp", {
        headers: sessionHeaders,
        cookies: false,
        body: { jsonrpc: "2.0", method: "notifications/initialized" },
      });
      const called = await client.request("POST", "/mcp", {
        headers: sessionHeaders,
        cookies: false,
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: tool, arguments: args },
        },
      });
      return { status: called.status, ...parse(called.text), raw: called.text };
    };
    const runA = a.runIds[0] as string;
    const own = await mcp(a.token, "testmaster_get_run", { runId: runA });
    expect(own.result?.isError, own.raw).not.toBe(true);
    expect(own.raw).toContain(runA);
    for (const tool of ["testmaster_get_run", "testmaster_get_evidence"]) {
      const foreign = await mcp(b.token, tool, { runId: runA });
      expect(
        foreign.result?.isError === true || foreign.error !== undefined,
        `${tool}: ${foreign.raw}`,
      ).toBe(true);
      expect(foreign.raw).not.toContain(a.projectId);
      expect(foreign.raw).not.toContain("passed");
    }
    // Negative control for the probe itself: B's own Run is readable through its own token.
    const ownB = await mcp(b.token, "testmaster_get_run", { runId: b.runIds[0] as string });
    expect(ownB.result?.isError, ownB.raw).not.toBe(true);
  });

  it("SEC-030 NFR-003 M4-01 the remote CLI with tenant B's token cannot read tenant A's Run", async () => {
    const run = (token: string, args: string[]) => {
      const { promise, resolve } = Promise.withResolvers<{
        code: number | null;
        document: { data?: { id?: string }; error?: { code: string } };
      }>();
      const child = spawn(process.execPath, [cli, "--json", "--endpoint", stack.baseUrl, ...args], {
        env: {
          ...process.env,
          TESTMASTER_API_KEY: token,
          NODE_EXTRA_CA_CERTS: caFile,
          XDG_CONFIG_HOME: join(caDirectory, "xdg"),
        },
        stdio: "pipe",
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.once("close", (code) => resolve({ code, document: JSON.parse(stdout) }));
      return promise;
    };
    const own = await run(a.token, ["run", "get", a.runIds[0] as string]);
    expect(own.code).toBe(0);
    expect(own.document.data?.id).toBe(a.runIds[0]);
    const foreign = await run(b.token, ["run", "get", a.runIds[0] as string]);
    expect(foreign.code).not.toBe(0);
    expect(foreign.document.error?.code).toBe("NOT_FOUND");
    const listed = await run(b.token, ["run", "list"]);
    const ids = (listed.document.data as unknown as { id: string }[]).map((item) => item.id);
    expect(ids.sort()).toEqual([...b.runIds].sort());
  });

  it("SEC-030 NFR-003 conditional requests and cache headers never let one tenant's response stand in for another's", async () => {
    const own = await get(a.token, `/v1/projects/${a.projectId}`);
    const etag = String(own.headers.etag);
    expect(etag).toMatch(/^"\d+"$/);
    expect(String(own.headers["cache-control"])).toContain("no-store");
    expect(String(own.headers.vary).toLowerCase()).toContain("authorization");
    // B presenting A's validator is told the object does not exist, never "not modified".
    const probe = await get(b.token, `/v1/projects/${a.projectId}`, { "if-none-match": etag });
    expect(probe.status).toBe(404);
    expect(probe.headers.etag).toBeUndefined();
    // A's validator against B's own object never produces 304 either: ETags are versions, not content.
    const own304 = await get(b.token, `/v1/projects/${b.projectId}`, { "if-none-match": etag });
    expect(own304.status).toBe(200);
    expect(envelope(own304).data?.id).toBe(b.projectId);
    // Artifact validators are content hashes; identical bytes in both tenants must not link them.
    const artifactA = await get(a.token, `/v1/artifacts/${a.artifactId}`);
    expect(artifactA.status).toBe(200);
    expect(String(artifactA.headers.etag)).toContain(sharedHash);
    expect(String(artifactA.headers["cache-control"])).toContain("no-store");
    const stolen = await get(b.token, `/v1/artifacts/${a.artifactId}`, {
      "if-none-match": `"${sharedHash}"`,
    });
    expect(stolen.status).toBe(404);
    const stolenRange = await get(b.token, `/v1/artifacts/${a.artifactId}`, {
      range: "bytes=0-15",
    });
    expect(stolenRange.status).toBe(404);
    expect(stolenRange.text).not.toContain("identical artifact bytes");
  });

  it("SEC-030 NFR-003 an idempotency key is scoped to the tenant that sent it", async () => {
    const key = randomUUID();
    const first = await send(
      a.token,
      "POST",
      "/v1/projects",
      { name: "Idempotent" },
      { "idempotency-key": key },
    );
    expect(first.status).toBe(201);
    const replay = await send(
      a.token,
      "POST",
      "/v1/projects",
      { name: "Idempotent" },
      { "idempotency-key": key },
    );
    expect(envelope(replay).data?.id).toBe(envelope(first).data?.id);
    // The same key from tenant B, with the same body, creates B's own project and never replays A's.
    const other = await send(
      b.token,
      "POST",
      "/v1/projects",
      { name: "Idempotent" },
      { "idempotency-key": key },
    );
    expect(other.status).toBe(201);
    expect(envelope(other).data?.id).not.toBe(envelope(first).data?.id);
    expect(envelope(other).data?.workspaceId).toBe(b.workspaceId);
    // A different body under the same key conflicts for A, and is independent for B.
    const conflict = await send(
      a.token,
      "POST",
      "/v1/projects",
      { name: "Different" },
      { "idempotency-key": key },
    );
    expect(conflict.status).toBe(409);
    expect(envelope(conflict).error?.code).toBe("IDEMPOTENCY_CONFLICT");
    const independent = await send(
      b.token,
      "POST",
      "/v1/projects",
      { name: "Different" },
      { "idempotency-key": key },
    );
    expect(independent.status).toBe(409);
    const projectsOfB =
      envelope(await get(b.token, "/v1/projects")).data?.items?.map((item) => item.id) ?? [];
    expect(projectsOfB).not.toContain(envelope(first).data?.id);
  });

  it("SEC-030 NFR-003 identical artifact bytes in two tenants stay in separate workspace-scoped blobs", async () => {
    const controller = await stack.scope();
    const rows = (workspaceId: string) =>
      controller.database
        .forWorkspace(workspaceId)
        .all("SELECT id, hash, storage_key FROM artifacts");
    const inA = rows(a.workspaceId);
    const inB = rows(b.workspaceId);
    expect(inA.map((row) => row.hash)).toEqual([sharedHash]);
    expect(inB.map((row) => row.hash)).toEqual([sharedHash]);
    const keyA = String(inA[0]?.storage_key);
    const keyB = String(inB[0]?.storage_key);
    expect(keyA).not.toBe(keyB);
    expect(keyA.startsWith(`runs/${a.workspaceId}/`)).toBe(true);
    expect(keyB.startsWith(`runs/${b.workspaceId}/`)).toBe(true);
    // The blobs live under per-workspace directories of the evidence root; no shared content-addressed path exists.
    const root = controller.config.dataDir;
    expect((await readdir(join(root, "runs"))).sort()).toEqual(
      [a.workspaceId, b.workspaceId].sort(),
    );
    await access(join(root, keyA.split("/").slice(0, 3).join("/")));
    // Each tenant downloads its own copy by its own identifier only.
    const bodyB = await get(b.token, `/v1/artifacts/${String(inB[0]?.id)}`);
    expect(bodyB.status).toBe(200);
    expect(bodyB.text).toContain("identical artifact bytes");
    expect((await get(b.token, `/v1/artifacts/${a.artifactId}`)).status).toBe(404);
    expect((await get(a.token, `/v1/artifacts/${String(inB[0]?.id)}`)).status).toBe(404);
  });

  it("SEC-030 SEC-022 a secret of tenant A cannot be listed, deleted or shadowed by tenant B", async () => {
    const listedByB = envelope(await get(b.token, "/v1/secrets")).data?.items ?? [];
    expect(listedByB.map((item) => item.id)).toEqual([b.secretId]);
    expect(JSON.stringify(listedByB)).not.toContain(canary);
    const deleted = await send(b.token, "DELETE", `/v1/secrets/${a.secretId}`, undefined, {});
    expect(deleted.status).toBe(404);
    const stillA = envelope(await get(a.token, "/v1/secrets")).data?.items ?? [];
    expect(stillA.map((item) => item.id)).toEqual([a.secretId]);
    // The same name exists in both tenants without collision; each reference is its own object.
    const controller = await stack.scope();
    const listA = controller.forWorkspaceSystem(a.workspaceId).secrets.list();
    const listB = controller.forWorkspaceSystem(b.workspaceId).secrets.list();
    expect(listA.map((item) => item.locator)).toEqual(["payments-key"]);
    expect(listB.map((item) => item.locator)).toEqual(["payments-key"]);
    expect(listA[0]?.id).not.toBe(listB[0]?.id);
  });
});
