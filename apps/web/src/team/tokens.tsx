import { type FormEvent, type ReactNode, useId, useState } from "react";
import { ApiError, api } from "../api";
import type { Me } from "../api/session";
import { ConfirmDialog } from "../components/confirm-dialog";
import { type Column, DataTable } from "../components/data-table";
import { ErrorSummary, type FieldIssue, FormField } from "../components/form";
import { useAnnounce } from "../components/live-region";
import { StatusBadge } from "../components/status";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { usePaged } from "../hooks/use-resource";
import { DisabledAction, type PermissionKey, permissionRows } from "./permissions";

export interface TokenGrant {
  readonly resourceType: string;
  readonly actions: readonly string[];
  readonly projectIds: readonly string[];
  readonly environmentIds: readonly string[];
  readonly expiresAt: string | null;
  readonly grantedBy: string;
  readonly deny?: boolean;
}

export interface TokenView {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly principalId: string;
  readonly scopes: readonly string[];
  readonly grants: readonly TokenGrant[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

interface TokenCreated {
  readonly token: string;
  readonly metadata: TokenView;
}

interface Option {
  readonly id: string;
  readonly name: string;
}

const scopeChoices: readonly { scope: "R" | "W" | "X" | "A"; label: string; key: PermissionKey }[] =
  [
    { scope: "R", label: "R (read)", key: "read" },
    { scope: "W", label: "W (write)", key: "author" },
    { scope: "X", label: "X (execute)", key: "execute" },
    { scope: "A", label: "A (admin)", key: "admin" },
  ];

/** The permission the editor must hold to delegate each grant action. */
const actionPermission: Readonly<Record<string, PermissionKey>> = {
  read: "read",
  write: "author",
  execute: "execute",
  admin: "admin",
  approve: "approve",
  raw: "admin",
  export: "export",
  delete: "admin",
};
const grantActions = Object.keys(actionPermission);
const resourceTypes = ["*", "Run", "TestCase", "Artifact", "HealingProposal", "SecretReference"];

interface GrantDraft {
  readonly key: number;
  readonly resourceType: string;
  readonly actions: readonly string[];
  readonly projectIds: readonly string[];
  readonly environmentIds: readonly string[];
  readonly expires: string;
  readonly deny: boolean;
}

function describeFailure(error: unknown): string {
  if (!(error instanceof ApiError)) return "The request failed.";
  return `${error.message} · request ${error.requestId}`;
}

function toggled(values: readonly string[], value: string, on: boolean): string[] {
  const without = values.filter((candidate) => candidate !== value);
  return on ? [...without, value] : without;
}

function EnvironmentPicker({
  projectId,
  selected,
  onChange,
}: {
  projectId: string;
  selected: readonly string[];
  onChange: (ids: string[]) => void;
}): ReactNode {
  const environments = usePaged<Option>(`/projects/${projectId}/environments`, {}, 100);
  return (
    <FormField label="Environments" hint="Leave empty for every environment of the project.">
      {(control) => (
        <select
          {...control}
          multiple
          value={[...selected]}
          onChange={(event) =>
            onChange([...event.target.selectedOptions].map((option) => option.value))
          }
        >
          {environments.items.map((environment) => (
            <option key={environment.id} value={environment.id}>
              {environment.name}
            </option>
          ))}
        </select>
      )}
    </FormField>
  );
}

function GrantEditor({
  index,
  draft,
  projects,
  held,
  onChange,
  onRemove,
}: {
  index: number;
  draft: GrantDraft;
  projects: readonly Option[];
  held: Readonly<Record<PermissionKey, boolean>>;
  onChange: (next: GrantDraft) => void;
  onRemove: () => void;
}): ReactNode {
  const label = `Grant ${index + 1}`;
  const single = draft.projectIds.length === 1 ? draft.projectIds[0] : undefined;
  return (
    <fieldset>
      <legend>{label}</legend>
      <FormField label={`${label} resource type`}>
        {(control) => (
          <select
            {...control}
            value={draft.resourceType}
            onChange={(event) => onChange({ ...draft, resourceType: event.target.value })}
          >
            {resourceTypes.map((type) => (
              <option key={type} value={type}>
                {type === "*" ? "* (every resource)" : type}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <fieldset>
        <legend>{label} actions</legend>
        {grantActions.map((action) => {
          const permission = actionPermission[action] as PermissionKey;
          const allowed = draft.deny || held[permission];
          return (
            <p key={action}>
              <label>
                <input
                  type="checkbox"
                  id={action === grantActions[0] ? `grant-${index}` : undefined}
                  checked={draft.actions.includes(action)}
                  disabled={!allowed}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      actions: toggled(draft.actions, action, event.target.checked),
                    })
                  }
                />{" "}
                {action}
                {allowed ? "" : ` (not held: you lack the ${permission} permission)`}
              </label>
            </p>
          );
        })}
      </fieldset>
      <FormField
        label={`${label} projects`}
        hint="Leave empty for every project you may administer."
      >
        {(control) => (
          <select
            {...control}
            multiple
            value={[...draft.projectIds]}
            onChange={(event) =>
              onChange({
                ...draft,
                projectIds: [...event.target.selectedOptions].map((option) => option.value),
                environmentIds: [],
              })
            }
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        )}
      </FormField>
      {single ? (
        <EnvironmentPicker
          projectId={single}
          selected={draft.environmentIds}
          onChange={(ids) => onChange({ ...draft, environmentIds: ids })}
        />
      ) : (
        <p className="hint">Select exactly one project to restrict the grant to environments.</p>
      )}
      <FormField label={`${label} expires`} hint="Optional. It cannot outlive the token.">
        {(control) => (
          <input
            {...control}
            type="datetime-local"
            value={draft.expires}
            onChange={(event) => onChange({ ...draft, expires: event.target.value })}
          />
        )}
      </FormField>
      <p>
        <label>
          <input
            type="checkbox"
            checked={draft.deny}
            onChange={(event) => onChange({ ...draft, deny: event.target.checked, actions: [] })}
          />{" "}
          Deny: block these actions for this token even where its role allows them
        </label>
      </p>
      <button type="button" className="button secondary" onClick={onRemove}>
        Remove {label.toLowerCase()}
      </button>
    </fieldset>
  );
}

function CreateToken({
  me,
  onCreated,
}: {
  me: Me;
  onCreated: (created: TokenCreated) => void;
}): ReactNode {
  const projects = usePaged<Option>("/projects", {}, 100);
  const announce = useAnnounce();
  const held = Object.fromEntries(
    permissionRows(me, null).map((row) => [row.key, row.allowed]),
  ) as Record<PermissionKey, boolean>;
  const [name, setName] = useState("");
  const [days, setDays] = useState("30");
  const [scopes, setScopes] = useState<string[]>(["R"]);
  const [grants, setGrants] = useState<GrantDraft[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const nameId = useId();
  const daysId = useId();

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const found: FieldIssue[] = [];
    if (name.trim() === "") found.push({ fieldId: nameId, message: "Token name is required." });
    const lifetime = Number(days);
    if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > 366)
      found.push({ fieldId: daysId, message: "Lifetime must be 1 to 366 days." });
    const expiresAt = new Date(Date.now() + lifetime * 86_400_000).toISOString();
    const wire = grants.map((draft) => ({
      resourceType: draft.resourceType,
      actions: draft.actions,
      projectIds: draft.projectIds,
      environmentIds: draft.environmentIds,
      expiresAt: draft.expires === "" ? null : new Date(draft.expires).toISOString(),
      grantedBy: me.principal.id,
      ...(draft.deny ? { deny: true } : {}),
    }));
    for (const [position, grant] of wire.entries())
      if (grant.actions.length === 0)
        found.push({
          fieldId: `grant-${position}`,
          message: `Grant ${position + 1} needs at least one action.`,
        });
    setIssues(found);
    setAttempt((value) => value + 1);
    if (found.length > 0) return;
    setPending(true);
    setFailure(null);
    try {
      const created = await api<TokenCreated>("POST", "/tokens", {
        body: {
          name: name.trim(),
          scopes,
          expiresAt,
          ...(wire.length > 0 ? { grants: wire } : {}),
        },
      });
      announce(`Token ${name.trim()} created.`);
      setName("");
      setGrants([]);
      onCreated(created.data);
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate aria-labelledby="create-token">
      <h3 id="create-token">Create API token</h3>
      <ErrorSummary key={attempt} issues={issues} />
      {failure ? (
        <p role="alert" className="banner tone-danger">
          {failure}
        </p>
      ) : null}
      <FormField
        label="Name"
        required
        id={nameId}
        error={issues.find((issue) => issue.fieldId === nameId)?.message ?? null}
      >
        {(control) => (
          <input
            {...control}
            value={name}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </FormField>
      <FormField
        label="Lifetime in days"
        id={daysId}
        hint="At most 366 days."
        error={issues.find((issue) => issue.fieldId === daysId)?.message ?? null}
      >
        {(control) => (
          <input
            {...control}
            inputMode="numeric"
            value={days}
            onChange={(event) => setDays(event.target.value)}
          />
        )}
      </FormField>
      <fieldset>
        <legend>Scopes</legend>
        {scopeChoices.map((choice) => {
          const allowed = held[choice.key];
          return (
            <p key={choice.scope}>
              <label>
                <input
                  type="checkbox"
                  checked={scopes.includes(choice.scope)}
                  disabled={choice.scope === "R" || !allowed}
                  onChange={(event) =>
                    setScopes(toggled(scopes, choice.scope, event.target.checked))
                  }
                />{" "}
                {choice.label}
                {choice.scope === "R" ? " (always included)" : ""}
                {allowed ? "" : ` (not held: you lack the ${choice.key} permission)`}
              </label>
            </p>
          );
        })}
      </fieldset>
      <h4>Grants</h4>
      <p className="hint">
        A grant never exceeds what you hold yourself: actions you lack are disabled here, and the
        server refuses them anyway.
      </p>
      {grants.map((draft, index) => (
        <GrantEditor
          key={draft.key}
          index={index}
          draft={draft}
          projects={projects.items}
          held={held}
          onChange={(next) =>
            setGrants(grants.map((item) => (item.key === draft.key ? next : item)))
          }
          onRemove={() => setGrants(grants.filter((item) => item.key !== draft.key))}
        />
      ))}
      <p>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setGrants([
              ...grants,
              {
                key: nextKey,
                resourceType: "*",
                actions: [],
                projectIds: [],
                environmentIds: [],
                expires: "",
                deny: false,
              },
            ]);
            setNextKey(nextKey + 1);
          }}
        >
          Add grant
        </button>
      </p>
      <button type="submit" className="button" aria-busy={pending}>
        Create token
      </button>
    </form>
  );
}

function describeGrant(grant: TokenGrant): string {
  const scope =
    grant.projectIds.length === 0 ? "all projects" : `${grant.projectIds.length} project(s)`;
  return `${grant.deny ? "deny" : "allow"} ${grant.actions.join("+")} on ${grant.resourceType} (${scope})`;
}

export function TokensSection({ me }: { me: Me }): ReactNode {
  const tokens = usePaged<TokenView>("/tokens");
  const announce = useAnnounce();
  const [created, setCreated] = useState<TokenCreated | null>(null);
  const [revoking, setRevoking] = useState<TokenView | null>(null);

  const columns: Column<TokenView>[] = [
    {
      key: "name",
      header: "Name",
      render: (token) => <UntrustedText value={token.name} maxLength={120} />,
    },
    { key: "kind", header: "Kind", render: (token) => token.kind },
    { key: "scopes", header: "Scopes", render: (token) => token.scopes.join(" ") },
    {
      key: "grants",
      header: "Grants",
      render: (token) =>
        token.grants.length === 0 ? (
          "None"
        ) : (
          <ul>
            {token.grants.map((grant) => (
              <li key={`${token.id}-${describeGrant(grant)}-${grant.expiresAt}`}>
                {describeGrant(grant)}
              </li>
            ))}
          </ul>
        ),
    },
    { key: "expires", header: "Expires", render: (token) => token.expiresAt },
    {
      key: "state",
      header: "State",
      render: (token) =>
        token.revokedAt ? (
          <StatusBadge status="cancelled" label="Revoked" />
        ) : (
          <StatusBadge status="ready" label="Active" />
        ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (token) =>
        token.revokedAt ? (
          "—"
        ) : (
          <button
            type="button"
            className="button secondary"
            aria-label={`Revoke ${token.name}`}
            onClick={() => setRevoking(token)}
          >
            Revoke
          </button>
        ),
    },
  ];

  return (
    <section aria-labelledby="tokens">
      <h2 id="tokens">Tokens</h2>
      {created ? (
        <section role="status" className="banner tone-info" aria-label="New API token">
          <div>
            <p className="state-title">Token {created.metadata.name}</p>
            <p>Copy it now. It is stored hashed and cannot be shown again.</p>
            <p>
              <code data-testid="new-token">{created.token}</code>
            </p>
            <button type="button" className="button secondary" onClick={() => setCreated(null)}>
              I have stored it
            </button>
          </div>
        </section>
      ) : null}
      <StatusView
        status={tokens.status}
        error={tokens.error}
        onRetry={() => void tokens.reload()}
        empty={<ViewState kind="empty" title="No tokens" />}
      >
        <DataTable
          caption="API tokens"
          columns={columns}
          rows={tokens.items}
          rowKey={(token) => token.id}
          pager={{
            hasMore: tokens.hasMore,
            loading: tokens.loadingMore,
            onLoadMore: () => void tokens.loadMore(),
          }}
        />
      </StatusView>
      <CreateToken
        me={me}
        onCreated={(next) => {
          setCreated(next);
          void tokens.reload();
        }}
      />
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke token"
        description="Requests using this token fail immediately and open streams end."
        context={[
          { label: "Workspace", value: me.workspace.name },
          { label: "Token", value: revoking?.name ?? "" },
          { label: "Kind", value: revoking?.kind ?? "" },
        ]}
        confirmLabel="Revoke token"
        destructive
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return;
          await api("DELETE", `/tokens/${revoking.id}`);
          const name = revoking.name;
          setRevoking(null);
          announce(`Token ${name} revoked.`);
          await tokens.reload();
        }}
      />
    </section>
  );
}

export function TokensDenied({ me }: { me: Me }): ReactNode {
  return (
    <section aria-labelledby="tokens">
      <h2 id="tokens">Tokens</h2>
      <ViewState
        kind="forbidden"
        message={`Listing and creating API tokens needs the admin permission; the ${me.membership.role} role does not include it.`}
      />
      <DisabledAction
        label="Create API token"
        reason="Requires the admin permission. Ask an org_owner or org_admin."
      />
    </section>
  );
}
