import { describe, expect, it } from "vitest";
import {
  classifyGatewayFailure,
  describeAccessClass,
  describeIntegrity,
  describeManifestCompleteness,
  formatBytes,
  presentTextBody,
  selectArtifactViewer,
  textLimitBytes,
  textRange,
  viewerDisposition,
} from "./artifact-view";
import type { ManifestEntry } from "./run-types";

function entry(patch: Partial<ManifestEntry>): ManifestEntry {
  return {
    relativePath: "evidence/file.bin",
    artifactId: "art-1",
    kind: "other",
    mimeType: "application/octet-stream",
    sizeBytes: 10,
    sha256: "a".repeat(64),
    state: "available",
    redactionStatus: "redacted",
    ...patch,
  };
}

describe("artifact viewer selection", () => {
  it("UX-031 screenshots use the image viewer, text evidence the escaped text viewer, DOM HTML only a sandboxed frame or source text", () => {
    expect(
      selectArtifactViewer(entry({ kind: "screenshot", mimeType: "image/png" })).viewers,
    ).toEqual(["image", "download"]);
    for (const [kind, mimeType] of [
      ["http", "application/json"],
      ["console", "application/json"],
      ["network", "application/x-ndjson"],
      ["log", "text/plain; charset=utf-8"],
      ["dom", "application/json"],
    ] as const)
      expect(selectArtifactViewer(entry({ kind, mimeType })).viewers[0], kind).toBe("text");
    const dom = selectArtifactViewer(entry({ kind: "dom", mimeType: "text/html" }));
    expect(dom.viewers).toEqual(["frame", "text", "download"]);
    // Negative controls: active or opaque content is never inlined as text or an image.
    expect(selectArtifactViewer(entry({ mimeType: "image/svg+xml" })).viewers).toEqual([
      "download",
    ]);
    expect(
      selectArtifactViewer(entry({ kind: "download", mimeType: "application/zip" })).viewers,
    ).toEqual(["download"]);
    expect(selectArtifactViewer(entry({ mimeType: "video/webm" })).viewers).toEqual(["download"]);
    expect(
      selectArtifactViewer(entry({ kind: "dom", mimeType: "text/html" })).viewers,
    ).not.toContain("image");
  });

  it("UX-031 terminal evidence is shown inline as text or JSON and its asciicast recording is only downloadable", () => {
    for (const [kind, mimeType] of [
      ["terminal.process", "application/json"],
      ["terminal.stdout", "text/plain"],
      ["terminal.stderr", "text/plain"],
      ["terminal.screen", "text/plain"],
    ] as const)
      expect(selectArtifactViewer(entry({ kind, mimeType })).viewers, kind).toEqual([
        "text",
        "download",
      ]);
    // Negative control: the recording is a replay format, never previewed as text or an image.
    expect(
      selectArtifactViewer(entry({ kind: "terminal.cast", mimeType: "application/x-asciicast" }))
        .viewers,
    ).toEqual(["download"]);
  });

  it("UX-031 an artifact that is missing, expired or partial is named, never replaced by a viewer", () => {
    const missing = selectArtifactViewer(
      entry({
        state: "missing",
        omissionReason: "browser_crashed",
        kind: "screenshot",
        mimeType: "image/png",
        sha256: null,
        sizeBytes: 0,
      }),
    );
    expect(missing.viewers).toEqual(["unavailable"]);
    expect(missing.reason).toBe("Not captured: browser_crashed");
    expect(selectArtifactViewer(entry({ state: "expired" })).reason).toContain("Expired");
    expect(selectArtifactViewer(entry({ state: "partial" })).viewers).toEqual(["unavailable"]);
    // Positive control: the same entry, when available, does get a viewer.
    expect(
      selectArtifactViewer(entry({ kind: "screenshot", mimeType: "image/png" })).viewers[0],
    ).toBe("image");
  });

  it("UX-032 restricted raw evidence offers no viewer or link even when it would be an image or text", () => {
    const byStatus = selectArtifactViewer(
      entry({ redactionStatus: "restrictedRaw", mimeType: "text/plain" }),
    );
    const byKind = selectArtifactViewer(
      entry({ kind: "restrictedRaw.trace", mimeType: "application/zip" }),
    );
    expect(byStatus.viewers).toEqual(["restricted"]);
    expect(byKind.viewers).toEqual(["restricted"]);
    expect(byKind.reason).toContain("not available through the portal");
    expect(selectArtifactViewer(entry({ mimeType: "text/plain" })).viewers).not.toContain(
      "restricted",
    );
  });

  it("UX-032 only the download viewer asks the gateway for an attachment", () => {
    expect(viewerDisposition("download")).toBe("attachment");
    for (const viewer of ["image", "text", "frame"] as const)
      expect(viewerDisposition(viewer)).toBe("inline");
  });
});

