import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Application, issueLocalToken, scaffoldPlan } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { OutboxRepository } from "@testmaster/persistence";
import { createServer } from "@testmaster/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedRun } from "../../../packages/application/src/run-seed.testing.js";
import { runCli } from "./cli.js";
import { RemoteClient } from "./remote.js";
import { Runtime } from "./runtime.js";

const cleanup: (() => Promise<void>)[] = [];
const originalExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

interface Identified {
  id: string;
}
interface Profiles {
  profiles: { profile: string; authenticated: boolean }[];
}
interface Started {
  runId: string;
}

async function invoke<T = unknown>(args: string[]) {
  let stdout = "";
  const sink = (append: (text: string) => void) =>
    new Writable({
      write(chunk, _encoding, callback) {
        append(String(chunk));
        callback();
      },
    });
  process.exitCode = undefined;
  await runCli(
    ["--json", ...args],
    new Runtime(
      sink((text) => {
        stdout += text;
      }),
      sink(() => {}),
    ),
  );
  const document = JSON.parse(stdout) as {
    requestId: string;
    data: T;
    error?: { code: string; details?: Record<string, unknown> };
  };
  return { exit: process.exitCode, stdout, document };
}

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-cli-remote-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const config = join(cwd, "xdg");
  vi.stubEnv("XDG_CONFIG_HOME", config);
  vi.stubEnv("TESTMASTER_API_KEY", "");
  vi.stubEnv("TESTMASTER_ENDPOINT", "");
  vi.stubEnv("TESTMASTER_PROFILE", "");
  const application = await Application.open({ cwd, home, env: {} });
  const init = await application.init();
  vi.spyOn(Application.prototype, "preflight").mockResolvedValue();
  application.context.entities.insert("Worker", {
    id: uuidV7IdGenerator.next("wrk"),
    workspaceId: init.workspaceId,
    identityRef: "cli-remote-test",
    capabilities: ["http"],
    imageDigests: [],
    labels: {},
    state: "ready",
    lastHeartbeatAt: new Date().toISOString(),
  });
  const { token } = await issueLocalToken(application, { tokenPath: join(cwd, "server.token") });
  const server = createServer({ application, host: "127.0.0.1", origins: [] });
  const endpoint = await server.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    await server.close();
    application.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return { application, init, token, endpoint, config };
}

