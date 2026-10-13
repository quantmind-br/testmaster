import { type ReactNode, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { type Column, DataTable } from "../components/data-table";
import { FormField } from "../components/form";
import { useSelectContext } from "../components/portal-context";
import { StatusBadge } from "../components/status";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { usePaged, useResource } from "../hooks/use-resource";
import { type Failure, toFailure } from "../lib/api-error";
import type {
  OnboardingState,
  ProjectRef,
  RevisionView,
  SourceHistory,
  SourceListItem,
} from "../lib/m4-types";
import {
  digestOf,
  formatBytes,
  mediaTypeFor,
  shortHash,
  sourceFormatFor,
  sourceRoleFor,
} from "../lib/onboarding";
import { NotFoundPage } from "./not-found";
import type { PortalRoute } from "./types";

interface Prepared {
  readonly name: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly digest: string;
  readonly mediaType: string;
  readonly role: string;
  readonly format: ReturnType<typeof sourceFormatFor>;
}

interface Existing {
  readonly id: string;
  readonly version: number;
  readonly role: string;
}

/**
 * Upload of one source: the file is hashed in the browser and its format, size, checksum and the
 * server's upload policy are shown before a single byte is sent.
 */
function SourceUploader({
  projectId,
  existing,
  onDone,
}: {
  projectId: string;
  existing?: Existing;
  onDone: () => Promise<void>;
}): ReactNode {
  const intake = useResource<OnboardingState>(
    `/projects/${encodeURIComponent(projectId)}/onboarding`,
  );
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [role, setRole] = useState(existing?.role ?? "");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const policy = intake.data?.intake;
  const blocked = policy ? !policy.uploadsAllowed || policy.offline : false;
  const prefix = existing ? "update" : "new";

  async function choose(file: File | undefined): Promise<void> {
    setPrepared(null);
    setProblem(null);
    setSent(null);
    if (!file) return;
    if (policy && file.size > policy.maxSourceBytes) {
      setProblem(
        `The file is ${formatBytes(file.size)}; the limit is ${formatBytes(policy.maxSourceBytes)}.`,
      );
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const chosenRole = existing?.role ?? (role || sourceRoleFor(file.name));
    setRole(chosenRole);
    setPrepared({
      name: file.name,
      bytes,
      digest: await digestOf(bytes),
      mediaType: mediaTypeFor(file.name),
      role: chosenRole,
      format: sourceFormatFor(file.name, chosenRole),
    });
  }

  async function send(): Promise<void> {
    if (!prepared || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const receipt = await api<{ uploadId: string; token?: string }>("POST", "/uploads", {
        body: {
          mediaType: prepared.mediaType,
          sizeBytes: prepared.bytes.byteLength,
          contentHash: prepared.digest,
        },
      });
      const token = receipt.data.token;
      if (!token) throw new Error("The server returned no upload token");
      const uploadId = encodeURIComponent(receipt.data.uploadId);
      await api("PUT", `/uploads/${uploadId}/bytes`, {
        bytes: prepared.bytes,
        headers: { "X-Upload-Token": token },
      });
      await api("POST", `/uploads/${uploadId}/complete`);
      await api("POST", `/projects/${encodeURIComponent(projectId)}/sources`, {
        ...(existing ? { ifMatch: existing.version } : {}),
        body: {
          role: role || prepared.role,
          name: prepared.name,
          uploadId: receipt.data.uploadId,
          ...(prepared.format ? { format: prepared.format } : {}),
          ...(existing ? { sourceId: existing.id } : {}),
        },
      });
      setSent(prepared.name);
      setPrepared(null);
      await onDone();
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label={existing ? "Upload a new revision" : "Add a source"}
      data-testid={`uploader-${prefix}`}
    >
      <h2>{existing ? "Upload a new revision" : "Add a source"}</h2>
      {policy ? (
        <p className="hint" data-testid="upload-policy">
          {blocked
            ? "Uploads are disabled by policy or because the server is offline. Import files from the repository with the CLI instead."
            : `Files up to ${formatBytes(policy.maxSourceBytes)}. Accepted formats: ${policy.formats.join(", ")}. Files named like credentials (.env, keys) are always refused.`}
        </p>
      ) : null}
      <FormField label="File" id={`${prefix}-source-file`}>
        {(props) => (
          <input
            {...props}
            type="file"
            disabled={blocked}
            onChange={(event) => void choose(event.target.files?.[0])}
          />
        )}
      </FormField>
      {existing ? null : (
        <FormField
          label="Role"
          id="new-source-role"
          hint="PRD, API specification or other documents."
        >
          {(props) => (
            <select {...props} value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="">Detect from the file name</option>
              <option value="prd">PRD / requirements</option>
              <option value="api-spec">API specification (OpenAPI, GraphQL, Postman)</option>
              <option value="doc">Other document</option>
            </select>
          )}
        </FormField>
      )}
      {problem ? <p className="error">{problem}</p> : null}
      {prepared ? (
        <dl className="context" data-testid="upload-preview">
          <dt>Name</dt>
          <dd>
            <UntrustedText value={prepared.name} maxLength={200} />
          </dd>
          <dt>Role</dt>
          <dd>{role || prepared.role}</dd>
          <dt>Format</dt>
          <dd>{prepared.format ?? "detected by the server"}</dd>
          <dt>Size</dt>
          <dd>{formatBytes(prepared.bytes.byteLength)}</dd>
          <dt>Checksum</dt>
          <dd>
            <code>{prepared.digest}</code>
          </dd>
        </dl>
      ) : null}
      {failure ? (
        <div className="banner tone-danger" role="alert" data-testid="upload-failure">
          <p>
            {failure.code}: {failure.message}
          </p>
        </div>
      ) : null}
      {sent ? (
        <p role="status" data-testid="upload-done">
          {existing ? "Revision added" : "Source added"}:{" "}
          <UntrustedText value={sent} maxLength={200} />
        </p>
      ) : null}
      <button
        type="button"
        className="button"
        aria-disabled={!prepared || busy || blocked}
        onClick={() => void send()}
      >
        {busy ? "Uploading…" : existing ? "Upload revision" : "Upload source"}
      </button>
    </section>
  );
}

const updateLabels: Record<string, string> = {
  unchanged: "Up to date",
  changed: "Changed at its origin",
  missing: "Origin file is missing",
  upload: "Uploaded",
};

function SourcesList(): ReactNode {
  const { projectId = "" } = useParams();
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const project = useResource<ProjectRef>(base);
  const sources = usePaged<SourceListItem>(`${base}/sources`);
  useSelectContext(project.data ? { id: project.data.id, name: project.data.name } : null);
  usePageTitle("Sources");
  if (project.status === "not-found") return <NotFoundPage />;
  const columns: Column<SourceListItem>[] = [
    {
      key: "name",
      header: "Source",
      render: (source) => (
        <Link to={`${base}/sources/${encodeURIComponent(source.id)}`}>
          <UntrustedText value={source.displayName} maxLength={120} />
        </Link>
      ),
    },
    { key: "role", header: "Role", render: (source) => source.role },
    {
      key: "revision",
      header: "Revision",
      render: (source) => (
        <>
          {source.overview.active.ordinal} of {source.overview.revisionCount}{" "}
          <StatusBadge status={source.overview.active.status} />
        </>
      ),
    },
    {
      key: "hash",
      header: "Hash",
      render: (source) => <code>{shortHash(source.overview.active.contentHash)}</code>,
    },
    {
      key: "imported",
      header: "Imported",
      render: (source) =>
        source.overview.active.importedAt ? (
          <time dateTime={source.overview.active.importedAt}>
            {source.overview.active.importedAt}
          </time>
        ) : (
          "—"
        ),
    },
    {
      key: "owner",
      header: "Owner",
      render: (source) => <code>{source.overview.ownerId ?? "—"}</code>,
    },
    {
      key: "update",
      header: "Update status",
      render: (source) => (
        <span data-origin-state={source.overview.origin.state}>
          {updateLabels[source.overview.origin.state] ?? source.overview.origin.state}
          {source.overview.dependents.staleTests > 0
            ? ` · ${source.overview.dependents.staleTests} test(s) may be stale`
            : ""}
        </span>
      ),
    },
  ];
  return (
    <>
      <h1>Sources</h1>
      <StatusView
        status={sources.status}
        error={sources.error}
        onRetry={() => void sources.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No sources yet"
            message="Add a PRD, an API specification or documents so TestMaster can understand the application."
          />
        }
      >
        <DataTable
          caption="Sources"
          columns={columns}
          rows={sources.items}
          rowKey={(source) => source.id}
          pager={{
            hasMore: sources.hasMore,
            loading: sources.loadingMore,
            onLoadMore: () => void sources.loadMore(),
          }}
        />
      </StatusView>
      <SourceUploader projectId={projectId} onDone={() => sources.reload()} />
    </>
  );
}

function OperationList({ label, items }: { label: string; items: readonly string[] }): ReactNode {
  if (items.length === 0) return null;
  return (
    <div data-change={label.toLowerCase()}>
      <h4>
        {label} ({items.length})
      </h4>
      <ul>
        {items.map((item) => (
          <li key={item}>
            <code>{item}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Revision({ revision, total }: { revision: RevisionView; total: number }): ReactNode {
  const changes = revision.changes;
  return (
    <li className="revision" data-revision={revision.ordinal}>
      <h3>
        Revision {revision.ordinal} of {total}{" "}
        {revision.active ? (
          <StatusBadge status="active" />
        ) : (
          <span className="badge">Superseded</span>
        )}{" "}
        <StatusBadge status={revision.status} />
      </h3>
      <dl className="context">
        <dt>Hash</dt>
        <dd>
          <code>{revision.contentHash}</code>
        </dd>
        <dt>Imported</dt>
        <dd>
          {revision.importedAt ? (
            <time dateTime={revision.importedAt}>{revision.importedAt}</time>
          ) : (
            "—"
          )}{" "}
          by <code>{revision.importedBy ?? "unknown"}</code>
        </dd>
        <dt>Type</dt>
        <dd>
          {revision.mediaType} · {formatBytes(revision.sizeBytes)} · parser {revision.parserVersion}
        </dd>
        <dt>Parsed</dt>
        <dd>
          {revision.chunkCount} parts
          {revision.operationCount !== null ? ` · ${revision.operationCount} operations` : ""}
          {revision.diagnosticCount > 0 ? ` · ${revision.diagnosticCount} diagnostic(s)` : ""}
        </dd>
      </dl>
      {changes ? (
        <div data-testid={`changes-${revision.ordinal}`}>
          <h4>Changes against the previous revision</h4>
          {changes.operations.added.length +
            changes.operations.removed.length +
            changes.operations.changed.length ===
          0 ? (
            <p>
              No API operation changed. {changes.chunksAdded} part(s) added, {changes.chunksRemoved}{" "}
              removed.
            </p>
          ) : (
            <>
              <OperationList label="Added" items={changes.operations.added} />
              <OperationList label="Removed" items={changes.operations.removed} />
              <OperationList label="Changed" items={changes.operations.changed} />
            </>
          )}
        </div>
      ) : (
        <p>First revision.</p>
      )}
      {revision.diagnostics.length > 0 ? (
        <ul aria-label={`Diagnostics of revision ${revision.ordinal}`}>
          {revision.diagnostics.map((item) => (
            <li key={`${item.code}-${item.message}`}>
              <code>{item.code}</code> <UntrustedText value={item.message} maxLength={300} />
            </li>
          ))}
        </ul>
      ) : null}
      {revision.chunks.length > 0 ? (
        <details>
          <summary>Parsed parts of revision {revision.ordinal}</summary>
          <ol>
            {revision.chunks.slice(0, 20).map((chunk) => (
              <li key={chunk.hash}>
                <code>{chunk.kind}</code>
                <UntrustedText value={chunk.text} maxLength={400} block />
              </li>
            ))}
          </ol>
          {revision.chunksTruncated || revision.chunks.length > 20 ? (
            <p>Showing the first 20 of {revision.chunkCount} parts.</p>
          ) : null}
        </details>
      ) : null}
    </li>
  );
}

function SourceDetail(): ReactNode {
  const { projectId = "", sourceId = "" } = useParams();
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const project = useResource<ProjectRef>(base);
  const history = useResource<SourceHistory>(`/sources/${encodeURIComponent(sourceId)}/revisions`);
  useSelectContext(project.data ? { id: project.data.id, name: project.data.name } : null);
  usePageTitle(history.data?.displayName ?? "Source");
  if (project.status === "not-found" || history.status === "not-found") return <NotFoundPage />;
  const data = history.data;
  return (
    <StatusView status={history.status} error={history.error} onRetry={() => void history.reload()}>
      {data ? (
        <>
          <h1>
            <UntrustedText value={data.displayName} maxLength={120} />
          </h1>
          <p>
            <Link to={`${base}/sources`}>Back to sources</Link>
          </p>
          <dl className="context">
            <dt>Role</dt>
            <dd>{data.role}</dd>
            <dt>Owner</dt>
            <dd>
              <code>{data.overview.ownerId ?? "—"}</code>
            </dd>
            <dt>Origin</dt>
            <dd data-testid="origin-state">
              {data.overview.origin.kind === "local-file"
                ? `Repository file ${data.overview.origin.path ?? ""}`
                : "Uploaded"}{" "}
              — {updateLabels[data.overview.origin.state] ?? data.overview.origin.state}
            </dd>
            <dt>Revisions</dt>
            <dd>{data.overview.revisionCount} kept; an update never deletes the previous one.</dd>
          </dl>
          <section aria-label="Exclusions">
            <h2>Exclusions</h2>
            <p>The intake always refuses these files:</p>
            <ul>
              {data.exclusions.policy.map((item) => (
                <li key={item}>
                  <code>{item}</code>
                </li>
              ))}
            </ul>
            {data.exclusions.discovery.length > 0 ? (
              <p>
                Code discovery also excludes: <code>{data.exclusions.discovery.join(", ")}</code>
              </p>
            ) : null}
            {data.exclusions.unsupported.length > 0 ? (
              <p>Recorded but not interpreted: {data.exclusions.unsupported.join(", ")}.</p>
            ) : null}
          </section>
          <section aria-label="Tests that may be stale" data-testid="stale-tests">
            <h2>Tests that may be stale</h2>
            {data.staleTests.length === 0 ? (
              <p>No active test is known to rest on something the latest revision changed.</p>
            ) : (
              <ul>
                {data.staleTests.map((item) => (
                  <li key={item.testId}>
                    <UntrustedText value={item.name} maxLength={120} /> —{" "}
                    {item.reasons.map((reason) => (
                      <code key={reason}>{reason}</code>
                    ))}
                  </li>
                ))}
              </ul>
            )}
            <p className="hint">
              This is a conservative hint, not a verdict: nothing is changed automatically.
            </p>
          </section>
          <section aria-label="Revisions">
            <h2>Revisions</h2>
            <ol className="revisions" reversed>
              {data.revisions.map((revision) => (
                <Revision key={revision.id} revision={revision} total={data.revisions.length} />
              ))}
            </ol>
          </section>
          {data.archivedAt ? null : (
            <SourceUploader
              projectId={projectId}
              existing={{ id: data.id, version: data.version, role: data.role }}
              onDone={() => history.reload()}
            />
          )}
        </>
      ) : null}
    </StatusView>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/projects/:projectId/sources",
    title: "Sources",
    element: <SourcesList />,
    projectNav: { label: "Sources", order: 20 },
  },
  { path: "/projects/:projectId/sources/:sourceId", title: "Source", element: <SourceDetail /> },
];
