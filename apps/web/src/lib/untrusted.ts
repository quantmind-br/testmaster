/**
 * Untrusted content (titles, PRD text, Markdown, logs, DOM snapshots) is only ever rendered as
 * escaped text. React escapes markup; this module additionally neutralises characters that can
 * reorder or hide text (bidirectional overrides, zero-width and C0/C1 controls) so a value cannot
 * spoof what the reviewer reads.
 */
const HIDDEN_CATEGORIES = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export interface SanitizedText {
  readonly text: string;
  readonly truncated: boolean;
  readonly replaced: number;
  readonly originalLength: number;
}

export function sanitizeUntrusted(
  value: string,
  options: { maxLength?: number; keepNewlines?: boolean } = {},
): SanitizedText {
  const maxLength = options.maxLength ?? 10_000;
  let replaced = 0;
  let text = "";
  for (const character of value) {
    const keep =
      character === "\t" ||
      (options.keepNewlines === true && (character === "\n" || character === "\r"));
    if (!keep && HIDDEN_CATEGORIES.test(character)) {
      replaced++;
      text += `⟦U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟧`;
    } else text += character;
  }
  const truncated = text.length > maxLength;
  return {
    text: truncated ? text.slice(0, maxLength) : text,
    truncated,
    replaced,
    originalLength: value.length,
  };
}

/** Same-origin gateway links only; anything else is rendered as a plain download refusal. */
export function isGatewayLink(href: string, origin: string): boolean {
  try {
    const url = new URL(href, origin);
    return url.origin === origin && /^\/v1\//.test(url.pathname);
  } catch {
    return false;
  }
}