describe("CLI remote mode", () => {
  it("M4-01 UX-001 auth login stores endpoint metadata and a private token file, auth logout keeps the server token valid", async () => {
    const f = await fixture();
    vi.stubEnv("TM_TEST_TOKEN", f.token);
    const login = await invoke<{ profile: string; principalId: string }>([
      "auth",
      "login",
      "--endpoint",
      f.endpoint,
      "--from-env",
      "TM_TEST_TOKEN",
      "--profile",
      "local-dev",
    ]);
    expect(login.exit).toBe(0);
    expect(login.document.data).toMatchObject({
      profile: "local-dev",
      principalId: f.init.principalId,
    });
    // The token never reaches stdout or the profile metadata file.
    expect(login.stdout).not.toContain(f.token);
    const profilePath = join(f.config, "testmaster", "profiles.json");
    const profiles = await readFile(profilePath, "utf8");
    expect(profiles).toContain("local-dev");
    expect(profiles).not.toContain(f.token);
    expect((await stat(profilePath)).mode & 0o777).toBe(0o600);
    const tokenPath = join(f.config, "testmaster", "credentials", "local-dev.token");
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.config, "testmaster", "credentials"))).mode & 0o777).toBe(0o700);

    // The stored profile authenticates without an environment variable.
    vi.stubEnv("TM_TEST_TOKEN", "");
    const status = await invoke<Profiles>(["auth", "status", "--profile", "local-dev"]);
    expect(status.document.data.profiles).toMatchObject([
      { profile: "local-dev", authenticated: true },
    ]);
    const whoami = await invoke(["--profile", "local-dev", "whoami"]);
    expect(whoami.document.data, whoami.stdout).toMatchObject({
      principalId: f.init.principalId,
      role: "org_owner",
    });

    const logout = await invoke(["auth", "logout", "--profile", "local-dev"]);
    expect(logout.document.data).toMatchObject({
      loggedOut: ["local-dev"],
      revokedRemotely: false,
    });
    await expect(stat(tokenPath)).rejects.toThrow();
    // Logout is local: the server still accepts the token.
    const direct = await fetch(`${f.endpoint}/v1/me`, {
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(direct.status).toBe(200);
    const after = await invoke<Profiles>(["auth", "status", "--profile", "local-dev"]);
    expect(after.document.data.profiles).toEqual([]);
  });

  it("M4-01 auth login refuses plain HTTP outside loopback, an empty variable and a token the server rejects", async () => {
    const f = await fixture();
    vi.stubEnv("TM_TEST_TOKEN", f.token);
    const plain = await invoke([
      "auth",
      "login",
      "--endpoint",
      "http://tm.example.com",
      "--from-env",
      "TM_TEST_TOKEN",
    ]);
    expect(plain.document.error?.code).toBe("INVALID_ARGUMENT");
    vi.stubEnv("TM_EMPTY", "");
    const empty = await invoke([
      "auth",
      "login",
      "--endpoint",
      f.endpoint,
      "--from-env",
      "TM_EMPTY",
    ]);
    expect(empty.document.error?.code).toBe("INVALID_ARGUMENT");
    vi.stubEnv("TM_BAD_TOKEN", `tm_api_${"A".repeat(43)}`);
    const bad = await invoke([
      "auth",
      "login",
      "--endpoint",
      f.endpoint,
      "--from-env",
      "TM_BAD_TOKEN",
    ]);
    expect(bad.document.error?.code).toBe("UNAUTHENTICATED");
    await expect(stat(join(f.config, "testmaster", "profiles.json"))).rejects.toThrow();
    // There is no inline token option.
    const inline = await invoke(["auth", "login", "--endpoint", f.endpoint, "--token", f.token]);
    expect(inline.exit).not.toBe(0);
    // Positive control: the real token logs in.
    const good = await invoke<{ principalId: string }>([
      "auth",
      "login",
      "--endpoint",
      f.endpoint,
      "--from-env",
      "TM_TEST_TOKEN",
    ]);
    expect(good.document.data.principalId).toBe(f.init.principalId);
  });

  it("M4-01 UX-001 the remote commands read the server state and every other command is CAPABILITY_UNAVAILABLE naming itself", async () => {
    const f = await fixture();
    vi.stubEnv("TESTMASTER_API_KEY", f.token);
    const test = f.application.tests.create({
      projectId: f.init.projectId,
      plan: scaffoldPlan("backend"),
    });
    const projects = await invoke<Identified[]>(["--endpoint", f.endpoint, "projects", "list"]);
    expect(projects.document.data.map((item) => item.id)).toContain(f.init.projectId);
    const tests = await invoke<Identified[]>([
      "--endpoint",
      f.endpoint,
      "tests",
      "list",
      "--project",
      f.init.projectId,
    ]);
    expect(tests.document.data.map((item) => item.id)).toEqual([test.id]);
    const shown = await invoke(["--endpoint", f.endpoint, "tests", "show", test.id]);
    expect(shown.document.data).toMatchObject({ id: test.id, projectId: f.init.projectId });
    const runs = await invoke(["--endpoint", f.endpoint, "runs", "list"]);
    expect(runs.document.data).toEqual([]);

    const denied: [string[], string][] = [
      [["suite", "list"], "suite list"],
      [["run", "steps", "run_x"], "run steps"],
      [["secret", "list"], "secret list"],
      [["test", "lint"], "test lint"],
    ];
    for (const [args, name] of denied) {
      const refused = await invoke(["--endpoint", f.endpoint, ...args]);
      expect(refused.document.error?.code, name).toBe("CAPABILITY_UNAVAILABLE");
      expect(refused.document.error?.details?.command, name).toBe(name);
    }
    // A wrong token is the server's UNAUTHENTICATED, not a local failure.
    vi.stubEnv("TESTMASTER_API_KEY", `tm_api_${"B".repeat(43)}`);
    const rejected = await invoke(["--endpoint", f.endpoint, "projects", "list"]);
    expect(rejected.document.error?.code).toBe("UNAUTHENTICATED");
    // No credential at all is reported before any request is sent.
    vi.stubEnv("TESTMASTER_API_KEY", "");
    const none = await invoke(["--endpoint", f.endpoint, "projects", "list"]);
    expect(none.document.error?.code).toBe("UNAUTHENTICATED");
    expect(none.document.error?.details?.nextActions).toBeDefined();
  });

  it("OPS-035 ops status, admission and worker-claim commands act on the server workspace through --endpoint", async () => {
    const f = await fixture();
    vi.stubEnv("TESTMASTER_API_KEY", f.token);
    const remote = (...args: string[]) =>
      invoke<{ claims: { paused: boolean; reason: string | null }; admission: unknown }>([
        "--endpoint",
        f.endpoint,
        ...args,
      ]);
    const paused = await remote("ops", "workers", "pause", "--reason", "suspected bypass");
    expect(paused.exit, paused.stdout).toBe(0);
    expect(paused.document.data.claims).toMatchObject({ paused: true, reason: "suspected bypass" });
    // The server's own state changed, not a local database next to the CLI.
    expect(f.application.operations.status().claims.paused).toBe(true);
    const admission = await remote("ops", "pause", "--reason", "maintenance");
    expect(admission.document.data).toMatchObject({ kind: "admission", state: "completed" });
    expect(f.application.operations.status().admission.state).toBe("paused");
    const status = await remote("ops", "status");
    expect(status.document.data).toMatchObject({
      admission: { state: "paused" },
      claims: { paused: true },
    });
    await remote("ops", "resume", "--reason", "done");
    await remote("ops", "workers", "resume", "--reason", "done");
    expect(f.application.operations.status()).toMatchObject({
      admission: { state: "enabled" },
      claims: { paused: false },
    });
    // A host-only selector does not apply to a remote endpoint.
    const scoped = await remote("ops", "status", "--workspace", f.init.workspaceId);
    expect(scoped.document.error?.code).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("OPS-027 the CLI correlation ID is the server request ID, the audit event correlation and the Run's matrix cell", async () => {
    const f = await fixture();
    vi.stubEnv("TESTMASTER_API_KEY", f.token);
    const test = f.application.tests.create({
      projectId: f.init.projectId,
      plan: scaffoldPlan("backend"),
    });
    const started = await invoke<Started>([
      "--endpoint",
      f.endpoint,
      "test",
      "run",
      test.id,
      "--env",
      f.init.environmentId,
    ]);
    expect(started.document.error, started.stdout).toBeUndefined();
    expect(started.exit).toBe(0);
    const correlationId = started.document.requestId;
    expect(correlationId).toMatch(/^cli_/);
    const run = f.application.runs.get(started.document.data.runId);
    expect(run.matrixCell.correlationId).toBe(correlationId);
    const audited = f.application.audit.list({ correlationId }).items;
    expect(audited.length).toBeGreaterThan(0);
    expect(audited.every((entry) => entry.correlationId === correlationId)).toBe(true);
    // Negative control: another invocation carries another correlation ID and never the first one.
    const other = await invoke(["--endpoint", f.endpoint, "runs", "list"]);
    expect(other.document.requestId).not.toBe(correlationId);
    expect(
      f.application.audit
        .list({ correlationId: other.document.requestId })
        .items.some((entry) => entry.scope.resourceId === run.id),
    ).toBe(false);
  });

  it("run get over REST returns the verdict of a passed run whose gate failed on evidence", async () => {
    const f = await fixture();
    vi.stubEnv("TESTMASTER_API_KEY", f.token);
    const test = f.application.tests.create({
      projectId: f.init.projectId,
      plan: scaffoldPlan("backend"),
    });
    const seeded = await seedRun(f.application, {
      testId: test.id,
      environmentId: f.init.environmentId,
      attempts: [{ outcome: "passed", steps: [{ stepId: "s1", status: "passed" }] }],
      gate: "failed",
    });
    const unavailableEvidence = [
      {
        relativePath: "http/orders.json",
        kind: "http",
        state: "missing",
        omissionReason: "redaction_failed",
      },
    ];
    f.application.database.withTx(() =>
      new OutboxRepository(f.application.database).append(
        f.application.context.workspaceId,
        seeded.runId,
        "run.reduced",
        { outcome: "passed", reasonCode: "evidence_incomplete", unavailableEvidence },
      ),
    );
    const shown = await invoke<Record<string, unknown>>([
      "--endpoint",
      f.endpoint,
      "run",
      "get",
      seeded.runId,
    ]);
    expect(shown.document.error, shown.stdout).toBeUndefined();
    expect(shown.document.data).toMatchObject({
      outcome: "passed",
      gate: "failed",
      reasonCode: "evidence_incomplete",
    });
    expect(shown.document.data?.unavailableEvidence).toEqual(unavailableEvidence);
  });
});

