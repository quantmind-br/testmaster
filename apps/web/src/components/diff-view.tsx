import type { ReactNode } from "react";
import { type DiffLine, diffLines } from "../lib/diff";
import { sanitizeUntrusted } from "../lib/untrusted";

const markers: Record<DiffLine["kind"], { symbol: string; label: string }> = {
  same: { symbol: " ", label: "unchanged" },
  added: { symbol: "+", label: "added" },
  removed: { symbol: "−", label: "removed" },
};

/** Line diff. Added and removed rows carry a symbol and a hidden label, never colour alone. */
export function DiffView({
  before,
  after,
  caption,
}: {
  before: string;
  after: string;
  caption: string;
}): ReactNode {
  const lines = diffLines(before, after);
  if (lines === null)
    return (
      <p role="status">This diff is too large to render here. Download both versions to compare.</p>
    );
  if (lines.every((line) => line.kind === "same")) return <p role="status">No differences.</p>;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a named scroll region keeps its caption
    // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll it
    <div className="table-scroll" role="region" aria-label={caption} tabIndex={0}>
      <table className="diff">
        <caption className="visually-hidden">{caption}</caption>
        <tbody>
          {lines.map((line, index) => (
            // Lines have no stable identity; position within one diff is the identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: diff rows are positional
            <tr key={index} className={line.kind}>
              <td className="marker" aria-hidden="true">
                {markers[line.kind].symbol}
              </td>
              <td>
                <span className="visually-hidden">{markers[line.kind].label}: </span>
                {sanitizeUntrusted(line.text, { maxLength: 2_000 }).text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
