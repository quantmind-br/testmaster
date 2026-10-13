import type { ManifestEntry } from "./run-types";

/**
 * How the portal presents one manifest entry (UX-030, UX-031, UX-032). Pure so the rules are unit
 * tested: nothing here touches the network or the DOM, and nothing renders active content inline.
 *
 *  - images are drawn with `<img>` from the signed gateway link;
 *  - text-like evidence is fetched and shown as escaped text;
 *  - HTML (a DOM snapshot) only appears in a fully sandboxed frame, or as escaped source text;
 *  - traces, video, archives and unknown types are offered as an attachment download;
 *  - restricted raw evidence never gets a link, and an artifact that was not captured, has expired
 *    or is only partial is named as such instead of being replaced by a placeholder.
 */
export type ViewerKind = "image" | "text" | "frame" | "download" | "restricted" | "unavailable";
export type LinkDisposition = "inline" | "attachment";

export interface ArtifactViewPlan {
  /** Viewers the user may choose, default first; `restricted` and `unavailable` stand alone. */
  readonly viewers: readonly ViewerKind[];
  /** Why the artifact has no viewer, or a short note on how it is shown. */
  readonly reason: string;
}

export interface IntegrityDescription {
  readonly label: string;
  readonly tone: "success" | "warning" | "danger" | "neutral";
  readonly detail: string;
}

/** Text bodies are fetched with a byte range; larger evidence is cut with an explicit notice. */
export const textLimitBytes = 64 * 1024;

const rasterImages: Readonly<Record<string, true>> = {
  "image/png": true,
  "image/jpeg": true,
  "image/gif": true,
  "image/webp": true,
};
const textKinds: Readonly<Record<string, true>> = {
  console: true,
  network: true,
  http: true,
  log: true,
  protocol: true,
  snapshot: true,
  "locator-evidence": true,
};
const textMimeTypes: Readonly<Record<string, true>> = {
  "application/json": true,
  "application/x-ndjson": true,
  "application/ndjson": true,
  "application/xml": true,
  "application/yaml": true,
};

function baseMime(mimeType: string): string {
  return (mimeType.split(";", 1)[0] ?? "").trim().toLowerCase();
}

export function isRestrictedRaw(entry: Pick<ManifestEntry, "kind" | "redactionStatus">): boolean {
  return entry.redactionStatus === "restrictedRaw" || entry.kind.startsWith("restrictedRaw.");
}

function isTextLike(entry: ManifestEntry): boolean {
  const mime = baseMime(entry.mimeType);
  return (
    mime.startsWith("text/") ||
    mime.endsWith("+json") ||
    textMimeTypes[mime] === true ||
    textKinds[entry.kind] === true
  );
}

export function selectArtifactViewer(entry: ManifestEntry): ArtifactViewPlan {
  if (isRestrictedRaw(entry))
    return {
      viewers: ["restricted"],
      reason: "Restricted raw evidence is not available through the portal.",
    };
  if (entry.state === "missing")
    return {
      viewers: ["unavailable"],
      reason: `Not captured${entry.omissionReason ? `: ${entry.omissionReason}` : "."}`,
    };
  if (entry.state === "expired")
    return { viewers: ["unavailable"], reason: "Expired: the retention period has passed." };
  if (entry.state === "partial")
    return {
      viewers: ["unavailable"],
      reason: `Only partly captured, so it is not served${
        entry.omissionReason ? `: ${entry.omissionReason}` : "."
      }`,
    };
  const mime = baseMime(entry.mimeType);
  if (rasterImages[mime] === true) return { viewers: ["image", "download"], reason: "Image." };
  if (mime === "text/html")
    return {
      viewers: ["frame", "text", "download"],
      reason: "HTML is shown in a sandboxed frame without scripts, or as source text.",
    };
  if (isTextLike(entry)) return { viewers: ["text", "download"], reason: "Text." };
  return {
    viewers: ["download"],
    reason: "This type is not previewed; download it to inspect it.",
  };
}

