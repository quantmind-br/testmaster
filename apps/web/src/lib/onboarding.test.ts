import { describe, expect, it } from "vitest";
import { type ApiResult, createApiClient } from "../api/client";
import type { Page } from "../api/controllers";
import { projectNavigation } from "../components/app-shell";
import { activeSourceRevisionIds, diffIssues } from "../routes/discovery";
import type { PortalRoute } from "../routes/types";
import { onboardingSteps } from "./m4-types";
import {
  describeReason,
  digestOf,
  formatBytes,
  nextStep,
  previousStep,
  shortHash,
  sourceFormatFor,
  sourceRoleFor,
  splitLines,
  suggestAppTypes,
} from "./onboarding";

describe("onboarding helpers", () => {
  it("UX-010 suggests an application type only from detected technology and never invents one", () => {
    expect(suggestAppTypes(["express", "typescript"])).toEqual(["Node.js HTTP API"]);
    expect(suggestAppTypes(["next", "react"])).toEqual(["Next.js application"]);
    expect(suggestAppTypes(["fastapi"])).toEqual(["Python web application"]);
    // Negative control: nothing detected means nothing suggested.
    expect(suggestAppTypes([])).toEqual([]);
    expect(suggestAppTypes(["left-pad"])).toEqual([]);
  });

  it("UX-009 moves between steps in order and stops at both ends", () => {
    expect(nextStep("mode", onboardingSteps)).toBe("project");
    expect(previousStep("project", onboardingSteps)).toBe("mode");
    expect(previousStep("mode", onboardingSteps)).toBe("mode");
    expect(nextStep("result", onboardingSteps)).toBe("result");
  });

  it("UX-011 picks a role and a format from the file name and leaves unknown files to the server", () => {
    expect(sourceRoleFor("PRD.md")).toBe("prd");
    expect(sourceRoleFor("openapi.yaml")).toBe("api-spec");
    expect(sourceRoleFor("notes.txt")).toBe("doc");
    expect(sourceFormatFor("openapi.json", "api-spec")).toBe("openapi");
    expect(sourceFormatFor("schema.graphql", "api-spec")).toBe("graphql");
    expect(sourceFormatFor("shop.postman_collection.json", "api-spec")).toBe("postman");
    expect(sourceFormatFor("prd.json", "prd")).toBe("prd-json");
    // Negative control: no extension rule applies, so no format is claimed.
    expect(sourceFormatFor("README", "doc")).toBeUndefined();
  });

  it("UX-011 computes the sha256 digest the upload contract expects", async () => {
    const digest = await digestOf(new TextEncoder().encode("abc"));
    expect(digest).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(shortHash(digest)).toBe("ba7816bf8f01");
    expect(shortHash(null)).toBe("—");
    expect(formatBytes(2048)).toBe("2.0 KiB");
  });

  it("UX-010 words each prerequisite failure from its registry reason, and names a missing code", () => {
    expect(describeReason("egress_denied", null)).toBe("Network policy denies this target");
    expect(describeReason(null, "target_unreachable")).toBe("target unreachable");
    expect(describeReason(null, null)).toBe("No reason recorded");
    expect(splitLines(" a \n\n b\n")).toEqual(["a", "b"]);
  });

  it("UX-014 rejects a diff without a base, and without a head unless the working tree is included", () => {
    const input = { scope: "diff" as const, base: "", head: "", workingTree: false };
    expect(diffIssues(input).map((issue) => issue.fieldId)).toEqual([
      "discovery-base",
      "discovery-head",
    ]);
    expect(diffIssues({ ...input, base: "main", workingTree: true })).toEqual([]);
    expect(diffIssues({ ...input, base: "main", head: "feature" })).toEqual([]);
    // Negative control: a full scan needs neither.
    expect(diffIssues({ ...input, scope: "codebase" })).toEqual([]);
  });
});

describe("project sub-navigation", () => {
  const route = (path: string, projectNav?: PortalRoute["projectNav"]): PortalRoute => ({
    path,
    title: path,
    element: null,
    ...(projectNav ? { projectNav } : {}),
  });
  const routes = [
    route("/projects/:projectId/sources", { label: "Sources", order: 20 }),
    route("/projects/:projectId/onboarding", { label: "Onboarding", order: 10 }),
    route("/projects/:projectId/sources/:sourceId"),
    route("/"),
  ];

  it("UX-009 lists project pages in order for any page under a project and for nothing else", () => {
    const nav = projectNavigation(routes, "/projects/prj_1/sources/src_2");
    expect(nav?.id).toBe("prj_1");
    expect(nav?.links).toEqual([
      { label: "Onboarding", path: "/projects/prj_1/onboarding" },
      { label: "Sources", path: "/projects/prj_1/sources" },
    ]);
    expect(projectNavigation(routes, "/")).toBeNull();
    expect(projectNavigation(routes, "/onboarding")).toBeNull();
  });
});

describe("binary uploads", () => {
  it("UX-011 sends bytes as an octet stream with the upload token and never lets a header override security headers", async () => {
    let seen: { headers: Headers; body: unknown } | null = null;
    const client = createApiClient({
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        seen = { headers: new Headers(init?.headers), body: init?.body };
        return new Response(JSON.stringify({ data: {}, requestId: "r1" }), { status: 200 });
      }) as typeof fetch,
      uuid: () => "fixed-correlation-id",
    });
    client.setCsrfToken("csrf-token");
    const bytes = new Uint8Array([1, 2, 3]);
    await client.api("PUT", "/uploads/up1/bytes", {
      bytes,
      headers: { "X-Upload-Token": "tok", "X-CSRF-Token": "forged" },
    });
    const captured = seen as { headers: Headers; body: unknown } | null;
    expect(captured?.headers.get("content-type")).toBe("application/octet-stream");
    expect(captured?.headers.get("x-upload-token")).toBe("tok");
    expect(captured?.headers.get("x-csrf-token")).toBe("csrf-token");
    expect(captured?.body).toBe(bytes);
  });
});

describe("discovery source walk", () => {
  interface SourceRow {
    id: string;
    activeRevisionId: string | null;
  }
  const pagedSources =
    (...pages: SourceRow[][]) =>
    async (cursor: string | null): Promise<ApiResult<Page<SourceRow>>> => {
      const index = cursor === null ? 0 : Number(cursor);
      const hasMore = index + 1 < pages.length;
      return {
        data: {
          items: pages[index] ?? [],
          hasMore,
          nextCursor: hasMore ? String(index + 1) : null,
        },
        etag: null,
        requestId: "req",
        warnings: [],
      };
    };

  it("submits the active revision of every source, not only the first page", async () => {
    const fetchPage = pagedSources(
      [{ id: "src-a", activeRevisionId: "rev-a" }],
      [{ id: "src-b", activeRevisionId: "rev-b" }],
    );
    expect(await activeSourceRevisionIds(fetchPage)).toEqual(["rev-a", "rev-b"]);
  });

  it("leaves out sources that have no active revision", async () => {
    const fetchPage = pagedSources([
      { id: "src-a", activeRevisionId: "rev-a" },
      { id: "src-empty", activeRevisionId: null },
    ]);
    expect(await activeSourceRevisionIds(fetchPage)).toEqual(["rev-a"]);
  });
});
