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
import { DisabledAction } from "./permissions";

export const roleNames = [
  "org_owner",
  "org_admin",
  "maintainer",
  "runner",
  "reviewer",
  "viewer",
  "service_account",
] as const;

export interface Member {
  readonly id: string;
  readonly principalId: string;
  readonly login: string | null;
  readonly displayName: string;
  readonly role: string;
  readonly projectRestrictions: readonly string[];
  readonly disabledAt: string | null;
  readonly createdAt: string;
  readonly version: number;
}

interface ProjectOption {
  readonly id: string;
  readonly name: string;
}

interface MemberCreated {
  readonly member: Member;
  readonly recoveryToken: string | null;
  readonly recoveryExpiresAt: string | null;
}

function describeFailure(error: unknown): string {
  if (!(error instanceof ApiError)) return "The request failed.";
  const reason = typeof error.details.reason === "string" ? ` (${error.details.reason})` : "";
  return `${error.message}${reason} · request ${error.requestId}`;
}

function AddMember({
  workspaceId,
  onAdded,
}: {
  workspaceId: string;
  onAdded: (created: MemberCreated) => void;
}): ReactNode {
  const projects = usePaged<ProjectOption>("/projects", {}, 100);
  const announce = useAnnounce();
  const [login, setLogin] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<string>("viewer");
  const [restrictions, setRestrictions] = useState<string[]>([]);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const loginId = useId();
  const nameId = useId();

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const found: FieldIssue[] = [];
    if (!/^[a-z0-9][a-z0-9._@-]{2,63}$/.test(login))
      found.push({
        fieldId: loginId,
        message: "Login must be 3-64 characters: lowercase letters, digits and . _ @ -.",
      });
    if (displayName.trim() === "")
      found.push({ fieldId: nameId, message: "Display name is required." });
    setIssues(found);
    setAttempt((value) => value + 1);
    if (found.length > 0) return;
    setPending(true);
    setFailure(null);
    try {
      const created = await api<MemberCreated>("POST", `/workspaces/${workspaceId}/members`, {
        body: {
          login,
          displayName: displayName.trim(),
          role,
          projectRestrictions: restrictions,
        },
      });
      announce(`Member ${login} added.`);
      setLogin("");
      setDisplayName("");
      setRestrictions([]);
      onAdded(created.data);
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate aria-labelledby="add-member">
      <h3 id="add-member">Add member</h3>
      <ErrorSummary key={attempt} issues={issues} />
      {failure ? (
        <p role="alert" className="banner tone-danger">
          {failure}
        </p>
      ) : null}
      <FormField
        label="Login"
        required
        id={loginId}
        hint="Globally unique. The new member sets a password with the one-time recovery token."
        error={issues.find((issue) => issue.fieldId === loginId)?.message ?? null}
      >
        {(control) => (
          <input
            {...control}
            value={login}
            autoComplete="off"
            onChange={(event) => setLogin(event.target.value.toLowerCase())}
          />
        )}
      </FormField>
      <FormField
        label="Display name"
        required
        id={nameId}
        error={issues.find((issue) => issue.fieldId === nameId)?.message ?? null}
      >
        {(control) => (
          <input
            {...control}
            value={displayName}
            autoComplete="off"
            onChange={(event) => setDisplayName(event.target.value)}
          />
        )}
      </FormField>
      <FormField label="Role" required>
        {(control) => (
          <select {...control} value={role} onChange={(event) => setRole(event.target.value)}>
            {roleNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField
        label="Project restrictions"
        hint="Leave empty for every project. Select several with Ctrl or Shift."
      >
        {(control) => (
          <select
            {...control}
            multiple
            value={restrictions}
            onChange={(event) =>
              setRestrictions([...event.target.selectedOptions].map((option) => option.value))
            }
          >
            {projects.items.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <button type="submit" className="button" aria-busy={pending}>
        Add member
      </button>
    </form>
  );
}

function MemberRoleCell({
  member,
  workspaceId,
  isSelf,
  onSaved,
  onFailure,
}: {
  member: Member;
  workspaceId: string;
  isSelf: boolean;
  onSaved: (message: string) => void;
  onFailure: (message: string) => void;
}): ReactNode {
  const [role, setRole] = useState(member.role);
  const [pending, setPending] = useState(false);
  const reasonId = useId();
  const name = member.login ?? member.displayName;
  if (isSelf)
    return (
      <>
        <span>{member.role}</span>
        <p className="hint" id={reasonId}>
          Your own membership cannot be changed; ask another admin.
        </p>
      </>
    );
  async function save(): Promise<void> {
    if (pending || role === member.role) return;
    setPending(true);
    try {
      await api("PATCH", `/workspaces/${workspaceId}/members/${member.id}`, {
        body: { role },
        ifMatch: member.version,
      });
      onSaved(`Role of ${name} changed to ${role}.`);
    } catch (error) {
      setRole(member.role);
      onFailure(describeFailure(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <select
        aria-label={`Role of ${name}`}
        value={role}
        onChange={(event) => setRole(event.target.value)}
      >
        {roleNames.map((candidate) => (
          <option key={candidate} value={candidate}>
            {candidate}
          </option>
        ))}
      </select>{" "}
      <button
        type="button"
        className="button secondary"
        disabled={role === member.role || pending}
        aria-label={`Save role of ${name}`}
        onClick={() => void save()}
      >
        Save role
      </button>
    </>
  );
}

export function MembersSection({ me }: { me: Me }): ReactNode {
  const workspaceId = me.workspace.id;
  const members = usePaged<Member>(`/workspaces/${workspaceId}/members`);
  const announce = useAnnounce();
  const [recovery, setRecovery] = useState<MemberCreated | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);

  function saved(message: string): void {
    setFailure(null);
    announce(message);
    void members.reload();
  }

  const columns: Column<Member>[] = [
    {
      key: "login",
      header: "Login",
      render: (member) => <UntrustedText value={member.login} maxLength={64} />,
    },
    {
      key: "name",
      header: "Name",
      render: (member) => <UntrustedText value={member.displayName} maxLength={120} />,
    },
    {
      key: "role",
      header: "Role",
      render: (member) => (
        <MemberRoleCell
          key={`${member.id}-${member.version}`}
          member={member}
          workspaceId={workspaceId}
          isSelf={member.principalId === me.principal.id}
          onSaved={saved}
          onFailure={setFailure}
        />
      ),
    },
    {
      key: "projects",
      header: "Projects",
      render: (member) =>
        member.projectRestrictions.length === 0
          ? "All projects"
          : `${member.projectRestrictions.length} restricted`,
    },
    {
      key: "state",
      header: "State",
      render: (member) =>
        member.disabledAt ? (
          <StatusBadge status="paused" label="Disabled" />
        ) : (
          <StatusBadge status="ready" label="Active" />
        ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (member) =>
        member.principalId === me.principal.id ? (
          <span>This is you.</span>
        ) : (
          <button
            type="button"
            className="button secondary"
            aria-label={`Remove ${member.login ?? member.displayName}`}
            onClick={() => setRemoving(member)}
          >
            Remove
          </button>
        ),
    },
  ];

  return (
    <section aria-labelledby="members">
      <h2 id="members">Members</h2>
      {failure ? (
        <p role="alert" className="banner tone-danger">
          {failure}
        </p>
      ) : null}
      {recovery ? (
        <section role="status" className="banner tone-info" aria-label="One-time recovery token">
          <div>
            <p className="state-title">
              Recovery token for {recovery.member.login ?? recovery.member.displayName}
            </p>
            <p>
              Share this token once; it sets the first password and is not shown again. It expires
              at {recovery.recoveryExpiresAt ?? "—"}.
            </p>
            <p>
              <code data-testid="recovery-token">{recovery.recoveryToken}</code>
            </p>
            <button type="button" className="button secondary" onClick={() => setRecovery(null)}>
              I have shared it
            </button>
          </div>
        </section>
      ) : null}
      <StatusView
        status={members.status}
        error={members.error}
        onRetry={() => void members.reload()}
        empty={<ViewState kind="empty" title="No members" />}
      >
        <DataTable
          caption="Workspace members"
          columns={columns}
          rows={members.items}
          rowKey={(member) => member.id}
          pager={{
            hasMore: members.hasMore,
            loading: members.loadingMore,
            onLoadMore: () => void members.loadMore(),
          }}
        />
      </StatusView>
      <AddMember
        workspaceId={workspaceId}
        onAdded={(created) => {
          setRecovery(created);
          void members.reload();
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        title="Remove member"
        description="The member loses access to this workspace immediately. Their audit history stays."
        context={[
          { label: "Workspace", value: me.workspace.name },
          { label: "Member", value: removing?.login ?? removing?.displayName ?? "" },
          { label: "Role", value: removing?.role ?? "" },
        ]}
        confirmLabel="Remove member"
        destructive
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await api("DELETE", `/workspaces/${workspaceId}/members/${removing.id}`);
          const name = removing.login ?? removing.displayName;
          setRemoving(null);
          saved(`Member ${name} removed.`);
        }}
      />
    </section>
  );
}

export function AddMemberDenied({ me }: { me: Me }): ReactNode {
  return (
    <section aria-labelledby="members">
      <h2 id="members">Members</h2>
      <ViewState
        kind="forbidden"
        message={`Listing and changing members needs the admin permission; the ${me.membership.role} role does not include it.`}
      />
      <DisabledAction
        label="Add member"
        reason="Requires the admin permission. Ask an org_owner or org_admin."
      />
    </section>
  );
}
