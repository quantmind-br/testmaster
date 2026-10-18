import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BulkActionBar } from "./components/bulk-action-bar";
import { ConfirmButton } from "./components/confirm-action";
import { ConfirmDialog } from "./components/confirm-dialog";
import { DemoBanner } from "./components/demo-banner";
import { ImpactPanel } from "./components/impact-panel";
import { RunStateSummary } from "./components/run-state";
import { demoQuotaPolicyId, isDemoWorkspace } from "./lib/demo";
import { environmentImpact } from "./lib/impact";
import { describeRunState } from "./lib/run-state";
import { createScopedSelection, planBulkAction, selectionForScope } from "./lib/selection";
import { applyFilters, searchRows, stableOrder, tableEmptiness } from "./lib/table-model";

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element);

const completePassed = {
  phase: "completed",
  outcome: "passed",
  status: "passed",
  cleanupOutcome: "passed",
  gate: "passed",
  analysisStatus: "not_requested",
  evidenceValidity: "valid",
};

describe("run state dimensions", () => {
  it("UX-003 approves only a completed passed run with settled cleanup and a passed gate", () => {
    const view = describeRunState(completePassed);
    expect(view.approved).toBe(true);
    expect(view.inconsistencies).toEqual([]);
    expect(view.dimensions.map((dimension) => dimension.key)).toEqual([
      "phase",
      "outcome",
      "status",
      "cleanupOutcome",
      "gate",
      "evidenceValidity",
      "analysisStatus",
    ]);
  });

  it("UX-003 does not approve the gate when cleanup failed even though the assertions passed", () => {
    const view = describeRunState({ ...completePassed, cleanupOutcome: "failed" });
    expect(view.approved).toBe(false);
    const gate = view.dimensions.find((dimension) => dimension.key === "gate");
    expect(gate?.display).toBe("Not approved");
    expect(view.inconsistencies.join(" ")).toContain("required cleanup failed");
  });

  it("UX-003 never shows passed for a run that has not completed", () => {
    const view = describeRunState({ ...completePassed, phase: "running", gate: "pending" });
    const outcome = view.dimensions.find((dimension) => dimension.key === "outcome");
    expect(outcome?.display).toBe("Unconfirmed");
    expect(outcome?.tone).toBe("warning");
    expect(view.approved).toBe(false);
  });

  it("UX-003 shows missing and unknown values as such, never as zero or success", () => {
    const view = describeRunState({ phase: "completed", outcome: "needs_human" });
    const outcome = view.dimensions.find((dimension) => dimension.key === "outcome");
    const cleanup = view.dimensions.find((dimension) => dimension.key === "cleanupOutcome");
    expect(outcome?.display).toBe("Unknown (needs_human)");
    expect(outcome?.tone).toBe("neutral");
    expect(cleanup?.display).toBe("Not reported");
    expect(cleanup?.known).toBe(false);
    expect(view.approved).toBe(false);
  });

  it("UX-003 renders each fact under its own label and no combined verdict label", () => {
    const markup = render(h(RunStateSummary, { run: completePassed }));
    for (const label of ["Phase", "Outcome", "Status", "Cleanup", "Gate", "Evidence", "Analysis"])
      expect(markup).toContain(`<dt>${label}</dt>`);
    expect(markup).not.toMatch(/Verdict|Lifecycle/u);
    expect(markup).toMatch(/data-shape="check"/u);
  });
});

describe("table model", () => {
  const rows = [
    { id: "b", name: "Login flow", state: "active" },
    { id: "a", name: "Login failure", state: "archived" },
    { id: "c", name: "Checkout", state: "active" },
  ];

  it("UX-008 orders ties by row key so a sort is stable and repeatable", () => {
    const sorted = stableOrder(
      [...rows, { id: "d", name: "Login flow", state: "x" }],
      (row) => row.name,
      "ascending",
      (row) => row.id,
    );
    expect(sorted.map((row) => row.id)).toEqual(["c", "a", "b", "d"]);
    const reversed = stableOrder(
      rows,
      (row) => row.name,
      "descending",
      (row) => row.id,
    );
    expect(reversed.map((row) => row.id)).toEqual(["b", "a", "c"]);
  });

  it("UX-008 requires every search term and ignores filter values that are not options", () => {
    expect(searchRows(rows, "login fail", (row) => row.name).map((row) => row.id)).toEqual(["a"]);
    expect(searchRows(rows, "  ", (row) => row.name)).toHaveLength(3);
    const filters = [
      {
        key: "state",
        label: "State",
        options: [{ value: "active", label: "Active" }],
        match: (row: (typeof rows)[number], value: string) => row.state === value,
      },
    ];
    expect(applyFilters(rows, filters, { state: "active" }).map((row) => row.id)).toEqual([
      "b",
      "c",
    ]);
    expect(applyFilters(rows, filters, { state: "<script>" })).toHaveLength(3);
  });

  it("UX-008 tells an empty list apart from a filter that matches nothing", () => {
    expect(tableEmptiness(0, 0)).toBe("empty");
    expect(tableEmptiness(5, 0)).toBe("no-matches");
    expect(tableEmptiness(5, 2)).toBe("has-rows");
  });
});

