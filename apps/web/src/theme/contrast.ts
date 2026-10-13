/** WCAG 2.x contrast computation over the token table in theme.css. */

export type TokenTable = Readonly<Record<string, string>>;
export interface ThemeTables {
  readonly light: TokenTable;
  readonly dark: TokenTable;
}

const declaration = /--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g;

function tokens(block: string): TokenTable {
  const table: Record<string, string> = {};
  for (const match of block.matchAll(declaration)) table[match[1] as string] = match[2] as string;
  return table;
}

/** Splits theme.css into the light (`:root`) table and the dark (media query) overrides. */
export function parseThemeCss(css: string): ThemeTables {
  const dark = css.indexOf("@media (prefers-color-scheme: dark)");
  if (dark < 0) throw new Error("theme.css has no dark scheme block");
  const light = tokens(css.slice(0, dark));
  return { light, dark: { ...light, ...tokens(css.slice(dark)) } };
}

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!match) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const [red, green, blue] = [match[1], match[2], match[3]].map((part) =>
    channel(Number.parseInt(part as string, 16)),
  ) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground: string, background: string): number {
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (high + 0.05) / (low + 0.05);
}

export interface ContrastRequirement {
  readonly foreground: string;
  readonly background: string;
  readonly minimum: number;
  readonly use: "text" | "non-text";
}

const text = (foreground: string, background: string): ContrastRequirement => ({
  foreground,
  background,
  minimum: 4.5,
  use: "text",
});
const nonText = (foreground: string, background: string): ContrastRequirement => ({
  foreground,
  background,
  minimum: 3,
  use: "non-text",
});

/** Every pair the stylesheet combines. A new token pair in app.css must be listed here. */
export const requirements: readonly ContrastRequirement[] = [
  ...["bg", "surface", "surface-raised"].flatMap((surface) => [
    text("text", surface),
    text("text-muted", surface),
    text("link", surface),
    nonText("border", surface),
    nonText("focus", surface),
  ]),
  text("accent-text", "accent"),
  nonText("accent", "bg"),
  nonText("accent", "surface"),
  ...["success", "warning", "danger", "info", "neutral"].flatMap((tone) => [
    text(`${tone}-text`, `${tone}-bg`),
    nonText(`${tone}-text`, `${tone}-bg`),
    text("text", `${tone}-bg`),
  ]),
];
