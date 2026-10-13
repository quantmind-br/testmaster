import type { ReactNode } from "react";
import { sanitizeUntrusted } from "../lib/untrusted";

interface UntrustedTextProps {
  readonly value: string | null | undefined;
  readonly maxLength?: number;
  /** Multi-line content (logs, Markdown source, DOM text) renders in a preformatted block. */
  readonly block?: boolean;
  readonly fallback?: string;
}

/**
 * The only way the portal renders text that originates outside TestMaster. The value is escaped
 * by React, stripped of bidi and control characters, and length-limited with a visible note.
 * It never uses `dangerouslySetInnerHTML`, and Markdown or HTML stay as source text.
 */
export function UntrustedText({
  value,
  maxLength,
  block,
  fallback = "—",
}: UntrustedTextProps): ReactNode {
  if (value === null || value === undefined || value === "") return <span>{fallback}</span>;
  const result = sanitizeUntrusted(value, {
    ...(maxLength === undefined ? {} : { maxLength }),
    keepNewlines: block === true,
  });
  const note = result.truncated ? (
    <span className="truncated-note">
      {" "}
      (truncated, {result.originalLength - result.text.length} more characters)
    </span>
  ) : null;
  if (block)
    return (
      <>
        <pre className="untrusted-block" data-untrusted="">
          {result.text}
        </pre>
        {note}
      </>
    );
  return (
    <span data-untrusted="">
      {result.text}
      {note}
    </span>
  );
}
