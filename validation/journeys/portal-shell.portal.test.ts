import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  atViewport,
  expectAccessible,
  expectNoPageOverflow,
  keyboardOnly,
  type OpenPortal,
  openPortal,
} from "./portal.js";
import { type ServerStack, type StackUser, startServerStack } from "./server-stack.js";

/**
 * The portal shell against the real server profile: PostgreSQL, `server start --mode server` as a
 * child process, and a TLS-terminating proxy, so the `__Host-` cookie, CSRF, Origin and
 * `tls_required` rules behave as in production.
 */
const hostileName = `<img src=x onerror="window.__pwned='img'"><script>window.__pwned='script'</script> Hostile`;

let stack: ServerStack;
let projectId = "";
let otherWorkspaceProject = "";
let allowedProject = "";
let restricted: StackUser;
const open: OpenPortal[] = [];

async function createProject(workspace: number, name: string): Promise<string> {
  const created = await stack.ownerClient(workspace).mutate("POST", "/v1/projects", { name });
  if (created.status !== 201)
    throw new Error(`project creation failed: ${created.status} ${created.text}`);
  return created.json<{ data: { id: string } }>().data.id;
}

beforeAll(async () => {
  stack = await startServerStack({ workspaces: 2 });
  projectId = await createProject(0, hostileName);
  allowedProject = await createProject(0, "Allowed project");
  otherWorkspaceProject = await createProject(1, "Other tenant project");
  restricted = await stack.addMember("viewer", { projectRestrictions: [allowedProject] });
}, 600_000);

afterAll(async () => {
  for (const portal of open.splice(0)) await portal.close().catch(() => undefined);
  await stack?.stop();
});

async function portal(user: { login: string; password: string } | null, signIn = true) {
  const opened = await openPortal(
    { baseUrl: stack.baseUrl, spkiSha256: stack.ca.spkiSha256 },
    user,
    { signIn },
  );
  open.push(opened);
  return opened;
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL((url) => url.pathname === "/login");
}

