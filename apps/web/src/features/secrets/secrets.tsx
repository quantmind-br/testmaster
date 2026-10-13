import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { api } from "../../api";
import type { Me } from "../../api/session";
import { useMe } from "../../components/app-shell";
import { ConfirmButton } from "../../components/confirm-action";
import type { Column } from "../../components/data-table";
import { ErrorBanner } from "../../components/error-banner";
import { ErrorSummary, type FieldIssue, FormField } from "../../components/form";
import { useAnnounce } from "../../components/live-region";
import { SearchableTable } from "../../components/searchable-table";
import { UntrustedText } from "../../components/untrusted-text";
import { StatusView, ViewState } from "../../components/view-state";
import { useApiAction } from "../../hooks/use-api-action";
import { usePaged } from "../../hooks/use-resource";

export interface SecretRef {
  readonly id: string;
  readonly locator: string;
  readonly provider: string;
  readonly secretVersion: number;
  readonly allowedOrigins: readonly string[];
  readonly revokedAt?: string | null;
}

interface SecretVersionRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly version: number;
  readonly event: "created" | "rotated" | "revoked";
  readonly actor: string;
  readonly requestId: string;
}

const eventText: Record<SecretVersionRecord["event"], string> = {
  created: "Created",
  rotated: "Rotated",
  revoked: "Revoked",
};

function parseOrigins(text: string): { origins: string[]; invalid: string | null } {
  const origins: string[] = [];
  for (const part of text.split(/[\s,]+/u).filter(Boolean)) {
    try {
      const url = new URL(part);
      if (url.protocol !== "https:" && url.protocol !== "http:") return { origins, invalid: part };
      origins.push(url.origin);
    } catch {
      return { origins, invalid: part };
    }
  }
  return { origins, invalid: null };
}

