import type { ReactNode } from "react";
import { DeliveriesPanel } from "../features/notifications/deliveries-panel";
import { DeliveryDetailPage } from "../features/notifications/delivery-detail";
import { IntegrationsPanel } from "../features/notifications/integrations-panel";
import { usePageTitle } from "../hooks/use-page-title";
import { usePaged } from "../hooks/use-resource";
import type { IntegrationDocument } from "../lib/notifications";
import type { ProjectSummary } from "./home";
import type { PortalRoute } from "./types";

function NotificationsPage(): ReactNode {
  usePageTitle("Notifications");
  const integrations = usePaged<IntegrationDocument>("/integrations");
  const projects = usePaged<ProjectSummary>("/projects", {}, 100);
  return (
    <>
      <h1>Notifications</h1>
      <IntegrationsPanel integrations={integrations} projects={projects.items} />
      <DeliveriesPanel integrations={integrations.items} />
    </>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/settings/notifications",
    title: "Notifications",
    element: <NotificationsPage />,
    nav: { label: "Notifications", section: "Admin" },
  },
  {
    path: "/settings/notifications/deliveries/:deliveryId",
    title: "Delivery",
    element: <DeliveryDetailPage />,
  },
];
