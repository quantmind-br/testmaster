import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, issueLocalToken } from "@testmaster/application";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPortalRoot, isPortalRequest, portalSecurityHeaders } from "./portal.js";
import { createServer } from "./server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const indexHtml =
  '<!doctype html><html><head><title>TM</title></head><body><div id="root"></div></body></html>';

async function fixture(options: { portal?: false | { root: string }; withRoot?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "tm-portal-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const root = join(cwd, "dist");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), indexHtml);
  await writeFile(join(root, "assets", "app-abc123.js"), "export const ok = 1;");
  await writeFile(join(root, "assets", "app-abc123.css"), "body{margin:0}");
  await writeFile(join(cwd, "secret.txt"), "TOP SECRET");
  await symlink(join(cwd, "secret.txt"), join(root, "assets", "link.txt"));
  const application = await Application.open({ cwd, home, env: {} });
  await application.init();
  const issued = await issueLocalToken(application);
  const portal = options.portal === undefined ? { root } : options.portal;
  const server = createServer({ application, mcp: false, portal });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    await server.close();
    application.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return { address, token: issued.token, cwd };
}

describe("portal serving", () => {
  it("UX-006 serves the shell anonymously at / with the ADR-018 security headers and no caching", async () => {
    const f = await fixture();
    const response = await fetch(`${f.address}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(indexHtml);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    for (const [name, value] of Object.entries(portalSecurityHeaders))
      expect(response.headers.get(name), name).toBe(value);
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-correlation-id")).toBeTruthy();
  });

  it("UX-006 answers every client-side route with the shell so deep links survive a reload", async () => {
    const f = await fixture();
    for (const path of ["/login", "/projects/prj_1", "/runs/run_1?tab=steps", "/a/b/c/d"]) {
      const response = await fetch(`${f.address}${path}`);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe(indexHtml);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
    }
  });

  it("UX-006 serves hashed assets as immutable with a sha256 ETag and honours If-None-Match", async () => {
    const f = await fixture();
    const script = await fetch(`${f.address}/assets/app-abc123.js`);
    const body = "export const ok = 1;";
    expect(script.status).toBe(200);
    expect(await script.text()).toBe(body);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
    expect(script.headers.get("etag")).toBe(etag);
    expect(script.headers.get("content-security-policy")).toBe(
      portalSecurityHeaders["Content-Security-Policy"],
    );
    const revalidated = await fetch(`${f.address}/assets/app-abc123.js`, {
      headers: { "If-None-Match": etag },
    });
    expect(revalidated.status).toBe(304);
    const stale = await fetch(`${f.address}/assets/app-abc123.js`, {
      headers: { "If-None-Match": '"other"' },
    });
    expect(stale.status).toBe(200);
    const css = await fetch(`${f.address}/assets/app-abc123.css`);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("SEC-030 a missing asset is a 404, never the HTML shell", async () => {
    const f = await fixture();
    const response = await fetch(`${f.address}/assets/missing.js`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toContain("text/html");
  });

  it("SEC-030 cannot read outside the build: traversal, encoded traversal and symlinks are never served", async () => {
    const f = await fixture();
    for (const path of [
      "/assets/../../secret.txt",
      "/assets/%2e%2e/%2e%2e/secret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/%2e%2e/secret.txt",
      "/assets/link.txt",
      "/etc/passwd",
    ]) {
      const response = await fetch(`${f.address}${path}`);
      const text = await response.text();
      expect(text, path).not.toContain("TOP SECRET");
      expect(text, path).not.toContain("root:");
    }
  });

  it("SEC-030 /index.html and unknown files are the shell with no-store, not a second cached copy", async () => {
    const f = await fixture();
    const response = await fetch(`${f.address}/index.html`);
    expect(await response.text()).toBe(indexHtml);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("M4-01 the portal bypass does not weaken the API: /v1 and /mcp still demand authentication", async () => {
    const f = await fixture();
    for (const path of ["/v1/projects", "/v1/me", "/v1/does-not-exist", "/v1"]) {
      const response = await fetch(`${f.address}${path}`);
      expect(response.status, path).toBe(401);
      expect(response.headers.get("content-security-policy"), path).toBeNull();
    }
    const authenticated = await fetch(`${f.address}/v1/projects`, {
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(authenticated.status).toBe(200);
    const missing = await fetch(`${f.address}/v1/does-not-exist`, {
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("NOT_FOUND");
  });

  it("M4-01 only GET and HEAD are anonymous portal requests; mutations on portal paths are rejected", async () => {
    const f = await fixture();
    const post = await fetch(`${f.address}/login`, { method: "POST", body: "{}" });
    expect(post.status).toBe(401);
    const head = await fetch(`${f.address}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(isPortalRequest("GET", "/x")).toBe(true);
    expect(isPortalRequest("POST", "/x")).toBe(false);
    expect(isPortalRequest("GET", "/v1/me")).toBe(false);
    expect(isPortalRequest("GET", "/v1?x=1")).toBe(false);
    expect(isPortalRequest("GET", "/mcp")).toBe(false);
    expect(isPortalRequest("GET", "/v10")).toBe(true);
  });

  it("M4-01 an API-only server (portal disabled or not built) keeps the previous behaviour", async () => {
    const disabled = await fixture({ portal: false });
    expect((await fetch(`${disabled.address}/`)).status).toBe(401);
    const unbuilt = await fixture({ portal: { root: join(tmpdir(), "tm-no-such-portal-build") } });
    expect((await fetch(`${unbuilt.address}/`)).status).toBe(401);
  });

  it("UX-006 the real build output is served: its index references assets that exist", async () => {
    const root = defaultPortalRoot();
    const f = await fixture({ portal: { root } });
    const html = await (await fetch(`${f.address}/`)).text();
    const references = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    expect(
      references.length,
      `no assets referenced; run pnpm build (${root})`,
    ).toBeGreaterThanOrEqual(2);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(html).not.toMatch(/<style[\s>]/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    for (const reference of references) {
      const response = await fetch(`${f.address}${reference}`);
      expect(response.status, String(reference)).toBe(200);
      expect(response.headers.get("cache-control")).toContain("immutable");
    }
  });
});