describe("scoped selection and bulk actions", () => {
  it("UX-055 blocks a bulk action with nothing selected and never widens it to the whole list", () => {
    const none = planBulkAction(0, "test");
    expect(none.allowed).toBe(false);
    expect(none.reason).toContain("Nothing is applied to the whole list");
    expect(planBulkAction(3, "test")).toEqual({ allowed: true, reason: null, count: 3 });
    const markup = render(
      h(BulkActionBar, {
        noun: "test",
        count: 0,
        label: "Archive selected tests",
        confirmLabel: "Archive",
        description: "x",
        context: [],
        onConfirm: async () => undefined,
        onClear: () => undefined,
      }),
    );
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("Select at least one test");
    expect(markup).not.toContain("Clear selection");
  });

  it("UX-007 drops a selection made under another scope so it cannot apply to the current one", () => {
    const made = { scope: "prj_a", ids: new Set(["tst_1", "tst_2"]) };
    expect(selectionForScope(made, "prj_a").ids.size).toBe(2);
    const other = selectionForScope(made, "prj_b");
    expect(other.scope).toBe("prj_b");
    expect(other.ids.size).toBe(0);
    expect(createScopedSelection("prj_b").ids.size).toBe(0);
  });
});

describe("confirmation", () => {
  it("UX-055 shows why a confirm button is inert instead of hiding it", () => {
    const blocked = render(
      h(ConfirmButton, {
        label: "Purge",
        disabledReason: "Archive the project first.",
        dialog: { title: "t", description: "d", confirmLabel: "Go" },
        onConfirm: async () => undefined,
      }),
    );
    expect(blocked).toContain('aria-disabled="true"');
    expect(blocked).toContain("Archive the project first.");
    expect(blocked).toMatch(/aria-describedby="[^"]+"/u);
    const open = render(
      h(ConfirmButton, {
        label: "Purge",
        dialog: { title: "t", description: "d", confirmLabel: "Go" },
        onConfirm: async () => undefined,
      }),
    );
    expect(open).toContain('aria-disabled="false"');
    expect(open).not.toContain("Archive the project first.");
  });

  it("UX-007 names the workspace and project in the dialog and demands typed input only when asked", () => {
    const plain = render(
      h(ConfirmDialog, {
        open: false,
        title: "Archive?",
        description: "d",
        context: [
          { label: "Workspace", value: "Acme" },
          { label: "Project", value: "Shop" },
        ],
        confirmLabel: "Archive",
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(plain).toContain("<dt>Workspace</dt><dd>Acme</dd>");
    expect(plain).toContain("<dt>Project</dt><dd>Shop</dd>");
    expect(plain).not.toContain("exactly to enable");
    const typed = render(
      h(ConfirmDialog, {
        open: false,
        title: "Purge?",
        description: "d",
        confirmLabel: "Purge",
        destructive: true,
        typed: { label: "Project slug", expected: "shop" },
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(typed).toContain("exactly to enable");
    expect(typed).toContain("<code>shop</code>");
    // The confirm button is inert until the typed value matches.
    expect(typed).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Purge<\/button>/u);
  });
});

describe("impact of settings changes", () => {
  const before = {
    name: "Staging",
    baseUrl: "https://staging.test",
    networkProfile: "public",
    production: false,
  };

  it("UX-047 states the reproducibility, cost and data-protection effect of an environment change", () => {
    const impacts = environmentImpact(before, {
      ...before,
      baseUrl: "https://prod.test",
      production: true,
    });
    expect(impacts.map((impact) => impact.area)).toEqual([
      "Reproducibility",
      "Cost",
      "Data protection",
    ]);
    expect(impacts[0]?.text).toContain("not recomputed");
    expect(impacts[0]?.text).toContain("Approvals are bound to a revision");
    expect(impacts[2]?.text).toContain("https://prod.test");
    expect(impacts[2]?.text).toContain("Marked production");
  });

  it("UX-047 says nothing will be saved when no setting changed", () => {
    const impacts = environmentImpact(before, { ...before });
    expect(impacts[0]?.text).toBe("No setting changed; nothing will be saved.");
    expect(impacts[2]?.level).toBe("none");
  });

  it("UX-047 renders every impact with a text label and shape, never colour alone", () => {
    const markup = render(
      h(ImpactPanel, { impacts: environmentImpact(null, { ...before, production: true }) }),
    );
    expect(markup).toContain('data-testid="impact-panel"');
    for (const area of ["Reproducibility", "Cost", "Data protection"])
      expect(markup).toContain(`<strong>${area}.</strong>`);
    expect(markup).toMatch(/<svg[^>]*aria-hidden="true"/u);
    expect(markup).toContain("Review");
  });
});

describe("demonstration workspace", () => {
  it("UX-056 labels only a workspace whose quota policy is the demo policy", () => {
    expect(isDemoWorkspace({ quotaPolicyId: demoQuotaPolicyId })).toBe(true);
    expect(isDemoWorkspace({ quotaPolicyId: "standard" })).toBe(false);
    expect(isDemoWorkspace({})).toBe(false);
    const demo = render(
      h(DemoBanner, { workspace: { id: "ws_1", name: "Try it", quotaPolicyId: "demo" } }),
    );
    expect(demo).toContain('data-testid="demo-banner"');
    expect(demo).toContain("Demonstration workspace.");
    const real = render(h(DemoBanner, { workspace: { id: "ws_2", name: "Acme" } }));
    expect(real).toBe("");
  });
});
