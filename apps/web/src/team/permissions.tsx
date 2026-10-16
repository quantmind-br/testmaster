import { type ReactNode, useId } from "react";
import type { Me, PermissionArea } from "../api/session";
import { type Column, DataTable } from "../components/data-table";
import { StatusBadge } from "../components/status";
import { StatusView } from "../components/view-state";
import { useResource } from "../hooks/use-resource";

/** `GET /v1/rbac/matrix`: the role defaults the server authorizes with (ADR-017). */
export interface RbacMatrix {
  readonly roles: readonly string[];
  readonly columns: readonly PermissionArea[];
  readonly values: readonly string[];
  readonly matrix: Readonly<Record<string, Readonly<Record<PermissionArea, string>>>>;
  readonly rules: readonly string[];
}

export type PermissionKey =
  | "read"
  | "author"
  | "approve"
  | "execute"
  | "secret"
  | "export"
  | "admin";

export interface PermissionRow {
  readonly key: PermissionKey;
  readonly label: string;
  readonly description: string;
  readonly allowed: boolean;
  /** Why the permission is missing; empty when it is held. */
  readonly reason: string;
}

const definitions: readonly {
  key: PermissionKey;
  column: PermissionArea;
  label: string;
  description: string;
}[] = [
  {
    key: "read",
    column: "read",
    label: "Read",
    description: "View projects, tests, Runs and evidence.",
  },
  {
    key: "author",
    column: "write",
    label: "Author",
    description: "Create and edit tests, revisions and proposals.",
  },
  {
    key: "approve",
    column: "write",
    label: "Approve",
    description: "Decide executions, proposals and healing, as a person or as an agent.",
  },
  { key: "execute", column: "execute", label: "Execute", description: "Start and cancel Runs." },
  {
    key: "secret",
    column: "secret",
    label: "Manage secrets",
    description: "Write and rotate secret references. Values are never revealed by role.",
  },
  { key: "export", column: "export", label: "Export", description: "Download redacted exports." },
  {
    key: "admin",
    column: "admin",
    label: "Administer",
    description: "Manage members, API tokens, retention and the audit trail.",
  },
];

function rolesAllowing(matrix: RbacMatrix | null, column: PermissionArea): string {
  if (!matrix) return "";
  const names = matrix.roles.filter((role) => matrix.matrix[role]?.[column] === "allow");
  return names.length === 0 ? "" : ` Roles that allow it: ${names.join(", ")}.`;
}

/**
 * The permissions of the signed-in principal, with the reason for each one it lacks. The server
 * stays the only enforcement point; this explains the answer it would give.
 */
export function permissionRows(me: Me, matrix: RbacMatrix | null): PermissionRow[] {
  const role = me.membership.role;
  return definitions.map((definition) => {
    const allowed = me.permissions[definition.column];
    let reason = "";
    if (!allowed) {
      const value = matrix?.matrix[role]?.[definition.column];
      if (value === "grant-only")
        reason = `The ${role} role needs an explicit grant for ${definition.label.toLowerCase()}.`;
      else
        reason = `The ${role} role does not include ${definition.label.toLowerCase()}.${rolesAllowing(matrix, definition.column)}`;
    }
    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      allowed,
      reason,
    };
  });
}

/**
 * A control the signed-in principal may not use. It stays visible and focusable so the reason
 * is discoverable by keyboard and screen reader; activating it does nothing.
 */
export function DisabledAction({ label, reason }: { label: string; reason: string }): ReactNode {
  const reasonId = useId();
  return (
    <p>
      <button
        type="button"
        className="button secondary"
        aria-disabled="true"
        aria-describedby={reasonId}
        data-disabled-reason=""
      >
        {label}
      </button>{" "}
      <span id={reasonId}>{reason}</span>
    </p>
  );
}

const columns: Column<PermissionRow>[] = [
  { key: "permission", header: "Permission", render: (row) => <strong>{row.label}</strong> },
  { key: "description", header: "What it covers", render: (row) => row.description },
  {
    key: "state",
    header: "Your access",
    render: (row) =>
      row.allowed ? (
        <StatusBadge status="verified" label="Allowed" />
      ) : (
        <StatusBadge status="blocked" label="Not allowed" />
      ),
  },
  { key: "reason", header: "Why", render: (row) => (row.allowed ? "—" : row.reason) },
];

export function PermissionsPanel({ me }: { me: Me }): ReactNode {
  const matrix = useResource<RbacMatrix>("/rbac/matrix");
  const rows = permissionRows(me, matrix.data);
  return (
    <section aria-labelledby="your-permissions">
      <h2 id="your-permissions">Your permissions</h2>
      <p>
        You are signed in as <strong>{me.membership.role}</strong>. Each permission is enforced by
        the server on every request; a missing one is shown here with its reason instead of being
        hidden.
      </p>
      <DataTable
        caption="Your permissions"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.key}
      />
    </section>
  );
}

const matrixColumns: readonly PermissionArea[] = [
  "read",
  "write",
  "execute",
  "secret",
  "export",
  "admin",
];

const valueLabel: Record<string, { status: string; label: string }> = {
  allow: { status: "verified", label: "Allowed" },
  deny: { status: "blocked", label: "Denied" },
  "grant-only": { status: "pending", label: "Grant only" },
};

export function RoleMatrix(): ReactNode {
  const matrix = useResource<RbacMatrix>("/rbac/matrix");
  const data = matrix.data;
  const tableColumns: Column<string>[] = [
    { key: "role", header: "Role", render: (role) => <strong>{role}</strong> },
    ...matrixColumns.map(
      (column): Column<string> => ({
        key: column,
        header: column === "write" ? "write (author)" : column,
        render: (role) => {
          const value = data?.matrix[role]?.[column] ?? "deny";
          const entry = valueLabel[value] ?? { status: "unknown", label: value };
          return <StatusBadge status={entry.status} label={entry.label} />;
        },
      }),
    ),
  ];
  return (
    <section aria-labelledby="role-matrix">
      <h2 id="role-matrix">Role permissions</h2>
      <StatusView status={matrix.status} error={matrix.error} onRetry={() => void matrix.reload()}>
        <DataTable
          caption="Permissions granted by each role"
          columns={tableColumns}
          rows={data?.roles ?? []}
          rowKey={(role) => role}
        />
        <ul>
          {(data?.rules ?? []).map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </StatusView>
    </section>
  );
}
