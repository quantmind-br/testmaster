import { request as httpRequest } from "node:http";
import { Writable } from "node:stream";
import { type GithubWorld, startGithubWorld } from "@testmaster/application/testing";
import { afterEach, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { runGithubSetup } from "./github.js";
import { Runtime } from "./runtime.js";

const worlds: GithubWorld[] = [];
const originalExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExitCode;
  for (const world of worlds.splice(0)) await world.stop();
});

const decode = (value: string): string =>
  value.replace(
    /&(amp|lt|gt|quot|#39);/gu,
    (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[name] ?? "",
  );

async function setup(options: { timeoutMs?: number } = {}) {
  const world = await startGithubWorld();
  worlds.push(world);
  let ready: (url: string) => void = () => {};
  const readyUrl = new Promise<string>((resolve) => {
    ready = resolve;
  });
  const done = runGithubSetup(world.app, {
    manifest: { name: "TestMaster Staging", publicOrigin: "https://testmaster.example.test" },
    projectIds: [world.projectId],
    port: 0,
    timeoutMs: options.timeoutMs ?? 20_000,
    onReady: ready,
  });
  // The setup promise may reject while the test still drives the browser side.
  done.catch(() => undefined);
  return { world, done, readyUrl };
}

/** `fetch` ignores a Host override, so the DNS-rebinding request goes through `node:http`. */
function rawGet(url: string, host: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  httpRequest(url, { headers: { host } }, (response) => {
    response.resume();
    resolve(response.statusCode ?? 0);
  })
    .on("error", reject)
    .end();
  return promise;
}

it("INT-014 SEC-047 the setup helper serves the manifest on loopback, posts nothing itself and stores the App credentials as GitHub-bound secrets", async () => {
  const { world, done, readyUrl } = await setup();
  const url = await readyUrl;
  expect(new URL(url).hostname).toBe("127.0.0.1");
  const page = await fetch(url);
  expect(page.status).toBe(200);
  // The page may only post to GitHub: no script, no other form target.
  expect(page.headers.get("content-security-policy")).toContain("form-action https://github.com");
  expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
  const html = await page.text();
  const action = decode(html.match(/<form method="post" action="([^"]+)"/u)?.[1] ?? "");
  expect(action).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=[A-Za-z0-9_-]+$/u);
  const manifest = JSON.parse(
    decode(html.match(/name="manifest" value="([^"]+)"/u)?.[1] ?? ""),
  ) as {
    redirect_url: string;
    hook_attributes: { url: string };
    default_permissions: Record<string, string>;
  };
  expect(manifest.redirect_url).toBe(`${new URL(url).origin}/callback`);
  expect(manifest.hook_attributes.url).toBe(
    "https://testmaster.example.test/v1/integrations/github/webhooks",
  );
  expect(manifest.default_permissions.contents).toBe("read");
  expect(world.app.integrations.list().filter((entry) => entry.provider === "github")).toHaveLength(
    1,
  );
  // GitHub redirects the browser back with the one-time code and the original state.
  const state = new URL(action).searchParams.get("state") ?? "";
  world.fake.registerManifestCode("cli-code-1");
  const callback = await fetch(`${new URL(url).origin}/callback?code=cli-code-1&state=${state}`);
  expect(callback.status).toBe(200);
  const result = await done;
  expect(result).toMatchObject({
    appSlug: world.fake.slug,
    installUrl: `https://github.com/apps/${world.fake.slug}/installations/new`,
    webhookUrl: "https://testmaster.example.test/v1/integrations/github/webhooks",
  });
  expect(await callback.text()).toContain(result.installUrl);
  const created = world.app.integrations.get(result.integrationId);
  expect(created.projectIds).toEqual([world.projectId]);
  for (const suffix of ["private-key", "webhook-secret"])
    expect(world.app.secrets.get(`github-${world.fake.slug}-${suffix}`).allowedOrigins).toEqual([
      new URL(world.fake.url).origin,
    ]);
  // Credentials never come back in the stored integration: only references.
  expect(JSON.stringify(created)).not.toContain(world.fake.privateKeyPem);
}, 60_000);

it("INT-014 SEC-047 the setup helper refuses a wrong state, a foreign Host header and unknown paths, and creates nothing", async () => {
  const { world, done, readyUrl } = await setup({ timeoutMs: 2_500 });
  const origin = new URL(await readyUrl).origin;
  world.fake.registerManifestCode("cli-code-2");
  expect((await fetch(`${origin}/callback?code=cli-code-2&state=wrong`)).status).toBe(400);
  expect((await fetch(`${origin}/elsewhere`)).status).toBe(404);
  const rebound = await rawGet(`${origin}/`, "attacker.example:80");
  expect(rebound).toBe(421);
  expect(world.app.integrations.list().filter((entry) => entry.provider === "github")).toHaveLength(
    1,
  );
  expect(world.fake.requestsMatching("POST", /app-manifests/u)).toEqual([]);
  // The unfinished flow ends at its deadline instead of waiting forever.
  await expect(done).rejects.toMatchObject({ code: "UNAVAILABLE" });
}, 60_000);

async function invoke(args: string[]) {
  let stdout = "";
  const sink = (append: (text: string) => void) =>
    new Writable({
      write(chunk, _encoding, callback) {
        append(String(chunk));
        callback();
      },
    });
  await runCli(
    ["--json", ...args],
    new Runtime(
      sink((text) => {
        stdout += text;
      }),
      sink(() => {}),
    ),
  );
  return { exit: process.exitCode, document: JSON.parse(stdout) as { error?: { code: string } } };
}

it("INT-014 the setup command validates its arguments before it opens anything", async () => {
  const valid = await invoke([
    "integrations",
    "github",
    "setup",
    "--public-origin",
    "https://tm.example",
    "--dry-run",
  ]);
  expect(valid.exit).toBe(0);
  expect(valid.document.error).toBeUndefined();
  process.exitCode = originalExitCode;
  const server = await invoke([
    "integrations",
    "github",
    "setup",
    "--public-origin",
    "https://tm.example",
    "--mode",
    "server",
    "--dry-run",
  ]);
  expect(server.exit).toBe(5);
  expect(server.document.error?.code).toBe("INVALID_ARGUMENT");
});
