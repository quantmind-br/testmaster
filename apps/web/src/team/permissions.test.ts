import { describe, expect, it } from "vitest";
import type { Me } from "../api/session";
import { type PermissionRow, permissionRows, type RbacMatrix } from "./permissions";

const columns = ["read", "write", "execute", "secret", "export", "admin"] as const;
const matrix: RbacMatrix = {
  roles: ["maintainer", "viewer", "service_account"],
  columns,
  values: ["allow", "deny", "grant-only"],
  matrix: {
    maintainer: {
      read: "allow",
      write: "allow",
      execute: "allow",
      secret: "allow",
      export: "allow",
      admin: "deny",
    },
    viewer: {
      read: "allow",
      write: "deny",
      execute: "deny",
      secret: "deny",
      export: "deny",
      admin: "deny",
    },
    service_account: {
      read: "grant-only",
      write: "grant-only",
      execute: "grant-only",
      secret: "grant-only",
      export: "grant-only",
      admin: "deny",
    },
  },
  rules: [],
};

function me(kind: "human" | "service", role: string, held: readonly string[]): Me {
  return {
    principal: { id: "prn_1", kind, displayName: "Caller" },
    workspace: { id: "ws_1", name: "Acme" },
    membership: { role, projectRestrictions: [] },
    permissions: {
      read: held.includes("read"),
      write: held.includes("write"),
      execute: held.includes("execute"),
      secret: held.includes("secret"),
      export: held.includes("export"),
      admin: held.includes("admin"),
    },
    csrfToken: null,
  };
}
const byKey = (rows: PermissionRow[], key: string) => rows.find((row) => row.key === key);

describe("permission rows", () => {
  it("UX-005 a human maintainer holds every permission but administration, and each missing one says why", () => {
    const rows = permissionRows(
      me("human", "maintainer", ["read", "write", "execute", "secret", "export"]),
      matrix,
    );
    expect(rows.filter((row) => row.allowed).map((row) => row.key)).toEqual([
      "read",
      "author",
      "approve",
      "execute",
      "secret",
      "export",
    ]);
    const admin = byKey(rows, "admin");
    expect(admin?.allowed).toBe(false);
    expect(admin?.reason).toBe("The maintainer role does not include administer.");
    expect(byKey(rows, "read")?.reason).toBe("");
  });

  it("UX-005 approval is human-only: a service principal that may write still cannot approve", () => {
    const human = permissionRows(me("human", "maintainer", ["read", "write"]), matrix);
    expect(byKey(human, "approve")?.allowed).toBe(true);
    const service = permissionRows(me("service", "service_account", ["read", "write"]), matrix);
    expect(byKey(service, "author")?.allowed).toBe(true);
    expect(byKey(service, "approve")?.allowed).toBe(false);
    expect(byKey(service, "approve")?.reason).toBe(
      "Approvals are decided by human principals only; service principals never approve.",
    );
  });

  it("UX-005 a grant-only role without a grant is told it needs an explicit grant, a viewer is told the role excludes it", () => {
    const service = permissionRows(me("service", "service_account", ["read"]), matrix);
    expect(byKey(service, "execute")?.reason).toBe(
      "The service_account role needs an explicit grant for execute.",
    );
    const viewer = permissionRows(me("human", "viewer", ["read"]), matrix);
    expect(byKey(viewer, "execute")?.reason).toBe(
      "The viewer role does not include execute. Roles that allow it: maintainer.",
    );
    expect(byKey(viewer, "read")?.allowed).toBe(true);
  });
});