interface Envelope {
  status: number;
  body: unknown;
}

/** A local HTTP server that answers every request through `answer` and records each request's cursor. */
async function stubServer(answer: (cursor: string | null) => Envelope) {
  const cursors: (string | null)[] = [];
  const server = createHttpServer((request, response) => {
    const cursor = new URL(request.url ?? "/", "http://stub.test").searchParams.get("cursor");
    cursors.push(cursor);
    const { status, body } = answer(cursor);
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  cleanup.push(async () => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    server.closeAllConnections();
    await closed.promise;
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("The stub server must listen on a port");
  const client = new RemoteClient(
    { endpoint: new URL(`http://127.0.0.1:${address.port}`), profile: null, token: "stub-token" },
    "cli_stub",
    new AbortController().signal,
  );
  return { client, cursors };
}

const LAST_PAGE = 20;
/** Page `n` of 21 pages of 3 items: items `3n..3n+2`, cursor `c<n+1>` until the last page. */
function pageAt(cursor: string | null): Envelope {
  const n = cursor ? Number(cursor.slice(1)) : 0;
  const next = n < LAST_PAGE ? `c${n + 1}` : null;
  return {
    status: 200,
    body: {
      data: { items: [3 * n, 3 * n + 1, 3 * n + 2], hasMore: next !== null, nextCursor: next },
    },
  };
}
const expired: Envelope = {
  status: 410,
  body: { error: { code: "CURSOR_EXPIRED", message: "The cursor expired" } },
};
const EVERY_ITEM = Array.from({ length: 3 * (LAST_PAGE + 1) }, (_, index) => index);

describe("CLI remote list walks", () => {
  it("RemoteClient.list follows every page, past the 2,000 items the old 20-page bound allowed", async () => {
    const { client, cursors } = await stubServer(pageAt);
    expect(await client.list("/items")).toEqual(EVERY_ITEM);
    expect(cursors).toHaveLength(LAST_PAGE + 1);
  });

  it("RemoteClient.list restarts once from the first page when a cursor expires and returns each item once", async () => {
    let served = false;
    const { client, cursors } = await stubServer((cursor) => {
      if (cursor !== "c3" || served) return pageAt(cursor);
      served = true;
      return expired;
    });
    expect(await client.list("/items")).toEqual(EVERY_ITEM);
    expect(cursors.filter((cursor) => cursor === null)).toHaveLength(2);
  });

  it("RemoteClient.list fails with CURSOR_EXPIRED when the restarted walk expires too", async () => {
    const { client, cursors } = await stubServer((cursor) => (cursor ? expired : pageAt(null)));
    const failure = await client.list("/items").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContractError);
    expect(failure).toMatchObject({ code: "CURSOR_EXPIRED" });
    expect(cursors).toEqual([null, "c1", null, "c1"]);
  });

  it("RemoteClient.list fails on any other page error without restarting", async () => {
    const { client, cursors } = await stubServer((cursor) =>
      cursor === "c2"
        ? {
            status: 503,
            body: { error: { code: "UNAVAILABLE", message: "The server is overloaded" } },
          }
        : pageAt(cursor),
    );
    await expect(client.list("/items")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(cursors).toEqual([null, "c1", "c2"]);
  });

  it("tests list forwards one --tag and one --priority and refuses the filters it cannot honor", async () => {
    const f = await fixture();
    vi.stubEnv("TESTMASTER_API_KEY", f.token);
    const make = (tags: string[], priority: "high" | "normal") =>
      f.application.tests.create({
        projectId: f.init.projectId,
        plan: scaffoldPlan("backend"),
        tags,
        priority,
      });
    const tagged = make(["a"], "high");
    const other = make(["b"], "normal");
    const list = (...args: string[]) =>
      invoke<Identified[]>([
        "--endpoint",
        f.endpoint,
        "tests",
        "list",
        "--project",
        f.init.projectId,
        ...args,
      ]);
    const ids = async (...args: string[]) =>
      (await list(...args)).document.data.map((item) => item.id);

    expect((await ids()).sort()).toEqual([tagged.id, other.id].sort());
    expect(await ids("--tag", "a")).toEqual([tagged.id]);
    expect(await ids("--tag", "b")).toEqual([other.id]);
    expect(await ids("--priority", "high")).toEqual([tagged.id]);
    expect(await ids("--tag", "a", "--priority", "normal")).toEqual([]);

    const refusals: [string[], string][] = [
      [["--status", "passed"], "test list --status"],
      [["--limit", "1"], "test list --limit"],
      [["--cursor", "x"], "test list --cursor"],
      [["--tag", "a", "--tag", "b"], "test list --tag (repeated)"],
      [["--priority", "high", "--priority", "normal"], "test list --priority (repeated)"],
    ];
    for (const [args, command] of refusals) {
      const refused = await list(...args);
      expect(refused.document.error?.code, command).toBe("CAPABILITY_UNAVAILABLE");
      expect(refused.document.error?.details?.command, command).toBe(command);
    }
    for (const flag of ["--tag", "--priority"]) {
      const empty = await list(flag, "");
      expect(empty.exit, flag).toBe(5);
      expect(empty.document.error, flag).toMatchObject({
        code: "INVALID_ARGUMENT",
        message: `${flag} must not be empty`,
      });
    }
  });

  it("runs list forwards --test, --status and --since and refuses --limit and --cursor", async () => {
    const f = await fixture();
    vi.stubEnv("TESTMASTER_API_KEY", f.token);
    const first = f.application.tests.create({
      projectId: f.init.projectId,
      plan: scaffoldPlan("backend"),
    });
    const second = f.application.tests.create({
      projectId: f.init.projectId,
      plan: scaffoldPlan("backend"),
    });
    const passed = await seedRun(f.application, {
      testId: first.id,
      environmentId: f.init.environmentId,
      attempts: [{ outcome: "passed" }],
    });
    const failed = await seedRun(f.application, {
      testId: second.id,
      environmentId: f.init.environmentId,
      attempts: [{ outcome: "failed" }],
    });
    const list = (...args: string[]) =>
      invoke<Identified[]>(["--endpoint", f.endpoint, "runs", "list", ...args]);
    const ids = async (...args: string[]) =>
      (await list(...args)).document.data.map((item) => item.id);

    expect(await ids("--test", first.id)).toEqual([passed.runId]);
    expect(await ids("--test", second.id)).toEqual([failed.runId]);
    expect(await ids("--status", "failed")).toEqual([failed.runId]);
    const later = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
    expect(await ids("--since", later)).toEqual([]);
    expect(await ids("--project", "prj_unknown")).toEqual([]);
    expect((await ids()).sort()).toEqual([passed.runId, failed.runId].sort());

    for (const [flag, value] of [
      ["--limit", "1"],
      ["--cursor", "x"],
    ] as const) {
      const refused = await list(flag, value);
      expect(refused.document.error?.code, flag).toBe("CAPABILITY_UNAVAILABLE");
      expect(refused.document.error?.details?.command, flag).toBe(`run list ${flag}`);
    }
  });
});
