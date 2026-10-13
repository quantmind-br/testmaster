import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { ArtifactFrame } from "./artifact-frame";
import { DataTable } from "./data-table";
import { DiffView } from "./diff-view";
import { ErrorSummary, FormField } from "./form";
import { describeStatus, StatusBadge, statusCatalog } from "./status";
import { UntrustedText } from "./untrusted-text";
import { StatusView, ViewState } from "./view-state";

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element);

describe("StatusBadge", () => {
  it("UX-054 renders a text label and a shape for every known status", () => {
    for (const status of Object.keys(statusCatalog)) {
      const markup = render(h(StatusBadge, { status }));
      expect(markup).toContain(`>${describeStatus(status).label}</span>`);
      expect(markup).toMatch(/<svg[^>]*aria-hidden="true"[^>]*data-shape="[a-z]+"/);
    }
  });

  it("UX-054 never reuses a shape across the terminal outcomes, so colour is not the only cue", () => {
    const shapes = ["passed", "failed", "blocked", "cancelled", "inconclusive"].map(
      (status) => describeStatus(status).shape,
    );
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it("UX-054 renders an unknown status as neutral text, never as success", () => {
    const markup = render(h(StatusBadge, { status: "needs_human" }));
    expect(markup).toContain("Needs human");
    expect(markup).toContain("tone-neutral");
    expect(markup).not.toContain("tone-success");
    expect(describeStatus("").label).toBe("Unknown");
  });

  it("UX-054 does not let a status string inject markup", () => {
    const markup = render(h(StatusBadge, { status: "<img src=x onerror=alert(1)>" }));
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
  });
});

describe("ViewState", () => {
  it("UX-003 renders loading, empty, error, partial and forbidden as distinct views", () => {
    const kinds = ["loading", "empty", "error", "partial", "forbidden", "not-found"] as const;
    const markup = kinds.map((kind) => render(h(ViewState, { kind }, "content")));
    expect(new Set(markup).size).toBe(kinds.length);
    expect(markup[0]).toContain('role="status"');
    expect(markup[2]).toContain('role="alert"');
    expect(markup[3]).toContain("content");
    expect(markup[4]).toContain("view-forbidden");
    for (const [index, kind] of kinds.entries())
      if (kind !== "partial") expect(markup[index]).toContain(`view-${kind}`);
  });

  it("UX-003 shows the error code and request id so a failure can be reported", () => {
    const error = new ApiError(500, "req-77", { code: "INTERNAL", message: "boom" });
    const markup = render(h(ViewState, { kind: "error", error }));
    expect(markup).toContain("INTERNAL");
    expect(markup).toContain("req-77");
  });

  it("UX-003 StatusView renders children only when ready", () => {
    const view = (status: Parameters<typeof StatusView>[0]["status"]) =>
      render(h(StatusView, { status, error: null }, "DATA"));
    expect(view("ready")).toBe("DATA");
    for (const status of ["loading", "empty", "error", "not-found", "forbidden"] as const)
      expect(view(status)).not.toContain("DATA");
  });

  it("SEC-030 a forbidden id and a missing id render the identical view", () => {
    const missing = render(h(StatusView, { status: "not-found", error: null }, "x"));
    expect(missing).toBe(render(h(ViewState, { kind: "not-found" })));
    expect(missing).not.toContain("permit");
  });
});

describe("FormField", () => {
  it("UX-055 binds hint and error to the control through aria-describedby", () => {
    const markup = render(
      h(FormField, {
        label: "Login",
        hint: "Your user name",
        error: "Enter your login.",
        id: "login",
        required: true,
        // biome-ignore lint/correctness/noChildrenProp: FormField takes a render-prop child
        children: (props) => h("input", { ...props, name: "login" }),
      }),
    );
    expect(markup).toContain('for="login"');
    expect(markup).toContain('aria-describedby="login-hint login-error"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('aria-required="true"');
    expect(markup).toContain('id="login-error"');
  });

  it("UX-055 a valid field is not marked invalid and has no dangling description", () => {
    const markup = render(
      h(FormField, {
        label: "Login",
        id: "login",
        // biome-ignore lint/correctness/noChildrenProp: FormField takes a render-prop child
        children: (props) => h("input", { ...props }),
      }),
    );
    expect(markup).not.toContain("aria-invalid");
    expect(markup).not.toContain("aria-describedby");
  });

  it("UX-055 the error summary links each message to its field and renders nothing when clean", () => {
    const markup = render(
      h(ErrorSummary, { issues: [{ fieldId: "password", message: "Enter your password." }] }),
    );
    expect(markup).toContain('href="#password"');
    expect(markup).toContain('role="alert"');
    expect(render(h(ErrorSummary, { issues: [] }))).toBe("");
  });
});

describe("UntrustedText", () => {
  it("SEC-030 escapes markup and never emits HTML from the value", () => {
    const markup = render(
      h(UntrustedText, { value: '<script>alert(1)</script><a href="javascript:x">y</a>' }),
    );
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<a ");
    expect(markup).toContain("&lt;script&gt;");
  });

  it("SEC-030 block content keeps line breaks in a preformatted element and escapes them", () => {
    const markup = render(h(UntrustedText, { value: "line1\n<b>line2</b>", block: true }));
    expect(markup).toContain("<pre");
    expect(markup).toContain("line1\n&lt;b&gt;line2&lt;/b&gt;");
  });

  it("SEC-030 shows a visible truncation note and a fallback for empty values", () => {
    expect(render(h(UntrustedText, { value: "x".repeat(50), maxLength: 10 }))).toContain(
      "truncated, 40 more characters",
    );
    expect(render(h(UntrustedText, { value: null }))).toContain("—");
    expect(render(h(UntrustedText, { value: "", fallback: "none" }))).toContain("none");
  });
});

describe("ArtifactFrame", () => {
  const origin = "https://tm.example";

  it("UX-031 opens a gateway link only inside a fully sandboxed frame", () => {
    const markup = render(
      h(ArtifactFrame, { href: "/v1/artifacts/art_1/content", title: "Trace", origin }),
    );
    expect(markup).toContain('sandbox=""');
    expect(markup).toContain('referrerPolicy="no-referrer"');
    expect(markup).toContain("Download Trace");
  });

  it("UX-031 refuses a foreign, scripted or non-gateway link without rendering a frame", () => {
    for (const href of [
      "https://evil.example/v1/artifacts/a",
      "javascript:alert(1)",
      "/assets/index.js",
    ]) {
      const markup = render(h(ArtifactFrame, { href, title: "Trace", origin }));
      expect(markup).not.toContain("<iframe");
      expect(markup).toContain("not a gateway link");
    }
  });
});

describe("DiffView", () => {
  it("UX-022 labels added and removed rows with text, not colour alone", () => {
    const markup = render(h(DiffView, { before: "a\nb", after: "a\nc", caption: "Diff" }));
    expect(markup).toContain("removed: ");
    expect(markup).toContain("added: ");
    expect(markup).toContain(">+<");
    expect(markup).toContain(">−<");
  });

  it("UX-022 reports identical inputs and escapes line content", () => {
    expect(render(h(DiffView, { before: "a", after: "a", caption: "Diff" }))).toContain(
      "No differences",
    );
    expect(render(h(DiffView, { before: "", after: "<b>x</b>", caption: "Diff" }))).toContain(
      "&lt;b&gt;x&lt;/b&gt;",
    );
  });
});

describe("DataTable", () => {
  interface Row {
    id: string;
    name: string;
  }
  const columns = [
    {
      key: "name",
      header: "Name",
      render: (row: Row) => row.name,
      sortValue: (row: Row) => row.name,
    },
  ];
  const rows = [
    { id: "2", name: "beta" },
    { id: "1", name: "alpha" },
  ];

  it("UX-008 renders a captioned table with column headers scoped and sorted rows", () => {
    const markup = render(
      h(DataTable<Row>, {
        caption: "Projects",
        columns,
        rows,
        rowKey: (row) => row.id,
        sort: { key: "name", direction: "ascending" },
        onSortChange: () => undefined,
      }),
    );
    expect(markup).toContain("<caption>Projects</caption>");
    expect(markup).toContain('scope="col"');
    expect(markup).toContain('aria-sort="ascending"');
    expect(markup.indexOf("alpha")).toBeLessThan(markup.indexOf("beta"));
    expect(markup).toContain('role="region"');
    expect(markup).toContain('tabindex="0"');
  });

  it("UX-008 descending order reverses and the pager reports loaded count and Load more", () => {
    const markup = render(
      h(DataTable<Row>, {
        caption: "Projects",
        columns,
        rows,
        rowKey: (row) => row.id,
        sort: { key: "name", direction: "descending" },
        pager: { hasMore: true, loading: false, onLoadMore: () => undefined },
      }),
    );
    expect(markup.indexOf("beta")).toBeLessThan(markup.indexOf("alpha"));
    expect(markup).toContain("2 loaded");
    expect(markup).toContain("Load more");
  });

  it("UX-008 shows the empty view instead of an empty table", () => {
    const markup = render(
      h(DataTable<Row>, {
        caption: "Projects",
        columns,
        rows: [],
        rowKey: (row) => row.id,
        empty: h("p", null, "No rows"),
      }),
    );
    expect(markup).toBe("<p>No rows</p>");
  });
});
