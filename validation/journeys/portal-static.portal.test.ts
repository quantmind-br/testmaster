import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "@testmaster/application";
import { createServer } from "@testmaster/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  atViewport,
  expectAccessible,
  expectNoPageOverflow,
  keyboardOnly,
  type OpenPortal,
  openPortal,
} from "./portal.js";
import { createTestCa, startTlsProxy, type TestCa, type TlsProxy } from "./tls-proxy.js";

/**
 * The portal served by the local-profile server behind a TLS proxy. Only anonymous pages exist
 * here (no cookie sessions in the local profile); signed-in journeys live in
 * portal-shell.portal.test.ts against the server profile.
 */
let directory: string;
let ca: TestCa;
let proxy: TlsProxy;
let application: Application;
let closeServer: () => Promise<void>;
const open: OpenPortal[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "tm-portal-static-"));
  const home = join(directory, "home");
  await mkdir(home);
  application = await Application.open({ cwd: directory, home, env: {} });
  await application.init();
  ca = await createTestCa(join(directory, "ca"));
  let port = 0;
  proxy = await startTlsProxy({ ca, upstreamPort: () => port });
  // The local profile keeps one global budget for failed authentications and every anonymous page
  // load spends from it. A 1000x clock refills it between page loads without real-time sleeps.
  const start = Date.now();
  const server = createServer({
    application,
    mcp: false,
    origins: [proxy.origin],
    now: () => start + (Date.now() - start) * 1000,
  });
  closeServer = () => server.close();
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  port = Number(new URL(address).port);
});

afterAll(async () => {
  for (const portal of open.splice(0)) await portal.close().catch(() => undefined);
  await closeServer();
  await proxy.close();
  application.close();
  await rm(directory, { recursive: true, force: true });
});

async function portal(options: Parameters<typeof openPortal>[2] = {}) {
  const opened = await openPortal(
    { baseUrl: proxy.origin, spkiSha256: ca.spkiSha256 },
    null,
    options,
  );
  open.push(opened);
  return opened;
}

