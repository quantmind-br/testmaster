import { afterEach, describe, expect, it } from "vitest";
import { buildManifest, manifestFormHtml } from "./manifest.js";
import { type GithubWorld, startGithubWorld } from "./testing/world.js";

const worlds: GithubWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.stop();
});
async function world(options?: Parameters<typeof startGithubWorld>[0]): Promise<GithubWorld> {
  const created = await startGithubWorld(options);
  worlds.push(created);
  return created;
}
const input = (overrides: Record<string, unknown> = {}) => ({
  name: "TestMaster Staging",
  publicOrigin: "https://testmaster.example.test",
  redirectUrl: "http://127.0.0.1:41999/callback",
  ...overrides,
});

describe("INT-014 SEC-047 App creation through the manifest flow", () => {
  it("INT-014 SEC-047 requests the minimum permissions, points the webhook at this deployment and asks for contents: write only for agent pull requests", async () => {
    const w = await world();
    const plain = w.app.github.manifest(input());
    const manifest = plain.manifest as { default_permissions: Record<string, string>; hook_attributes: { url: string }; public: boolean; default_events: string[] };
    expect(manifest.default_permissions).toEqual({ metadata: "read", contents: "read", checks: "write", pull_requests: "write", deployments: "read" });
    expect(manifest.hook_attributes.url).toBe("https://testmaster.example.test/v1/integrations/github/webhooks");
    expect(manifest.public).toBe(false);
    expect(manifest.default_events).toEqual(expect.arrayContaining(["installation", "installation_repositories", "push", "pull_request", "deployment_status", "check_run"]));
    expect(plain.scopes).not.toContain("github:contents:write");
    expect(plain.createUrl).toBe(`https://github.com/settings/apps/new?state=${plain.state}`);
    const agent = w.app.github.manifest(input({ allowAgentPullRequests: true, organization: "acme" }));
    expect((agent.manifest as { default_permissions: Record<string, string> }).default_permissions.contents).toBe("write");
    expect(agent.scopes).toContain("github:contents:write");
    expect(agent.createUrl).toBe(`https://github.com/organizations/acme/settings/apps/new?state=${agent.state}`);
  });

  it("INT-014 refuses a plaintext public origin, credentials in URLs and a remote plaintext redirect", async () => {
    const w = await world();
    for (const bad of [
      { publicOrigin: "http://testmaster.example.test" },
      { publicOrigin: "https://user:pw@testmaster.example.test" },
      { redirectUrl: "http://evil.example.test/callback" },
      { redirectUrl: "https://user:pw@evil.example.test/callback" },
      { name: "x" },
    ])
      expect(() => w.app.github.manifest(input(bad))).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => buildManifest(input() as never)).not.toThrow();
  });

  it("INT-014 SEC-047 exchanges the one-time code once, stores the credentials as secrets bound to the GitHub API origin and never returns them", async () => {
    const w = await world();
    const receipt = w.app.github.manifest(input());
    w.fake.registerManifestCode("code-1");
    const created = await w.app.github.convertManifest(receipt.state, { code: "code-1", projectIds: [w.projectId] });
    expect(created).toMatchObject({ provider: "github", name: w.fake.slug, state: "active" });
    expect(JSON.stringify(created)).not.toContain("BEGIN");
    expect(JSON.stringify(created)).not.toContain(w.fake.webhookSecret);
    const settings = (w.app.integrations.get(created.id) as { settings: { credentials: Record<string, string | null>; appId: string } }).settings;
    expect(settings.appId).toBe(String(w.fake.appId));
    const origin = new URL(w.fake.url).origin;
    for (const ref of [settings.credentials.privateKeyRef, settings.credentials.webhookSecretRef, settings.credentials.clientSecretRef]) {
      const secret = w.app.secrets.get(String(ref));
      expect(secret.allowedOrigins).toEqual([origin]);
      expect(JSON.stringify(secret)).not.toContain("BEGIN");
    }
    expect(JSON.stringify(w.app.database.all("SELECT * FROM operational_state"))).not.toContain("BEGIN RSA");
    // One use: the state is consumed, so a replay never reaches GitHub again.
    const requests = w.fake.requestsMatching("POST", /conversions$/u).length;
    w.fake.registerManifestCode("code-2");
    await expect(w.app.github.convertManifest(receipt.state, { code: "code-2", projectIds: [w.projectId] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(w.fake.requestsMatching("POST", /conversions$/u)).toHaveLength(requests);
  });

  it("INT-014 an unknown state, an expired state and a code GitHub rejects create no integration", async () => {
    const w = await world();
    const before = w.app.integrations.list().length;
    await expect(w.app.github.convertManifest("never-issued", { code: "code-1", projectIds: [w.projectId] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const expired = w.app.github.manifest(input());
    w.clock.t += 11 * 60_000;
    w.fake.registerManifestCode("code-3");
    await expect(w.app.github.convertManifest(expired.state, { code: "code-3", projectIds: [w.projectId] })).rejects.toMatchObject({ details: { reasonCode: "manifest_expired" } });
    const rejected = w.app.github.manifest(input());
    await expect(w.app.github.convertManifest(rejected.state, { code: "not-registered", projectIds: [w.projectId] })).rejects.toBeDefined();
    expect(w.app.integrations.list()).toHaveLength(before);
  });

  it("INT-014 the setup page shows what is requested and escapes every interpolated value", () => {
    const html = manifestFormHtml('https://github.com/settings/apps/new?state="><script>x</script>', { name: "<b>App</b>", hook_attributes: { url: "https://h.example.test/&" }, default_permissions: { "checks<": "write" } });
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain("<b>App</b>");
    expect(html).toContain("&lt;b&gt;App&lt;/b&gt;");
    expect(html).toContain("Create GitHub App");
  });
});

describe("INT-014 consent, test delivery and repository settings", () => {
  it("INT-014 a test delivery proves the App credentials and creates no check, comment, Run or pull request", async () => {
    const w = await world();
    await w.install();
    const receipt = await w.app.integrations.test(w.integration.id);
    expect(receipt).toMatchObject({ test: true, state: "delivered" });
    expect(w.fake.checkRuns).toEqual([]);
    expect(w.fake.comments).toEqual([]);
    expect(w.app.runs.list()).toEqual([]);
    expect(w.app.database.get("SELECT COUNT(*) AS n FROM github_pulls")?.n).toBe(0);
    // Negative control: when GitHub rejects the App JWT the same test delivery fails instead of passing silently.
    const broken = await world();
    broken.fake.failNext("GET /app", 401, {}, 5);
    expect((await broken.app.integrations.test(broken.integration.id)).state).toBe("failed");
  });

  it("INT-014 repository bindings need a project the integration may use and reject unknown repositories", async () => {
    const w = await world();
    await w.install();
    expect(() => w.app.github.updateRepository(w.integration.id, "999999", { enabled: true })).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => w.app.github.updateRepository(w.integration.id, "501", { forkPolicy: "fixture-only" })).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => w.app.github.updateRepository(w.integration.id, "501", { preview: { timeoutMs: 1 } })).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    const installations = w.app.github.installations(w.integration.id);
    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({ installationId: "777", state: "active" });
    expect(installations[0]?.repositories[0]).toMatchObject({ repositoryId: "501", fullName: "acme/shop", granted: true });
  });
});
