import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  Application,
  issueLocalToken,
  revokeLocalToken,
  scaffoldPlan,
} from "@testmaster/application";
import { afterEach, expect, it, vi } from "vitest";
import { seedRun } from "../../../packages/application/src/run-seed.testing.js";
import { createServer } from "./server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const page = "<html><body><script>alert(1)</script><p>evidence</p></body></html>";

async function fixture(extra: { relativePath: string; body: string }[] = []) {
  const cwd = await mkdtemp(join(tmpdir(), "tm-gateway-"));
  const home = join(cwd, "home");
  await mkdir(home);
  await mkdir(join(home, ".config", "testmaster"), { recursive: true });
  await writeFile(join(home, ".config", "testmaster", "policy.json"), JSON.stringify({}));
  const application = await Application.open({ cwd, home, env: {} });
  const init = await application.init();
  const test = application.tests.create({
    projectId: init.projectId,
    plan: scaffoldPlan("backend"),
  });
  const seeded = await seedRun(application, {
    testId: test.id,
    environmentId: init.environmentId,
    attempts: [
      {
        outcome: "passed",
        artifacts: [
          { relativePath: "dom/page.html", kind: "dom", mimeType: "text/html", body: page },
          { relativePath: "shot.txt", kind: "console", mimeType: "text/plain", body: "0123456789" },
          {
            relativePath: "raw/trace.zip",
            kind: "restrictedRaw.trace",
            mimeType: "application/zip",
            body: "raw-bytes",
            restricted: true,
          },
          ...extra.map((item) => ({ ...item, kind: "console", mimeType: "text/plain" })),
        ],
      },
    ],
  });
  const issued = await issueLocalToken(application);
  const app = createServer({ application, mcp: false, origins: ["http://127.0.0.1:7331"] });
  cleanup.push(async () => {
    await app.close();
    application.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const headers = { authorization: `Bearer ${issued.token}` };
  const artifact = (relativePath: string) => {
    const found = seeded.artifacts.find((item) => item.relativePath === relativePath);
    if (!found) throw new Error(`seed artifact ${relativePath} missing`);
    return found;
  };
  const mint = async (artifactId: string, disposition?: "inline" | "attachment") => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/artifacts/${artifactId}/links`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: disposition ? { disposition } : {},
    });
    return response;
  };
  return { app, application, init, headers, artifact, mint, issued, seeded };
}

const linkOf = (response: { json(): { data: { url: string } } }) => response.json().data.url;

it("UX-032 a signed link serves the artifact without credentials, inline, for one resource only", async () => {
  const f = await fixture();
  const dom = f.artifact("dom/page.html");
  const minted = await f.mint(dom.id);
  expect(minted.statusCode).toBe(200);
  expect(minted.json().data).toMatchObject({
    artifactId: dom.id,
    method: "GET",
    disposition: "inline",
    ttlSeconds: 300,
  });
  const expiresIn = Date.parse(minted.json().data.expiresAt) - Date.now();
  expect(expiresIn).toBeGreaterThan(295_000);
  expect(expiresIn).toBeLessThanOrEqual(300_000);
  const response = await f.app.inject({ url: linkOf(minted) });
  expect(response.statusCode).toBe(200);
  expect(response.body).toBe(page);
  expect(response.headers["content-disposition"]).toMatch(/^inline; filename=/);
  expect(response.headers["content-security-policy"]).toBe(
    "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  );
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.headers.etag).toBe(`"${dom.sha256}"`);

  const attachment = await f.mint(dom.id, "attachment");
  expect((await f.app.inject({ url: linkOf(attachment) })).headers["content-disposition"]).toMatch(
    /^attachment; filename=/,
  );

  // Negative control: the same capability never opens a different artifact.
  const other = f.artifact("shot.txt");
  const swapped = linkOf(minted).replace(dom.id, other.id);
  const refused = await f.app.inject({ url: swapped });
  expect(refused.statusCode).toBe(401);
  expect(refused.json().error.details).toMatchObject({ reason: "link_invalid" });
  // The unauthenticated existing route stays closed: the link is not a bearer token.
  expect((await f.app.inject({ url: `/v1/artifacts/${dom.id}` })).statusCode).toBe(401);
}, 60_000);

it("UX-032 links honour a single explicit byte range and refuse malformed ranges", async () => {
  const f = await fixture();
  const text = f.artifact("shot.txt");
  const url = linkOf(await f.mint(text.id));
  const partial = await f.app.inject({ url, headers: { range: "bytes=2-5" } });
  expect(partial.statusCode).toBe(206);
  expect(partial.body).toBe("2345");
  expect(partial.headers["content-range"]).toBe("bytes 2-5/10");
  const bad = await f.app.inject({ url, headers: { range: "bytes=0-1,4-5" } });
  expect(bad.statusCode).toBe(400);
  const beyond = await f.app.inject({ url, headers: { range: "bytes=0-99" } });
  expect(beyond.statusCode).toBe(400);
}, 60_000);

it("UX-032 a link expires after 300 seconds and a forged or missing link is refused with its own reason", async () => {
  const f = await fixture();
  const dom = f.artifact("dom/page.html");
  const minted = await f.mint(dom.id);
  const url = linkOf(minted);
  expect((await f.app.inject({ url })).statusCode).toBe(200);
  const reason = async (target: string) => {
    const response = await f.app.inject({ url: target });
    expect(response.statusCode).toBe(401);
    return response.json().error.details.reason;
  };
  expect(await reason(`/v1/artifacts/${dom.id}/content`)).toBe("link_missing");
  const token = new URL(url, "http://x").searchParams.get("link") ?? "";
  const [payload = "", signature = ""] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const forged = Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + 3_600_000 })).toString(
    "base64url",
  );
  expect(await reason(`/v1/artifacts/${dom.id}/content?link=${forged}.${signature}`)).toBe(
    "link_invalid",
  );
  expect(await reason(`/v1/artifacts/${dom.id}/content?link=${payload}.AAAA`)).toBe("link_invalid");
  expect(await reason(`/v1/artifacts/${dom.id}/content?link=not-a-link`)).toBe("link_invalid");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(minted.json().data.expiresAt) - 1000);
  expect((await f.app.inject({ url })).statusCode).toBe(200);
  vi.setSystemTime(Date.parse(minted.json().data.expiresAt) + 1000);
  expect(await reason(url)).toBe("link_expired");
}, 60_000);

it("UX-032 M4-01 deleting the artifact or revoking the minting credential ends an issued link at once", async () => {
  const f = await fixture();
  const dom = f.artifact("dom/page.html");
  const url = linkOf(await f.mint(dom.id));
  expect((await f.app.inject({ url })).statusCode).toBe(200);
  f.application.retention.requestDeletion(dom.id);
  const tombstoned = await f.app.inject({ url });
  expect(tombstoned.statusCode).toBe(404);
  expect(tombstoned.body).not.toContain("evidence");
  expect((await f.mint(dom.id)).statusCode).toBe(404);

  // Revocation control on a second, undeleted artifact.
  const text = f.artifact("shot.txt");
  const second = linkOf(await f.mint(text.id));
  expect((await f.app.inject({ url: second })).statusCode).toBe(200);
  revokeLocalToken(f.application, f.issued.token);
  const revoked = await f.app.inject({ url: second });
  expect(revoked.statusCode).toBe(401);
  expect(revoked.json().error.details).toMatchObject({ reason: "link_invalid" });
}, 60_000);

it("UX-032 restricted raw evidence and non-readable credentials never receive a gateway link", async () => {
  const f = await fixture();
  const raw = f.artifact("raw/trace.zip");
  const denied = await f.mint(raw.id);
  expect(denied.statusCode).toBe(403);
  expect(denied.json().error.details).toMatchObject({ reason: "restricted_raw" });
  const unknown = await f.mint("art_00000000000000000000000000");
  expect(unknown.statusCode).toBeGreaterThanOrEqual(400);
  const none = await f.app.inject({
    method: "POST",
    url: `/v1/artifacts/${f.artifact("shot.txt").id}/links`,
    headers: { "idempotency-key": randomUUID() },
    payload: {},
  });
  expect(none.statusCode).toBe(401);
}, 60_000);

it("UX-032 M4-01 DELETE /v1/artifacts/{id} over HTTP tombstones the artifact and ends issued links, and needs the delete grant", async () => {
  const f = await fixture();
  const dom = f.artifact("dom/page.html");
  const url = linkOf(await f.mint(dom.id));
  expect((await f.app.inject({ url })).statusCode).toBe(200);
  const remove = (headers: Record<string, string>) =>
    f.app.inject({
      method: "DELETE",
      url: `/v1/artifacts/${dom.id}`,
      headers: { ...headers, "idempotency-key": randomUUID() },
    });
  // Negative control: a token without a delete grant cannot tombstone, and the link keeps working.
  expect((await remove(f.headers)).statusCode).toBe(403);
  expect((await f.app.inject({ url })).statusCode).toBe(200);
  const granted = await issueLocalToken(f.application, {
    tokenPath: join(f.application.config.home, "delete.token"),
    grants: [
      {
        resourceType: "Artifact",
        actions: ["delete"],
        projectIds: [f.init.projectId],
        environmentIds: [f.init.environmentId],
        expiresAt: null,
        grantedBy: f.init.principalId,
      },
    ],
  });
  const done = await remove({ authorization: `Bearer ${granted.token}` });
  expect(done.statusCode).toBe(200);
  expect((await f.app.inject({ url })).statusCode).toBe(404);
  expect((await f.mint(dom.id)).statusCode).toBe(404);
});

it("a download the client abandons mid-stream ends quietly and the server keeps answering", async () => {
  const large = "x".repeat(16 * 1024 * 1024);
  const f = await fixture([{ relativePath: "large.txt", body: large }]);
  const rejections: unknown[] = [];
  const record = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", record);
  cleanup.push(async () => {
    process.off("unhandledRejection", record);
  });
  const origin = await f.app.listen({ host: "127.0.0.1", port: 0 });
  const { id } = f.artifact("large.txt");
  const abandoned = Promise.withResolvers<void>();
  const download = httpRequest(
    `${origin}/v1/artifacts/${id}`,
    { headers: f.headers },
    (response) => {
      expect(response.statusCode).toBe(200);
      // The client leaves after the first chunk, long before the server has streamed 16 MiB.
      response.once("data", () => {
        download.destroy();
        abandoned.resolve();
      });
    },
  );
  download.on("error", () => {});
  download.end();
  await abandoned.promise;
  // The server serves the next download in full: the abandoned one did not take it over.
  const next = await fetch(`${origin}/v1/artifacts/${id}`, { headers: f.headers });
  expect(next.status).toBe(200);
  expect((await next.arrayBuffer()).byteLength).toBe(large.length);
  await delay(200);
  expect(rejections).toEqual([]);
}, 60_000);