describe("portal over TLS, anonymous", () => {
  it("UX-006 a deep link while signed out lands on login and keeps the address for after sign-in", async () => {
    const { page } = await portal();
    const response = await page.goto("/projects/prj_deep-link?tab=runs");
    expect(response?.status()).toBe(200);
    await page.waitForURL((url) => url.pathname === "/login");
    expect(new URL(page.url()).searchParams.get("next")).toBe("/projects/prj_deep-link?tab=runs");
    expect(await page.getByRole("heading", { level: 1 }).textContent()).toBe(
      "Sign in to TestMaster",
    );
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
  });

  it("SEC-013 the document carries the portal CSP and framing headers, and no inline code is allowed", async () => {
    const { page, diagnostics } = await portal();
    const response = await page.goto("/login");
    const headers = response?.headers() ?? {};
    expect(headers["content-security-policy"]).toContain("script-src 'self'");
    expect(headers["content-security-policy"]).not.toContain("unsafe-inline");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["cache-control"]).toBe("no-store");
    await page.getByRole("heading", { level: 1 }).waitFor();
    expect(diagnostics.pageErrors).toEqual([]);
    expect(diagnostics.console).toEqual([]);
  });

  it("SEC-013 CSP blocks an injected inline script and an inline event handler", async () => {
    const { page } = await portal();
    await page.goto("/login");
    await page.getByRole("heading", { level: 1 }).waitFor();
    const outcome = await page.evaluate(async () => {
      const violations: string[] = [];
      const seen = new Promise<void>((resolve) =>
        document.addEventListener("securitypolicyviolation", (event) => {
          violations.push(event.violatedDirective);
          if (violations.length >= 3) resolve();
        }),
      );
      const script = document.createElement("script");
      script.textContent = "window.__injectedScript = 'ran'";
      document.body.append(script);
      const button = document.createElement("button");
      button.setAttribute("onclick", "window.__injectedHandler = 'ran'");
      document.body.append(button);
      button.click();
      const frame = document.createElement("iframe");
      frame.src = "https://example.invalid/";
      document.body.append(frame);
      // Resolves once the browser has reported all three blocked attempts.
      await seen;
      const marker = window as unknown as Record<string, unknown>;
      return { script: marker.__injectedScript, handler: marker.__injectedHandler, violations };
    });
    expect(outcome.script).toBeUndefined();
    expect(outcome.handler).toBeUndefined();
    expect(outcome.violations).toEqual(
      expect.arrayContaining(["script-src-elem", "script-src-attr"]),
    );
    expect(outcome.violations).toContain("frame-src");
  });

  it("UX-051 sign-in is keyboard-only operable and a rejected sign-in is announced on the form", async () => {
    const { page } = await portal();
    await page.goto("/login");
    await page.getByRole("heading", { level: 1 }).waitFor();
    const keyboard = await keyboardOnly(page);
    const login = await keyboard.tabTo((element) => element.name.startsWith("Login"));
    expect(login).toBeLessThanOrEqual(3);
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.type("nobody");
    await keyboard.press("Tab");
    expect((await keyboard.focused()).name).toBe("Password");
    await keyboard.type("not-the-password");
    await keyboard.press("Enter");
    const summary = page.getByTestId("error-summary");
    await summary.waitFor();
    expect(await summary.getAttribute("role")).toBe("alert");
    expect(await summary.textContent()).toContain("Invalid credentials.");
    // Focus moves to the summary so the error is read without hunting for it.
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
      "error-summary",
    );
    await expectAccessible(page, "login, rejected sign-in");
    await keyboard.assertNoPointerUsed();
  });

  it("UX-055 an empty sign-in binds each error to its field and links the summary to it", async () => {
    const { page } = await portal();
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in" }).click();
    const login = page.getByLabel("Login");
    const password = page.getByLabel("Password");
    expect(await login.getAttribute("aria-invalid")).toBe("true");
    expect(await password.getAttribute("aria-invalid")).toBe("true");
    const described = await login.getAttribute("aria-describedby");
    expect(await page.locator(`#${described}`).textContent()).toBe("Enter your login.");
    await page.getByRole("link", { name: "Enter your password." }).click();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("password");
    await expectAccessible(page, "login, validation errors");
  });

  it("UX-051 login and recovery are accessible on desktop and reflow at 320 px and 200 % zoom", async () => {
    const { page } = await portal();
    for (const path of ["/login", "/recover"]) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).waitFor();
      await expectAccessible(page, `${path} desktop`);
    }
    await atViewport(page, { width: 320, zoom: 2, textScale: 2 });
    for (const path of ["/login", "/recover"]) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).waitFor();
      await atViewport(page, { width: 320, zoom: 2, textScale: 2 });
      await expectNoPageOverflow(page, `${path} at 320 CSS px, 200 %`);
      await expectAccessible(page, `${path} 320 px / 200 %`);
      for (const control of [
        page.getByRole("button", { name: /Sign in|Set password/ }),
        page.getByRole("link", { name: /Use a recovery token|Back to sign in/ }),
      ]) {
        await control.scrollIntoViewIfNeeded();
        expect(await control.isVisible()).toBe(true);
      }
    }
  });

  it("UX-051 recovery rejects mismatched passwords on the field before any request is sent", async () => {
    const { page, diagnostics } = await portal();
    await page.goto("/recover");
    await page.getByLabel("Login").fill("someone");
    await page.getByLabel("Recovery token").fill("tm_rec_not-a-real-token");
    await page.getByLabel("New password", { exact: true }).fill("first-password-1");
    await page.getByLabel("Confirm new password").fill("second-password-2");
    const before = diagnostics.requests.length;
    await page.getByRole("button", { name: "Set password" }).click();
    await page.getByText("The passwords do not match.").first().waitFor();
    expect(
      diagnostics.requests.slice(before).filter((entry) => entry.includes("/v1/identity")),
    ).toEqual([]);
  });

  it("M4-05 the portal only calls catalog /v1 routes and its own static assets", async () => {
    const { page, diagnostics } = await portal();
    await page.goto("/login");
    await page.getByRole("heading", { level: 1 }).waitFor();
    for (const request of diagnostics.requests) {
      const path = request.split(" ")[1] ?? "";
      expect(/^\/(?:v1\/|assets\/|login|$)/.test(path), request).toBe(true);
    }
  });
});
