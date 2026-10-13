import type { ReactNode } from "react";
import { SecretsPage } from "../features/secrets/secrets";
import { usePageTitle } from "../hooks/use-page-title";
import type { PortalRoute } from "./types";

function Secrets(): ReactNode {
  usePageTitle("Secrets");
  return <SecretsPage />;
}

export const routes: PortalRoute[] = [
  {
    path: "/secrets",
    title: "Secrets",
    element: <Secrets />,
    nav: { label: "Secrets", section: "Settings" },
  },
];