describe("artifact metadata", () => {
  it("UX-030 access class and integrity are explicit for every state", () => {
    expect(describeAccessClass(entry({}))).toBe("Redacted");
    expect(describeAccessClass(entry({ redactionStatus: "restrictedRaw" }))).toBe("Restricted raw");
    expect(describeAccessClass(entry({ redactionStatus: "not_applicable" }))).toBe(
      "Not applicable",
    );
    expect(describeIntegrity(entry({}))).toMatchObject({ label: "Available", tone: "success" });
    expect(describeIntegrity(entry({ sha256: null }))).toMatchObject({ tone: "warning" });
    expect(
      describeIntegrity(entry({ state: "missing", omissionReason: "oom", sha256: null })),
    ).toMatchObject({ label: "Not captured", detail: "oom", tone: "danger" });
    expect(describeIntegrity(entry({ state: "expired" })).label).toBe("Expired");
    expect(describeIntegrity(entry({ state: "partial" })).label).toBe("Partial");
  });

  it("UX-030 an artifact without a recorded hash, a capture or full availability never reads as plain available", () => {
    for (const patch of [
      { sha256: null },
      { state: "missing" as const },
      { state: "expired" as const },
      { state: "partial" as const },
    ])
      expect(describeIntegrity(entry(patch)).label, JSON.stringify(patch)).not.toBe("Available");
    expect(describeIntegrity(entry({ sha256: null })).tone).not.toBe("success");
    expect(describeAccessClass(entry({ redactionStatus: "restrictedRaw" }))).not.toBe("Redacted");
  });

  it("UX-030 a partial or subset manifest carries a warning and a complete one does not", () => {
    expect(describeManifestCompleteness({ entries: [entry({})] })).toBeNull();
    expect(
      describeManifestCompleteness({
        subset: true,
        entries: [entry({}), entry({ state: "missing" }), entry({ state: "expired" })],
      }),
    ).toBe(
      "This manifest is a subset of the sealed bundle. Evidence is incomplete: 1 not captured, 1 expired.",
    );
    expect(describeManifestCompleteness({ entries: [entry({ state: "partial" })] })).toBe(
      "Evidence is incomplete: 1 partial.",
    );
  });
});

describe("gateway responses and text bodies", () => {
  it("UX-032 an expired link, a tombstoned artifact and a refusal are stated differently, none as a blank frame", () => {
    expect(classifyGatewayFailure(401).state).toBe("link-expired");
    expect(classifyGatewayFailure(404)).toMatchObject({
      state: "gone",
      message: "This artifact expired or was deleted.",
    });
    expect(classifyGatewayFailure(410).state).toBe("gone");
    expect(classifyGatewayFailure(403).state).toBe("refused");
    expect(classifyGatewayFailure(500).state).toBe("error");
    const messages = [401, 403, 404, 500].map((status) => classifyGatewayFailure(status).message);
    expect(new Set(messages).size).toBe(4);
  });

  it("UX-031 text is fetched with a bounded inclusive range and long bodies are cut with a notice", () => {
    expect(textRange(10)).toBe("bytes=0-9");
    expect(textRange(textLimitBytes * 4)).toBe(`bytes=0-${textLimitBytes - 1}`);
    // Negative control: an empty artifact needs no request at all.
    expect(textRange(0)).toBeNull();
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatBytes(Number.NaN)).toBe("unknown size");
  });

  it("UX-031 complete JSON is indented while truncated or non-JSON bodies stay verbatim", () => {
    expect(presentTextBody('{"a":1}', "application/json", false)).toBe('{\n  "a": 1\n}');
    expect(presentTextBody('{"a":', "application/json", true)).toBe('{"a":');
    expect(presentTextBody("{not json", "application/json", false)).toBe("{not json");
    expect(presentTextBody('{"a":1}', "text/plain", false)).toBe('{"a":1}');
    expect(presentTextBody("<script>x</script>", "text/html", false)).toBe("<script>x</script>");
  });
});
