import { describe, expect, it } from "vitest";
import { ApiError, buildUrl, createApiClient, quoteEtag } from "./client";

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
  readonly headers: Headers;
}

function fakeFetch(respond: (request: Recorded) => Response) {
  const calls: Recorded[] = [];
  const implementation = (async (url: string | URL | Request, init?: RequestInit) => {
    const recorded = { url: String(url), init: init ?? {}, headers: new Headers(init?.headers) };
    calls.push(recorded);
    return respond(recorded);
  }) as typeof fetch;
  return { calls, implementation };
}

const ok = (data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ schemaVersion: "1.0.0", requestId: "req-1", data, warnings: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });

function sequence(): () => string {
  let count = 0;
  return () => `id-${++count}`;
}

describe("portal API client", () => {
  it("UX-001 sends GET requests with a correlation id and no mutation headers", async () => {
    const { calls, implementation } = fakeFetch(() => ok({ hello: "world" }, { ETag: '"3"' }));
    const client = createApiClient({ fetch: implementation, uuid: sequence() });
    client.setCsrfToken("csrf-token");
    const result = await client.api<{ hello: string }>("GET", "/projects", {
      query: { limit: 25, cursor: null, q: "a b", empty: "" },
    });
    expect(result).toEqual({
      data: { hello: "world" },
      etag: '"3"',
      requestId: "req-1",
      warnings: [],
    });
    const call = calls[0] as Recorded;
    expect(call.url).toBe("/v1/projects?limit=25&q=a+b");
    expect(call.headers.get("X-Correlation-ID")).toBe("id-1");
    expect(call.headers.get("Idempotency-Key")).toBeNull();
    expect(call.headers.get("X-CSRF-Token")).toBeNull();
    expect(call.init.credentials).toBe("same-origin");
    expect(call.init.redirect).toBe("error");
  });

  it("UX-001 mutations carry an idempotency key, the CSRF token and a quoted If-Match", async () => {
    const { calls, implementation } = fakeFetch(() => ok({ id: "prj_1" }));
    const client = createApiClient({ fetch: implementation, uuid: sequence() });
    client.setCsrfToken("csrf-token");
    await client.api("PATCH", "/projects/prj_1", { body: { name: "x" }, ifMatch: 7 });
    await client.api("POST", "/runs", { body: {}, idempotencyKey: "retry-key-0000001" });
    const [patch, post] = calls as [Recorded, Recorded];
    expect(patch.headers.get("Idempotency-Key")).toBe("id-2");
    expect(patch.headers.get("X-CSRF-Token")).toBe("csrf-token");
    expect(patch.headers.get("If-Match")).toBe('"7"');
    expect(patch.headers.get("Content-Type")).toBe("application/json");
    expect(patch.init.body).toBe('{"name":"x"}');
    expect(post.headers.get("Idempotency-Key")).toBe("retry-key-0000001");
    expect(post.headers.get("If-Match")).toBeNull();
  });

  it("UX-001 omits the CSRF header when no token is held and after it is cleared", async () => {
    const { calls, implementation } = fakeFetch(() => ok({}));
    const client = createApiClient({ fetch: implementation, uuid: sequence() });
    await client.api("POST", "/identity/login", { body: {} });
    client.setCsrfToken("t");
    client.setCsrfToken(null);
    await client.api("POST", "/identity/logout", { body: {} });
    for (const call of calls) expect(call.headers.get("X-CSRF-Token")).toBeNull();
    expect(client.csrfToken()).toBeNull();
  });

  it("UX-003 maps an error envelope onto ApiError with the server request id", async () => {
    const { implementation } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            schemaVersion: "1.0.0",
            requestId: "req-9",
            error: {
              code: "REVISION_CONFLICT",
              message: "Stale revision",
              retryable: false,
              details: { current: 4 },
              nextActions: [],
            },
          }),
          { status: 409 },
        ),
    );
    const client = createApiClient({ fetch: implementation, uuid: sequence() });
    const failure = await client.api("PATCH", "/tests/tst_1", { body: {} }).catch((e) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 409,
      code: "REVISION_CONFLICT",
      message: "Stale revision",
      retryable: false,
      details: { current: 4 },
      requestId: "req-9",
    });
  });

  it("UX-003 survives a non-JSON failure body and reports a network failure as retryable", async () => {
    const html = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const clientHtml = createApiClient({ fetch: html.implementation, uuid: sequence() });
    const bad = await clientHtml.api("GET", "/me").catch((e) => e);
    expect(bad).toMatchObject({ status: 502, code: "INTERNAL", requestId: "id-1" });

    const down = createApiClient({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      uuid: sequence(),
    });
    const network = await down.api("GET", "/me").catch((e) => e);
    expect(network).toMatchObject({ status: 0, code: "NETWORK", retryable: true });
  });

  it("SEC-030 a 404 and a 403 both report that existence is hidden", () => {
    expect(new ApiError(404, "r", { code: "NOT_FOUND" }).hidesExistence).toBe(true);
    expect(new ApiError(403, "r", { code: "FORBIDDEN" }).hidesExistence).toBe(true);
    expect(new ApiError(409, "r", { code: "REVISION_CONFLICT" }).hidesExistence).toBe(false);
  });

  it("UX-006 notifies the shell of a 401 so it can return to login", async () => {
    const seen: string[] = [];
    const { implementation } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ requestId: "r", error: { code: "UNAUTHENTICATED", message: "no" } }),
          { status: 401 },
        ),
    );
    const client = createApiClient({
      fetch: implementation,
      uuid: sequence(),
      onUnauthenticated: (error) => seen.push(error.code),
    });
    await client.api("GET", "/me").catch(() => undefined);
    expect(seen).toEqual(["UNAUTHENTICATED"]);
  });

  it("UX-006 a route loader can handle its own 401 without the global handler firing", async () => {
    const seen: string[] = [];
    const { implementation } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ requestId: "r", error: { code: "UNAUTHENTICATED", message: "no" } }),
          { status: 401 },
        ),
    );
    const client = createApiClient({
      fetch: implementation,
      uuid: sequence(),
      onUnauthenticated: (error) => seen.push(error.code),
    });
    const failure = await client
      .api("GET", "/me", { handleUnauthenticated: false })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(seen).toEqual([]);
  });

  it("UX-001 never builds a URL that leaves the /v1 prefix", () => {
    expect(buildUrl("/v1", "/runs", { a: 1 })).toBe("/v1/runs?a=1");
    expect(() => buildUrl("/v1", "//evil.example/x")).toThrow("absolute within");
    expect(() => buildUrl("/v1", "runs")).toThrow("absolute within");
    expect(quoteEtag(3)).toBe('"3"');
    expect(quoteEtag('"3"')).toBe('"3"');
    expect(quoteEtag("abc")).toBe('"abc"');
  });
});