function CreateSecretForm({
  allowed,
  reason,
  onCreated,
}: {
  allowed: boolean;
  reason: string | null;
  onCreated: () => Promise<void>;
}): ReactNode {
  const formId = useId();
  const announce = useAnnounce();
  const action = useApiAction();
  const key = useRef<string | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [origins, setOrigins] = useState("");
  const [issues, setIssues] = useState<readonly FieldIssue[]>([]);
  const [summaryKey, setSummaryKey] = useState(0);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!allowed) return;
    const found: FieldIssue[] = [];
    const parsed = parseOrigins(origins);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(name.trim()))
      found.push({
        fieldId: `${formId}-name`,
        message:
          "Use 1 to 128 letters, digits, dots, dashes, colons or slashes, starting with a letter or digit.",
      });
    if (value === "")
      found.push({ fieldId: `${formId}-value`, message: "Enter the secret value." });
    if (parsed.invalid !== null)
      found.push({
        fieldId: `${formId}-origins`,
        message: `"${parsed.invalid.slice(0, 60)}" is not an http(s) origin. Use https://example.test.`,
      });
    setIssues(found);
    setSummaryKey((current) => current + 1);
    if (found.length > 0) return;
    key.current ??= crypto.randomUUID();
    const idempotencyKey = key.current;
    const done = await action.run(async () => {
      await api("POST", "/secrets", {
        body: { name: name.trim(), value, allowedOrigins: parsed.origins },
        idempotencyKey,
      });
      return true;
    });
    if (done) {
      key.current = null;
      setName("");
      setValue("");
      setOrigins("");
      announce("Secret stored. Its value is not shown again.");
      await onCreated();
    }
  }

  const issue = (suffix: string) =>
    issues.find((entry) => entry.fieldId === `${formId}-${suffix}`)?.message ?? null;
  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate aria-label="Add a secret">
      <h2>Add a secret</h2>
      <ErrorSummary key={summaryKey} issues={issues} />
      <ErrorBanner error={action.error} />
      <FormField
        id={`${formId}-name`}
        label="Name"
        required
        error={issue("name")}
        hint="Tests refer to the secret by this name."
      >
        {(control) => (
          <input
            {...control}
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </FormField>
      <FormField
        id={`${formId}-value`}
        label="Value"
        required
        error={issue("value")}
        hint="Write-only. It is encrypted and never shown again."
      >
        {(control) => (
          <input
            {...control}
            type="password"
            autoComplete="new-password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
      </FormField>
      <FormField
        id={`${formId}-origins`}
        label="Allowed origins"
        error={issue("origins")}
        hint="Space or comma separated. The secret is only released to runs that target these origins."
      >
        {(control) => (
          <input
            {...control}
            autoComplete="off"
            value={origins}
            onChange={(event) => setOrigins(event.target.value)}
          />
        )}
      </FormField>
      <button type="submit" className="button" aria-disabled={!allowed || action.pending}>
        {action.pending ? "Saving…" : "Store secret"}
      </button>
      {reason ? <p className="hint">{reason}</p> : null}
    </form>
  );
}

function RotatePanel({
  secret,
  me,
  reason,
  onDone,
  onClose,
}: {
  secret: SecretRef;
  me: Me;
  reason: string | null;
  onDone: () => Promise<void>;
  onClose: () => void;
}): ReactNode {
  const formId = useId();
  const [value, setValue] = useState("");
  const [issues, setIssues] = useState<readonly FieldIssue[]>([]);
  const [summaryKey, setSummaryKey] = useState(0);
  const [failure, setFailure] = useState<Parameters<typeof ErrorBanner>[0]["error"]>(null);
  return (
    <section aria-labelledby={`${formId}-title`} className="panel">
      <h3 id={`${formId}-title`}>
        Rotate <UntrustedText value={secret.locator} maxLength={80} />
      </h3>
      <p className="hint">
        Current version {secret.secretVersion}. The current value is not shown and cannot be read
        back.
      </p>
      <ErrorSummary key={summaryKey} issues={issues} />
      <ErrorBanner error={failure} />
      <FormField
        id={`${formId}-value`}
        label="New value"
        required
        hint="Rotation creates the next version; earlier versions stay in the history."
        error={issues[0]?.message ?? null}
      >
        {(control) => (
          <input
            {...control}
            type="password"
            autoComplete="new-password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
      </FormField>
      <div className="actions">
        <ConfirmButton
          label="Rotate secret"
          tone="primary"
          disabledReason={reason}
          beforeOpen={() => {
            const found =
              value === ""
                ? [{ fieldId: `${formId}-value`, message: "Enter the new secret value." }]
                : [];
            setIssues(found);
            setSummaryKey((current) => current + 1);
            return found.length === 0;
          }}
          dialog={{
            title: "Rotate this secret?",
            description: `Creates version ${secret.secretVersion + 1}. Runs that start after this use the new value.`,
            context: [
              { label: "Workspace", value: me.workspace.name },
              { label: "Secret", value: secret.locator },
            ],
            confirmLabel: "Rotate",
          }}
          onConfirm={async (idempotencyKey) => {
            setFailure(null);
            try {
              await api("POST", `/secrets/${encodeURIComponent(secret.id)}/rotate`, {
                body: { value },
                idempotencyKey,
              });
            } catch (error) {
              setFailure(error as typeof failure);
              throw error;
            }
            setValue("");
            await onDone();
          }}
          successMessage="Secret rotated. The new value is not shown."
        />
        <button type="button" className="button secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}

function HistoryPanel({ secret, onClose }: { secret: SecretRef; onClose: () => void }): ReactNode {
  const history = usePaged<SecretVersionRecord>(
    `/secrets/${encodeURIComponent(secret.id)}/history`,
  );
  const columns: Column<SecretVersionRecord>[] = [
    { key: "version", header: "Version", render: (item) => item.version },
    { key: "event", header: "Event", render: (item) => eventText[item.event] },
    {
      key: "createdAt",
      header: "When",
      render: (item) => <time dateTime={item.createdAt}>{item.createdAt}</time>,
    },
    {
      key: "actor",
      header: "By",
      render: (item) => <UntrustedText value={item.actor} maxLength={80} />,
    },
    { key: "request", header: "Request", render: (item) => <code>{item.requestId}</code> },
  ];
  return (
    <section aria-label={`History of ${secret.locator}`} className="panel">
      <h3>
        History of <UntrustedText value={secret.locator} maxLength={80} />
      </h3>
      <p className="hint">Values are never part of the history; only that a version was created.</p>
      <StatusView
        status={history.status}
        error={history.error}
        onRetry={() => void history.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No history"
            message="No version events are recorded for this secret."
          />
        }
      >
        <SearchableTable
          caption={`Versions of ${secret.locator}`}
          columns={columns}
          rows={history.items}
          rowKey={(item) => item.id}
          searchText={(item) => `${item.event} ${item.actor} ${item.version}`}
          empty={
            <ViewState kind="empty" title="No history" message="No version events are recorded." />
          }
          urlPrefix="h"
          pager={{
            hasMore: history.hasMore,
            loading: history.status === "loading",
            onLoadMore: () => void history.loadMore(),
          }}
        />
      </StatusView>
      <button type="button" className="button secondary" onClick={onClose}>
        Close history
      </button>
    </section>
  );
}

/** Secret references of the workspace. Values are write-only: no response carries one (UX-046). */
export function SecretsPage(): ReactNode {
  const me = useMe();
  const secrets = usePaged<SecretRef>("/secrets");
  const [panel, setPanel] = useState<{ kind: "rotate" | "history"; id: string } | null>(null);
  const reason = me.permissions.secret
    ? null
    : "Your role cannot manage secrets (secret access is required).";
  const selected = panel ? (secrets.items.find((item) => item.id === panel.id) ?? null) : null;

  const columns: Column<SecretRef>[] = [
    {
      key: "name",
      header: "Name",
      sortValue: (item) => item.locator.toLowerCase(),
      render: (item) => <UntrustedText value={item.locator} maxLength={120} />,
    },
    {
      key: "value",
      header: "Value",
      render: () => <span>Set, hidden</span>,
    },
    {
      key: "version",
      header: "Version",
      sortValue: (item) => item.secretVersion,
      render: (item) => item.secretVersion,
    },
    { key: "provider", header: "Stored in", render: (item) => item.provider },
    {
      key: "origins",
      header: "Allowed origins",
      render: (item) =>
        item.allowedOrigins.length > 0
          ? item.allowedOrigins.join(", ")
          : "Any origin the project targets",
    },
    {
      key: "state",
      header: "State",
      sortValue: (item) => (item.revokedAt ? 1 : 0),
      render: (item) => (item.revokedAt ? "Revoked" : "Active"),
    },
    {
      key: "actions",
      header: "Actions",
      render: (item) => (
        <span className="row-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => setPanel({ kind: "history", id: item.id })}
          >
            History<span className="visually-hidden"> of {item.locator}</span>
          </button>
          {item.revokedAt || reason ? null : (
            <>
              <button
                type="button"
                className="button secondary"
                onClick={() => setPanel({ kind: "rotate", id: item.id })}
              >
                Rotate<span className="visually-hidden"> {item.locator}</span>
              </button>
              <ConfirmButton
                label="Revoke"
                tone="danger"
                dialog={{
                  title: "Remove this secret reference?",
                  description:
                    "The reference is revoked. Tests that use it fail with an authentication failure until another secret takes its name. The stored value is not exported.",
                  context: [
                    { label: "Workspace", value: me.workspace.name },
                    { label: "Secret", value: item.locator },
                  ],
                  confirmLabel: "Revoke secret",
                  destructive: true,
                }}
                onConfirm={async (idempotencyKey) => {
                  await api("DELETE", `/secrets/${encodeURIComponent(item.id)}`, {
                    idempotencyKey,
                  });
                  await secrets.reload();
                }}
                successMessage="Secret revoked"
              />
            </>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <h1>Secrets</h1>
      <p className="hint">
        Secret values are write-only. This page shows that a value is set and which version is
        current; it never shows, prefills or exports a value.
      </p>
      <CreateSecretForm
        allowed={reason === null}
        reason={reason}
        onCreated={() => secrets.reload()}
      />
      <h2>Secret references</h2>
      <StatusView
        status={secrets.status}
        error={secrets.error}
        onRetry={() => void secrets.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No secrets"
            message="Add a secret above, then reference it from an environment or auth profile."
          />
        }
      >
        <SearchableTable
          caption="Secret references"
          columns={columns}
          rows={secrets.items}
          rowKey={(item) => item.id}
          searchText={(item) => `${item.locator} ${item.provider}`}
          filters={[
            {
              key: "state",
              label: "State",
              options: [
                { value: "active", label: "Active" },
                { value: "revoked", label: "Revoked" },
              ],
              match: (item, value) => (value === "revoked") === Boolean(item.revokedAt),
            },
          ]}
          empty={<ViewState kind="empty" title="No secrets" message="Add a secret above." />}
          pager={{
            hasMore: secrets.hasMore,
            loading: secrets.status === "loading",
            onLoadMore: () => void secrets.loadMore(),
          }}
        />
      </StatusView>
      {panel && selected ? (
        panel.kind === "rotate" ? (
          <RotatePanel
            key={selected.id}
            secret={selected}
            me={me}
            reason={reason}
            onDone={() => secrets.reload()}
            onClose={() => setPanel(null)}
          />
        ) : (
          <HistoryPanel key={selected.id} secret={selected} onClose={() => setPanel(null)} />
        )
      ) : null}
    </>
  );
}
