import type { ReactNode } from "react";
import { isGatewayLink } from "../lib/untrusted";

/**
 * HTML, trace and other active artifacts are never inlined. They open only through a signed,
 * same-origin gateway link inside a fully sandboxed frame (no scripts, no same-origin access), or
 * are offered as a download. Anything else is refused.
 */
export function ArtifactFrame({
  href,
  title,
  downloadName,
  origin = window.location.origin,
}: {
  href: string;
  title: string;
  downloadName?: string;
  origin?: string;
}): ReactNode {
  if (!isGatewayLink(href, origin))
    return (
      <p role="alert" className="banner tone-danger">
        This artifact link is not a gateway link and was not opened.
      </p>
    );
  return (
    <div>
      <iframe
        className="artifact"
        title={title}
        src={href}
        sandbox=""
        referrerPolicy="no-referrer"
        loading="lazy"
      />
      <p>
        <a href={href} download={downloadName ?? true}>
          Download {title}
        </a>
      </p>
    </div>
  );
}
