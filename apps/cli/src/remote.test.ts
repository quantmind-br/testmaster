import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Application, issueLocalToken, scaffoldPlan } from "@testmaster/application";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { createServer } from "@testmaster/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
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
});