describe("portal shell on the server profile", () => {
  it("UX-006 M4-01 signs in, keeps the session across a refresh, recovers the CSRF token through /me and signs out", async () => {
    const { page, diagnostics } = await portal(stack.owner);
    expect(new URL(page.url()).pathname).toBe("/");
    await page.getByRole("heading", { level: 2, name: "Projects" }).waitFor();
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    const cookies = await page.context().cookies();
    const session = cookies.find((cookie) => cookie.name === "__Host-tm_session");
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });

    // A reload drops the in-memory CSRF token; the shell must read it back from /me.
    const before = diagnostics.requests.filter((entry) => entry === "GET /v1/me").length;
    await page.reload();
    await page.getByRole("heading", { level: 2, name: "Projects" }).waitFor();
    expect(diagnostics.requests.filter((entry) => entry === "GET /v1/me").length).toBeGreaterThan(
      before,
    );
    expect(new URL(page.url()).pathname).toBe("/");

    // Sign-out is a CSRF-protected POST: it only succeeds if the recovered token is sent.
    const logout = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/v1/identity/logout",
    );
    await signOut(page);
    expect((await logout).status()).toBe(200);
    await page.goto("/");
    await page.waitForURL((url) => url.pathname === "/login");
    expect((await page.context().cookies()).find((c) => c.name === "__Host-tm_session")).toBe(
      undefined,
    );
  });

  it("UX-006 M4-01 a rejected sign-in keeps the user on the form and never says which part was wrong", async () => {
    const { page } = await portal(null);
    await page.goto("/login");
    await page.getByLabel("Login").fill(stack.owner.login);
    await page.getByLabel("Password").fill("not-the-password-1");
    await page.getByRole("button", { name: "Sign in" }).click();
    const summary = page.getByTestId("error-summary");
    await summary.waitFor();
    expect(await summary.textContent()).toContain("Invalid credentials.");
    expect(new URL(page.url()).pathname).toBe("/login");
    await page.getByLabel("Login").fill("nobody-here");
    await page.getByRole("button", { name: "Sign in" }).click();
    expect(await page.getByTestId("error-summary").textContent()).toContain("Invalid credentials.");
  });

  it("UX-006 a deep link after a fresh sign-in lands on the requested page", async () => {
    const { page } = await portal(null);
    await page.goto(`/projects/${projectId}`);
    await page.waitForURL((url) => url.pathname === "/login");
    expect(new URL(page.url()).searchParams.get("next")).toBe(`/projects/${projectId}`);
    await page.getByLabel("Login").fill(stack.owner.login);
    await page.getByLabel("Password").fill(stack.owner.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => url.pathname === `/projects/${projectId}`);
    await page.getByRole("heading", { level: 1, name: /Hostile/ }).waitFor();
    expect(await page.title()).toContain("Hostile");
  });

  it("SEC-030 an unknown ID, another tenant's ID and a restricted project render the identical not-found view", async () => {
    const { page, diagnostics } = await portal(restricted);
    const views: { path: string; title: string; main: string }[] = [];
    const missing = "prj_00000000-0000-4000-8000-000000000000";
    for (const path of [
      `/projects/${missing}`,
      `/projects/${otherWorkspaceProject}`,
      `/projects/${projectId}`,
      "/no/such/page",
    ]) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1, name: "Not found" }).waitFor();
      views.push({
        path,
        title: await page.title(),
        main: (await page.locator("main").innerText()).replace(/\s+/g, " "),
      });
    }
    const [first, ...others] = views;
    for (const view of others) {
      expect(view.title, view.path).toBe(first?.title);
      expect(view.main, view.path).toBe(first?.main);
    }
    // The members' own project still resolves, so the sameness above is not a blanket error page.
    await page.goto(`/projects/${allowedProject}`);
    await page.getByRole("heading", { level: 1, name: "Allowed project" }).waitFor();
    // The server did distinguish the cases; the portal hides it.
    const denials = await Promise.all(
      [missing, otherWorkspaceProject, projectId].map(async (id) => {
        const client = stack.anonymous();
        const login = await client.request("POST", "/v1/identity/login", {
          body: { principal: restricted.login, password: restricted.password },
          headers: { origin: stack.baseUrl, "idempotency-key": crypto.randomUUID() },
        });
        expect(login.status).toBe(200);
        return (await client.request("GET", `/v1/projects/${id}`)).status;
      }),
    );
    expect(denials.every((status) => status === 403 || status === 404)).toBe(true);
    expect(new Set(denials).size).toBeGreaterThan(0);
    expect(diagnostics.pageErrors).toEqual([]);
  });

  it("UX-051 sign-in with the keyboard alone reaches the workspace home and the project", async () => {
    const { page } = await portal(null);
    await page.goto("/login");
    await page.getByRole("heading", { level: 1 }).waitFor();
    const keyboard = await keyboardOnly(page);
    expect(await keyboard.tabTo((element) => element.name.startsWith("Login"))).toBeLessThanOrEqual(
      3,
    );
    await keyboard.type(stack.owner.login);
    await keyboard.press("Tab");
    expect((await keyboard.focused()).name).toBe("Password");
    await keyboard.type(stack.owner.password);
    await keyboard.press("Enter");
    await page.waitForURL((url) => url.pathname === "/");
    await page.getByRole("heading", { level: 2, name: "Projects" }).waitFor();
    await page.getByRole("link", { name: /Allowed project/ }).waitFor();
    await keyboard.tabTo((element) => element.tag === "a" && element.name.includes("Allowed"), 40);
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.press("Enter");
    await page.waitForURL((url) => url.pathname === `/projects/${allowedProject}`);
    await page.getByRole("heading", { level: 1, name: "Allowed project" }).waitFor();
    await keyboard.assertNoPointerUsed();
  });

  it("UX-051 UX-052 home and project pages are axe clean on desktop and reflow at 320 px and 200 % zoom", async () => {
    const { page } = await portal(stack.owner);
    for (const path of ["/", `/projects/${allowedProject}`]) {
      await page.goto(path);
      await page.getByRole("main").waitFor();
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await expectAccessible(page, `shell ${path} desktop`);
    }
    await atViewport(page, { width: 320, zoom: 2, textScale: 1 });
    for (const path of ["/", `/projects/${allowedProject}`]) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await expectNoPageOverflow(page, `shell ${path} at 320 px`);
      await expectAccessible(page, `shell ${path} 320px 200%`);
      expect(await page.getByRole("button", { name: "Sign out" }).isVisible()).toBe(true);
    }
  });

  it("SEC-013 a hostile project name renders as inert text and the CSP blocks script injected through it", async () => {
    const { page, diagnostics } = await portal(stack.owner);
    await page.goto("/");
    const link = page.getByRole("link", { name: /Hostile/ });
    await link.waitFor();
    expect(await link.textContent()).toContain("<script>");
    expect(await page.locator("main img").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: string }).__pwned)).toBe(
      undefined,
    );
    // Even if the name reached the DOM as markup, the policy refuses inline code.
    const outcome = await page.evaluate(async (name) => {
      const violations: string[] = [];
      const seen = Promise.withResolvers<void>();
      document.addEventListener("securitypolicyviolation", (event) => {
        violations.push(event.violatedDirective);
        if (violations.length >= 2) seen.resolve();
      });
      const holder = document.createElement("div");
      holder.innerHTML = name;
      document.body.append(holder);
      // innerHTML never runs <script>; re-create one the way a template engine would.
      const script = document.createElement("script");
      script.textContent = "window.__pwned = 'script'";
      holder.append(script);
      await seen.promise;
      return { pwned: (window as unknown as { __pwned?: string }).__pwned, violations };
    }, hostileName);
    expect(outcome.pwned).toBeUndefined();
    expect(outcome.violations).toEqual(expect.arrayContaining(["script-src-elem"]));
    expect(outcome.violations.some((v) => v === "script-src-attr" || v === "script-src-elem")).toBe(
      true,
    );
    expect(diagnostics.pageErrors).toEqual([]);
  });
});
