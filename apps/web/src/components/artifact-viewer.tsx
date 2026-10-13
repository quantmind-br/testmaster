import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ApiError, api } from "../api";
import {
  type ArtifactViewPlan,
  classifyGatewayFailure,
  describeAccessClass,
  describeIntegrity,
  describeManifestCompleteness,
  formatBytes,
  type GatewayFailure,
  isRestrictedRaw,
  presentTextBody,
  selectArtifactViewer,
  textLimitBytes,
  textRange,
  type ViewerKind,
  viewerDisposition,
  viewerLabel,
} from "../lib/artifact-view";
import { formatServerTime, type StepGroup } from "../lib/run-facts";
import type {
  ArtifactLinkRecord,
  AttemptRecord,
  BundleRecord,
  ManifestEntry,
} from "../lib/run-types";
import { isGatewayLink } from "../lib/untrusted";
import { ArtifactFrame } from "./artifact-frame";
import { type Column, DataTable } from "./data-table";
import { Icon, type Shape } from "./status";
import { UntrustedText } from "./untrusted-text";
import { ViewState } from "./view-state";

/**
 * Artifacts of a Run, one bundle per Attempt (UX-030, UX-031, UX-032). Links to the authorized
 * gateway are minted only when someone opens an artifact, are never copied into the page address,
 * and are never shown for restricted raw evidence. Artifact bytes render as images, escaped text,
 * a sandboxed frame or a download, and a link or artifact that is gone says so.
 */
export type BundleState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly manifest: BundleRecord["manifest"] }
  | { readonly status: "unavailable"; readonly message: string }
  | { readonly status: "error"; readonly message: string };

export interface ArtifactSelection {
  readonly attemptId: string;
  readonly artifactId: string;
  readonly viewer: ViewerKind;
  /**
   * True when the address opened the viewer (a deep link) rather than a person: loading a page
   * must not move keyboard focus into the middle of it, so the panel leaves focus where it is.
   */
  readonly fromAddress?: boolean;
  /** A new value remounts the viewer so a repeated click mints a fresh link. */
  readonly nonce: number;
}

function bundleFailure(error: unknown): BundleState {
  if (error instanceof ApiError) {
    if (error.code === "PRECONDITION_FAILED")
      return {
        status: "unavailable",
        message:
          error.details.reason === "expired"
            ? "The evidence bundle of this attempt expired."
            : "No evidence bundle was captured for this attempt.",
      };
    if (error.hidesExistence)
      return { status: "unavailable", message: "The evidence bundle is not accessible." };
    return { status: "error", message: `The evidence bundle could not be loaded (${error.code}).` };
  }
  return { status: "error", message: "The evidence bundle could not be loaded." };
}

/**
 * Loads each Attempt's manifest. `refreshKey` reloads them (for example when a live Run
 * collects evidence) while keeping what is already shown.
 */
