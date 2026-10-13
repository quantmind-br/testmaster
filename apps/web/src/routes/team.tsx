import type { ReactNode } from "react";
import { useMe } from "../components/app-shell";
import { usePageTitle } from "../hooks/use-page-title";
import { AddMemberDenied, MembersSection } from "../team/members";
import { PermissionsPanel, RoleMatrix } from "../team/permissions";
import { TokensDenied, TokensSection } from "../team/tokens";
import type { PortalRoute } from "./types";

function TeamPage(): ReactNode {
  usePageTitle("Members and roles");
  const me = useMe();
  return (
    <>
      <h1>Members and roles</h1>
      <PermissionsPanel me={me} />
      {me.permissions.admin ? <MembersSection me={me} /> : <AddMemberDenied me={me} />}
      <RoleMatrix />
    </>
  );
}

function TokensPage(): ReactNode {
  usePageTitle("API tokens");
  const me = useMe();
  return (
    <>
      <h1>API tokens</h1>
      {me.permissions.admin ? <TokensSection me={me} /> : <TokensDenied me={me} />}
    </>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/team",
    title: "Members and roles",
    element: <TeamPage />,
    nav: { label: "Members and roles", section: "Administration" },
  },
  {
    path: "/team/tokens",
    title: "API tokens",
    element: <TokensPage />,
    nav: { label: "API tokens", section: "Administration" },
  },
];