export function viewerDisposition(viewer: ViewerKind): LinkDisposition {
  return viewer === "download" ? "attachment" : "inline";
}

export const viewerLabel: Readonly<Record<ViewerKind, string>> = {
  image: "View image",
  text: "View as text",
  frame: "View in sandboxed frame",
  download: "Download",
  restricted: "Restricted",
  unavailable: "Unavailable",
};

export function describeAccessClass(entry: ManifestEntry): string {
  if (isRestrictedRaw(entry)) return "Restricted raw";
  if (entry.redactionStatus === "redacted") return "Redacted";
  return "Not applicable";
}

export function describeIntegrity(entry: ManifestEntry): IntegrityDescription {
  switch (entry.state) {
    case "available":
      return entry.sha256
        ? { label: "Available", tone: "success", detail: "Hash recorded in the sealed manifest." }
        : {
            label: "Available, no hash",
            tone: "warning",
            detail: "The manifest records no SHA-256 for this artifact.",
          };
    case "missing":
      return {
        label: "Not captured",
        tone: "danger",
        detail: entry.omissionReason ?? "The artifact was never stored.",
      };
    case "expired":
      return { label: "Expired", tone: "neutral", detail: "Removed after the retention period." };
    case "partial":
      return {
        label: "Partial",
        tone: "warning",
        detail: entry.omissionReason ?? "Only part of the artifact was captured.",
      };
  }
}

/** Bundle-level warning: a subset or any entry that is not fully available. */
export function describeManifestCompleteness(manifest: {
  readonly subset?: boolean;
  readonly entries: readonly ManifestEntry[];
}): string | null {
  const incomplete = manifest.entries.filter((entry) => entry.state !== "available");
  const parts: string[] = [];
  if (manifest.subset === true) parts.push("This manifest is a subset of the sealed bundle.");
  if (incomplete.length > 0) {
    const missing = incomplete.filter((entry) => entry.state === "missing").length;
    const expired = incomplete.filter((entry) => entry.state === "expired").length;
    const partial = incomplete.filter((entry) => entry.state === "partial").length;
    const counts = [
      missing > 0 ? `${missing} not captured` : null,
      expired > 0 ? `${expired} expired` : null,
      partial > 0 ? `${partial} partial` : null,
    ].filter((part): part is string => part !== null);
    parts.push(`Evidence is incomplete: ${counts.join(", ")}.`);
  }
  return parts.length === 0 ? null : parts.join(" ");
}

export type GatewayFailure =
  | { readonly state: "link-expired"; readonly message: string }
  | { readonly state: "gone"; readonly message: string }
  | { readonly state: "refused"; readonly message: string }
  | { readonly state: "error"; readonly message: string };

/**
 * Maps a gateway or link-mint HTTP status to what the page says. A tombstoned, expired or deleted
 * artifact (404/410) is stated as such, never shown as an empty frame; an expired link (401) asks
 * for a new one from the authenticated page.
 */
export function classifyGatewayFailure(status: number): GatewayFailure {
  if (status === 401)
    return {
      state: "link-expired",
      message: "The download link expired or is no longer valid. Request a new link.",
    };
  if (status === 404 || status === 410)
    return { state: "gone", message: "This artifact expired or was deleted." };
  if (status === 403)
    return { state: "refused", message: "You are not allowed to open this artifact." };
  return { state: "error", message: "The artifact could not be loaded." };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Inclusive `Range` header for the first `limit` bytes, or null for an empty artifact. */
export function textRange(sizeBytes: number, limit = textLimitBytes): string | null {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return null;
  return `bytes=0-${Math.min(sizeBytes, limit) - 1}`;
}

/** Pretty-prints a complete JSON body; truncated or non-JSON bodies stay exactly as received. */
export function presentTextBody(text: string, mimeType: string, truncated: boolean): string {
  const mime = baseMime(mimeType);
  if (truncated || !(mime === "application/json" || mime.endsWith("+json"))) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
