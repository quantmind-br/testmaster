import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio, luminance, parseThemeCss, requirements } from "./contrast";

const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
const themes = parseThemeCss(css);

describe("portal theme contrast", () => {
  it("UX-052 computes WCAG ratios against the reference black and white pair", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#ffffff")).toBeCloseTo(1, 10);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 10);
    // 767676 on white is the canonical 4.54:1 example.
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });

  for (const scheme of ["light", "dark"] as const) {
    describe(`${scheme} scheme`, () => {
      for (const requirement of requirements) {
        it(`UX-052 ${requirement.foreground} on ${requirement.background} meets ${requirement.minimum}:1 (${requirement.use})`, () => {
          const table = themes[scheme];
          const foreground = table[requirement.foreground];
          const background = table[requirement.background];
          expect(foreground, `token ${requirement.foreground}`).toBeDefined();
          expect(background, `token ${requirement.background}`).toBeDefined();
          const ratio = contrastRatio(foreground as string, background as string);
          expect(ratio).toBeGreaterThanOrEqual(requirement.minimum);
        });
      }
    });
  }

  it("UX-052 rejects a token pair below the threshold", () => {
    expect(contrastRatio("#999999", "#ffffff")).toBeLessThan(4.5);
    expect(contrastRatio("#888888", "#ffffff")).toBeLessThan(4.5);
  });

  it("UX-052 every colour token of the table is defined in both schemes", () => {
    expect(Object.keys(themes.dark).sort()).toEqual(Object.keys(themes.light).sort());
    expect(Object.keys(themes.light).length).toBeGreaterThan(20);
  });

  it("UX-052 the stylesheet only references tokens that exist", () => {
    const stylesheet = readFileSync(new URL("../app.css", import.meta.url), "utf8");
    const referenced = new Set([...stylesheet.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]));
    for (const name of referenced) {
      if (name?.startsWith("space-") || name?.startsWith("radius") || name?.startsWith("font-"))
        continue;
      expect(themes.light[name as string], `--${name}`).toBeDefined();
    }
  });
});
