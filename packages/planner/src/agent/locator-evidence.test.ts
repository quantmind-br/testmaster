import type { Locator } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import { describe, expect, it } from "vitest";
import {
  assessLocatorEquivalence,
  type LocatorCandidate,
  type LocatorEvidence,
  locatorFingerprint,
  waitStateEquivalence,
} from "./locator-evidence.js";

function element(overrides: Partial<LocatorCandidate> = {}): LocatorCandidate {
  const candidate = {
    role: "button",
    name: "Checkout",
    tag: "button",
    type: "",
    attributes: { "data-testid": "checkout" },
    matched: true,
    visible: true,
    ...overrides,
  };
  return { ...candidate, fingerprint: locatorFingerprint(candidate) };
}
function evidence(overrides: Partial<LocatorEvidence> = {}): LocatorEvidence {
  const payload = {
    schemaVersion: "1.0.0" as const,
    stepId: "checkout",
    phase: "before" as const,
    frameOrigin: "https://shop.test",
    locator: { by: "testId", value: "checkout" } as Locator,
    cardinality: 1,
    candidates: [element()],
    truncated: false,
    state: null,
    ...overrides,
  };
  const { evidenceHash: _hash, ...content } = payload;
  return { ...content, evidenceHash: semanticHash(content) };
}
const replacement: Locator = { by: "testId", value: "checkout-new" };
const drift = () =>
  evidence({
    cardinality: 0,
    candidates: [element({ matched: false, attributes: { "data-testid": "checkout-new" } })],
  });

describe("recorded locator equivalence", () => {
  it("proves one semantic identity and one replacement selection without mutating evidence", () => {
    const baseline = [evidence()];
    const failed = [drift()];
    const before = JSON.stringify([baseline, failed]);
    expect(assessLocatorEquivalence(baseline, failed, "checkout", replacement).equivalent).toBe(
      true,
    );
    expect(JSON.stringify([baseline, failed])).toBe(before);
    expect(
      assessLocatorEquivalence(baseline, failed, "checkout", {
        by: "role",
        role: "button",
        name: "Checkout",
        exact: true,
      }).equivalent,
    ).toBe(true);
  });
  it("refuses duplicated identity or duplicated replacement selection", () => {
    const duplicate = drift().candidates[0]!;
    expect(
      assessLocatorEquivalence(
        [evidence()],
        [evidence({ cardinality: 0, candidates: [duplicate, duplicate] })],
        "checkout",
        replacement,
      ).equivalent,
    ).toBe(false);
    expect(
      assessLocatorEquivalence(
        [evidence({ cardinality: 2, candidates: [element(), element()] })],
        [drift()],
        "checkout",
        replacement,
      ).equivalent,
    ).toBe(false);
  });
  it("refuses missing baseline, incomplete pools, tampering and still-matching originals", () => {
    expect(assessLocatorEquivalence([], [drift()], "checkout", replacement).equivalent).toBe(false);
    expect(
      assessLocatorEquivalence(
        [evidence()],
        [evidence({ ...drift(), truncated: true })],
        "checkout",
        replacement,
      ).equivalent,
    ).toBe(false);
    expect(
      assessLocatorEquivalence(
        [evidence()],
        [{ ...drift(), evidenceHash: "invalid" }],
        "checkout",
        replacement,
      ).equivalent,
    ).toBe(false);
    expect(
      assessLocatorEquivalence([evidence()], [evidence()], "checkout", replacement).equivalent,
    ).toBe(false);
    expect(
      assessLocatorEquivalence(
        [evidence()],
        [drift(), evidence({ phase: "after" })],
        "checkout",
        replacement,
      ).equivalent,
    ).toBe(false);
  });
  it("does not equate DOM text, changed business identity, cross-origin or scoped replacements", () => {
    expect(
      assessLocatorEquivalence([evidence()], [drift()], "checkout", {
        by: "text",
        value: "Checkout",
        exact: true,
      }).equivalent,
    ).toBe(false);
    const textOnly = evidence({
      cardinality: 0,
      candidates: [
        element({
          role: "",
          tag: "div",
          matched: false,
          attributes: { "data-testid": "checkout-new" },
        }),
      ],
    });
    expect(
      assessLocatorEquivalence([evidence()], [textOnly], "checkout", replacement).equivalent,
    ).toBe(false);
    expect(
      assessLocatorEquivalence(
        [evidence()],
        [evidence({ ...drift(), frameOrigin: "https://other.test" })],
        "checkout",
        replacement,
      ).equivalent,
    ).toBe(false);
    expect(
      assessLocatorEquivalence([evidence()], [drift()], "checkout", {
        ...replacement,
        container: { by: "testId", value: "cart" },
      }).equivalent,
    ).toBe(false);
    expect(
      assessLocatorEquivalence(
        [evidence()],
        [
          evidence({
            cardinality: 0,
            candidates: [
              element({
                name: "Buy now",
                matched: false,
                attributes: { "data-testid": "checkout-new" },
              }),
            ],
          }),
        ],
        "checkout",
        replacement,
      ).equivalent,
    ).toBe(false);
  });
});

describe("recorded wait readiness equivalence", () => {
  const visible = { elapsedMs: 0, attached: true, visible: true, hidden: false };
  const detached = { elapsedMs: 250, attached: false, visible: false, hidden: true };
  const hidden = { elapsedMs: 250, attached: true, visible: false, hidden: true };
  function waits() {
    const state = {
      requested: "detached" as const,
      deadlineMs: 3000,
      transitions: [visible, detached],
    };
    return {
      baseline: [
        evidence({ state }),
        evidence({ phase: "after", cardinality: 0, candidates: [], state }),
      ],
      failed: [evidence({ phase: "after", state: { ...state, transitions: [visible, hidden] } })],
    };
  }
  it("accepts hidden instead of detached only with the original identity and in-budget transition", () => {
    const { baseline, failed } = waits();
    expect(waitStateEquivalence(baseline, failed, "checkout", "hidden").equivalent).toBe(true);
    expect(waitStateEquivalence(baseline, failed, "checkout", "visible").equivalent).toBe(false);
  });
  it("refuses missing baseline, changed deadline, late or absent transitions and ambiguous controls", () => {
    const { baseline, failed } = waits();
    expect(waitStateEquivalence([], failed, "checkout", "hidden").equivalent).toBe(false);
    for (const state of [
      { requested: "detached" as const, deadlineMs: 4000, transitions: [visible, hidden] },
      {
        requested: "detached" as const,
        deadlineMs: 3000,
        transitions: [visible, { ...hidden, elapsedMs: 3001 }],
      },
      { requested: "detached" as const, deadlineMs: 3000, transitions: [hidden] },
      {
        requested: "detached" as const,
        deadlineMs: 3000,
        transitions: [visible, detached, hidden],
      },
    ])
      expect(
        waitStateEquivalence(baseline, [evidence({ phase: "after", state })], "checkout", "hidden")
          .equivalent,
      ).toBe(false);
    expect(
      waitStateEquivalence(
        baseline,
        [evidence({ ...failed[0], cardinality: 2, candidates: [element(), element()] })],
        "checkout",
        "hidden",
      ).equivalent,
    ).toBe(false);
    expect(
      waitStateEquivalence(
        baseline,
        [evidence({ ...failed[0], candidates: [element(), element({ matched: false })] })],
        "checkout",
        "hidden",
      ).equivalent,
    ).toBe(false);
  });
});