export function useAttemptBundles(
  runId: string,
  attemptIds: readonly string[],
  refreshKey: string,
): Readonly<Record<string, BundleState>> {
  const [bundles, setBundles] = useState<Readonly<Record<string, BundleState>>>({});
  const idsKey = attemptIds.join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refreshKey` triggers a reload on purpose
  useEffect(() => {
    const controller = new AbortController();
    for (const attemptId of idsKey === "" ? [] : idsKey.split("|")) {
      api<BundleRecord>("GET", `/runs/${encodeURIComponent(runId)}/bundle`, {
        query: { attemptId },
        signal: controller.signal,
      })
        .then((result) => {
          if (controller.signal.aborted) return;
          setBundles((current) => ({
            ...current,
            [attemptId]: { status: "ready", manifest: result.data.manifest },
          }));
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setBundles((current) => ({ ...current, [attemptId]: bundleFailure(error) }));
        });
    }
    return () => controller.abort();
  }, [runId, idsKey, refreshKey]);
  return bundles;
}

type LinkState =
  | { readonly status: "minting" }
  | { readonly status: "ready"; readonly link: ArtifactLinkRecord }
  | { readonly status: "failed"; readonly failure: GatewayFailure; readonly detail: string | null };

type Probe =
  | { readonly status: "checking" }
  | { readonly status: "ok" }
  | { readonly status: "failed"; readonly failure: GatewayFailure };

function GatewayNotice(props: {
  failure: GatewayFailure;
  detail?: string | null;
  onRenew?: () => void;
}): ReactNode {
  return (
    <div>
      <div role="alert" className="banner tone-warning" data-gateway-state={props.failure.state}>
        <Icon shape="warn" />
        <span>{props.failure.message}</span>
      </div>
      {props.detail ? (
        <p>
          Reason: <UntrustedText value={props.detail} maxLength={300} />
        </p>
      ) : null}
      {props.failure.state === "link-expired" && props.onRenew ? (
        <button type="button" className="button secondary" onClick={props.onRenew}>
          Request a new link
        </button>
      ) : null}
    </div>
  );
}

/** One-byte ranged read: finds out whether the gateway still serves the artifact before a frame or download is offered. */
function useGatewayProbe(url: string, sizeBytes: number, enabled: boolean): Probe {
  const [probe, setProbe] = useState<Probe>({ status: "checking" });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setProbe({ status: "checking" });
    const range = textRange(sizeBytes, 1);
    fetch(url, {
      headers: range ? { Range: range } : {},
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        void response.body?.cancel();
        setProbe(
          response.ok
            ? { status: "ok" }
            : { status: "failed", failure: classifyGatewayFailure(response.status) },
        );
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setProbe({ status: "failed", failure: classifyGatewayFailure(0) });
      });
    return () => controller.abort();
  }, [url, sizeBytes, enabled]);
  return probe;
}

type TextState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly text: string; readonly truncated: boolean }
  | { readonly status: "failed"; readonly failure: GatewayFailure };

function TextViewer(props: { url: string; entry: ManifestEntry; onRenew: () => void }): ReactNode {
  const { url, entry } = props;
  const [state, setState] = useState<TextState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    const range = textRange(entry.sizeBytes);
    if (range === null) {
      setState({ status: "ready", text: "", truncated: false });
      return;
    }
    setState({ status: "loading" });
    fetch(url, {
      headers: { Range: range },
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          setState({ status: "failed", failure: classifyGatewayFailure(response.status) });
          return;
        }
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, textLimitBytes));
        const truncated = entry.sizeBytes > textLimitBytes;
        setState({
          status: "ready",
          text: presentTextBody(new TextDecoder("utf-8").decode(bytes), entry.mimeType, truncated),
          truncated,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState({ status: "failed", failure: classifyGatewayFailure(0) });
      });
    return () => controller.abort();
  }, [url, entry.sizeBytes, entry.mimeType]);
  if (state.status === "loading")
    return (
      <ViewState kind="loading" title="Loading artifact" message="Fetching the artifact text." />
    );
  if (state.status === "failed")
    return <GatewayNotice failure={state.failure} onRenew={props.onRenew} />;
  if (state.text === "") return <p>This artifact is empty.</p>;
  return (
    <div data-testid="artifact-text">
      <UntrustedText value={state.text} block maxLength={textLimitBytes} />
      {state.truncated ? (
        <p className="truncated-note">
          Showing the first {formatBytes(textLimitBytes)} of {formatBytes(entry.sizeBytes)}.
          Download the artifact to read the rest.
        </p>
      ) : null}
    </div>
  );
}

function LinkedViewer(props: {
  entry: ManifestEntry;
  viewer: ViewerKind;
  link: ArtifactLinkRecord;
  onRenew: () => void;
}): ReactNode {
  const { entry, viewer, link } = props;
  const [expired, setExpired] = useState(false);
  const [imageFailure, setImageFailure] = useState<GatewayFailure | null>(null);
  const probe = useGatewayProbe(
    link.url,
    entry.sizeBytes,
    viewer === "frame" || viewer === "download",
  );
  // The link is a short-lived capability; once its time is up the page stops offering it.
  useEffect(() => {
    const remaining = Date.parse(link.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      setExpired(true);
      return;
    }
    setExpired(false);
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [link.expiresAt]);

  async function diagnoseImage(): Promise<void> {
    try {
      const response = await fetch(link.url, {
        headers: { Range: "bytes=0-0" },
        credentials: "omit",
        cache: "no-store",
      });
      void response.body?.cancel();
      setImageFailure(classifyGatewayFailure(response.ok ? 415 : response.status));
    } catch {
      setImageFailure(classifyGatewayFailure(0));
    }
  }

  if (!isGatewayLink(link.url, window.location.origin))
    return (
      <p role="alert" className="banner tone-danger">
        The artifact link is not a gateway link and was not opened.
      </p>
    );
  if (expired && viewer === "download")
    return <GatewayNotice failure={classifyGatewayFailure(401)} onRenew={props.onRenew} />;
  if (imageFailure) return <GatewayNotice failure={imageFailure} onRenew={props.onRenew} />;
  const note = (
    <p className="truncated-note">
      Temporary link, valid until {formatServerTime(link.expiresAt)}. It is not part of the page
      address.
    </p>
  );
  if (viewer === "image")
    return (
      <div>
        <img
          className="artifact-image"
          data-testid="artifact-image"
          src={link.url}
          alt={`${entry.kind} artifact ${entry.relativePath}`}
          onError={() => void diagnoseImage()}
        />
        {note}
      </div>
    );
  if (viewer === "text")
    return (
      <div>
        <TextViewer url={link.url} entry={entry} onRenew={props.onRenew} />
        {note}
      </div>
    );
  if (probe.status === "checking")
    return (
      <ViewState
        kind="loading"
        title="Checking artifact"
        message="Confirming the gateway still serves this artifact."
      />
    );
  if (probe.status === "failed")
    return <GatewayNotice failure={probe.failure} onRenew={props.onRenew} />;
  if (viewer === "frame")
    return (
      <div>
        <ArtifactFrame
          href={link.url}
          title={`${entry.kind} artifact ${entry.relativePath}`}
          downloadName={entry.relativePath.split("/").pop() ?? "artifact"}
        />
        {note}
      </div>
    );
  return (
    <div>
      <p>
        <a
          className="button"
          data-testid="artifact-download"
          href={link.url}
          download={entry.relativePath.split("/").pop() ?? "artifact"}
        >
          Download {entry.relativePath.split("/").pop() ?? "artifact"} (
          {formatBytes(entry.sizeBytes)})
        </a>
      </p>
      {note}
    </div>
  );
}

function ArtifactPanel(props: {
  entry: ManifestEntry;
  viewer: ViewerKind;
  attemptNumber: number | null;
  fromAddress: boolean;
  onClose: () => void;
}): ReactNode {
  const { entry, viewer } = props;
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const [link, setLink] = useState<LinkState>({ status: "minting" });
  const [renewals, setRenewals] = useState(0);
  const { fromAddress } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus moves once, when the panel opens
  useEffect(() => {
    if (!fromAddress) heading.current?.focus();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `renewals` mints a fresh link on demand
  useEffect(() => {
    const controller = new AbortController();
    setLink({ status: "minting" });
    api<ArtifactLinkRecord>("POST", `/artifacts/${encodeURIComponent(entry.artifactId)}/links`, {
      body: { disposition: viewerDisposition(viewer) },
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setLink({ status: "ready", link: result.data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const status = error instanceof ApiError ? error.status : 0;
        setLink({
          status: "failed",
          failure: classifyGatewayFailure(status),
          detail: error instanceof ApiError && status === 403 ? error.message : null,
        });
      });
    return () => controller.abort();
  }, [entry.artifactId, viewer, renewals]);
  return (
    <section className="artifact-panel" aria-labelledby={headingId} data-testid="artifact-panel">
      <h3 id={headingId} tabIndex={-1} ref={heading}>
        {viewerLabel[viewer]}: <UntrustedText value={entry.relativePath} maxLength={200} />
      </h3>
      <p>
        {props.attemptNumber === null ? "Attempt unknown" : `Attempt ${props.attemptNumber}`} ·{" "}
        {entry.kind} · {formatBytes(entry.sizeBytes)}
      </p>
      {link.status === "minting" ? (
        <ViewState
          kind="loading"
          title="Opening artifact"
          message="Requesting a temporary link from the gateway."
        />
      ) : link.status === "failed" ? (
        <GatewayNotice
          failure={link.failure}
          detail={link.detail}
          onRenew={() => setRenewals((count) => count + 1)}
        />
      ) : (
        <LinkedViewer
          entry={entry}
          viewer={viewer}
          link={link.link}
          onRenew={() => setRenewals((count) => count + 1)}
        />
      )}
      <p>
        <button type="button" className="button secondary" onClick={props.onClose}>
          Close viewer
        </button>
      </p>
    </section>
  );
}

const integrityShape: Record<"success" | "warning" | "danger" | "neutral", Shape> = {
  success: "check",
  warning: "warn",
  danger: "cross",
  neutral: "clock",
};

function IntegrityBadge({ entry }: { entry: ManifestEntry }): ReactNode {
  const integrity = describeIntegrity(entry);
  return (
    <span>
      <span className={`badge tone-${integrity.tone}`} data-integrity={entry.state}>
        <Icon shape={integrityShape[integrity.tone]} />
        <span>{integrity.label}</span>
      </span>
      {entry.state === "available" && entry.sha256 ? null : (
        <span className="truncated-note">
          {" "}
          <UntrustedText value={integrity.detail} maxLength={200} />
        </span>
      )}
    </span>
  );
}

function entryActions(
  entry: ManifestEntry,
  plan: ArtifactViewPlan,
  attemptId: string,
  onSelect: (selection: Omit<ArtifactSelection, "nonce">) => void,
): ReactNode {
  if (isRestrictedRaw(entry))
    return (
      <span className="badge tone-neutral" data-testid="artifact-restricted">
        <Icon shape="lock" />
        <span>Restricted</span>
      </span>
    );
  const viewers = plan.viewers.filter(
    (viewer) => viewer !== "unavailable" && viewer !== "restricted",
  );
  if (viewers.length === 0) return <span className="truncated-note">{plan.reason}</span>;
  return (
    <span className="actions-inline">
      {viewers.map((viewer) => (
        <button
          key={viewer}
          type="button"
          className="button secondary"
          aria-label={`${viewerLabel[viewer]}: ${entry.relativePath}`}
          onClick={() => onSelect({ attemptId, artifactId: entry.artifactId, viewer })}
        >
          {viewerLabel[viewer]}
        </button>
      ))}
    </span>
  );
}

function AttemptArtifacts(props: {
  attempt: AttemptRecord;
  state: BundleState;
  stepIdsByPath: ReadonlyMap<string, readonly string[]>;
  onSelect: (selection: Omit<ArtifactSelection, "nonce">) => void;
}): ReactNode {
  const { attempt, state } = props;
  const headingId = useId();
  let body: ReactNode;
  if (state.status === "loading")
    body = (
      <ViewState
        kind="loading"
        title="Loading artifacts"
        message="Reading the evidence manifest."
      />
    );
  else if (state.status === "unavailable")
    body = <ViewState kind="empty" title="No evidence available" message={state.message} />;
  else if (state.status === "error")
    body = <ViewState kind="error" title="Evidence not loaded" message={state.message} />;
  else {
    const { manifest } = state;
    const columns: Column<ManifestEntry>[] = [
      {
        key: "path",
        header: "Artifact",
        render: (entry) => <UntrustedText value={entry.relativePath} maxLength={200} />,
      },
      { key: "kind", header: "Kind", render: (entry) => <code>{entry.kind}</code> },
      {
        key: "step",
        header: "Step",
        render: (entry) => {
          const steps = props.stepIdsByPath.get(entry.relativePath);
          return steps && steps.length > 0 ? (
            <UntrustedText value={steps.join(", ")} maxLength={200} />
          ) : (
            "Not linked to a step"
          );
        },
      },
      {
        key: "sha",
        header: "SHA-256",
        render: (entry) => (entry.sha256 ? <code>{entry.sha256}</code> : "—"),
      },
      { key: "size", header: "Size", render: (entry) => formatBytes(entry.sizeBytes) },
      { key: "access", header: "Access class", render: (entry) => describeAccessClass(entry) },
      {
        key: "integrity",
        header: "Integrity",
        render: (entry) => <IntegrityBadge entry={entry} />,
      },
      {
        key: "actions",
        header: "Open",
        render: (entry) =>
          entryActions(entry, selectArtifactViewer(entry), attempt.id, props.onSelect),
      },
    ];
    const warning = describeManifestCompleteness(manifest);
    const table =
      manifest.entries.length === 0 ? (
        <ViewState
          kind="empty"
          title="No artifacts"
          message="The sealed manifest lists no artifacts for this attempt."
        />
      ) : (
        <DataTable
          caption={`Artifacts of attempt ${attempt.number}`}
          columns={columns}
          rows={manifest.entries}
          rowKey={(entry) => entry.artifactId}
        />
      );
    body = (
      <>
        <dl className="context">
          <dt>Run</dt>
          <dd>
            <code>{manifest.runId}</code>
          </dd>
          <dt>Attempt</dt>
          <dd>
            {attempt.number} (<code>{manifest.attemptId}</code>)
          </dd>
          <dt>Revision</dt>
          <dd>
            <code>{manifest.revisionId}</code>
          </dd>
          <dt>Snapshot</dt>
          <dd>
            <code>{manifest.snapshotId}</code>
          </dd>
        </dl>
        {warning ? (
          <ViewState kind="partial" title="Partial evidence" message={warning}>
            {table}
          </ViewState>
        ) : (
          table
        )}
      </>
    );
  }
  return (
    <section aria-labelledby={headingId} data-testid={`attempt-artifacts-${attempt.number}`}>
      <h3 id={headingId}>Attempt {attempt.number} artifacts</h3>
      {body}
    </section>
  );
}

/** Artifact tables for every Attempt plus the single open viewer. */
export function ArtifactSection(props: {
  attempts: readonly AttemptRecord[];
  stepGroups: readonly StepGroup[];
  bundles: Readonly<Record<string, BundleState>>;
  selection: ArtifactSelection | null;
  onSelect: (selection: Omit<ArtifactSelection, "nonce">) => void;
  onClose: () => void;
}): ReactNode {
  if (props.attempts.length === 0)
    return (
      <ViewState
        kind="empty"
        title="No attempts yet"
        message="Artifacts appear once an attempt has started."
      />
    );
  const selected = props.selection;
  const selectedBundle = selected ? props.bundles[selected.attemptId] : undefined;
  const selectedEntry =
    selected && selectedBundle?.status === "ready"
      ? selectedBundle.manifest.entries.find((entry) => entry.artifactId === selected.artifactId)
      : undefined;
  const selectedAttempt = selected
    ? props.attempts.find((attempt) => attempt.id === selected.attemptId)
    : undefined;
  return (
    <>
      {props.attempts.map((attempt) => {
        const stepIdsByPath = new Map<string, string[]>();
        for (const group of props.stepGroups)
          if (group.attemptId === attempt.id)
            for (const row of group.rows)
              for (const path of row.evidencePaths)
                stepIdsByPath.set(path, [...(stepIdsByPath.get(path) ?? []), row.stepId]);
        return (
          <AttemptArtifacts
            key={attempt.id}
            attempt={attempt}
            state={props.bundles[attempt.id] ?? { status: "loading" }}
            stepIdsByPath={stepIdsByPath}
            onSelect={props.onSelect}
          />
        );
      })}
      {selected && selectedEntry ? (
        <ArtifactPanel
          key={selected.nonce}
          entry={selectedEntry}
          viewer={selected.viewer}
          attemptNumber={selectedAttempt?.number ?? null}
          fromAddress={selected.fromAddress === true}
          onClose={props.onClose}
        />
      ) : null}
    </>
  );
}

/**
 * A step's evidence references, resolved only against the bundle of the step's own Attempt: an
 * artifact of another attempt is never presented as this step's evidence.
 */
export function StepEvidence(props: {
  attemptId: string;
  paths: readonly string[];
  bundle: BundleState | undefined;
  onSelect: (selection: Omit<ArtifactSelection, "nonce">) => void;
}): ReactNode {
  if (props.paths.length === 0) return <span>None recorded</span>;
  return (
    <ul className="plain-list">
      {props.paths.map((path) => {
        const label = <UntrustedText value={path} maxLength={160} />;
        if (props.bundle === undefined || props.bundle.status === "loading")
          return <li key={path}>{label} (loading evidence)</li>;
        if (props.bundle.status !== "ready")
          return <li key={path}>{label} (no evidence bundle for this attempt)</li>;
        const entry = props.bundle.manifest.entries.find(
          (candidate) => candidate.relativePath === path,
        );
        if (!entry) return <li key={path}>{label} (not in this attempt's bundle)</li>;
        const plan = selectArtifactViewer(entry);
        const viewer = plan.viewers[0];
        if (!viewer || viewer === "restricted" || viewer === "unavailable")
          return (
            <li key={path}>
              {label} ({plan.reason})
            </li>
          );
        return (
          <li key={path}>
            <button
              type="button"
              className="link-button"
              onClick={() =>
                props.onSelect({ attemptId: props.attemptId, artifactId: entry.artifactId, viewer })
              }
            >
              Open {label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
