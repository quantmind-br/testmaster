import {
  AuthCheckpointsPage,
  AuthProfileCreatePage,
  AuthProfileDetailPage,
  AuthProfilesPage,
} from "../features/auth/auth-pages";
import type { PortalRoute } from "./types";

export const routes: PortalRoute[] = [
  {
    path: "/auth-profiles",
    title: "Authentication profiles",
    element: <AuthProfilesPage />,
    nav: { label: "Authentication", section: "Settings" },
  },
  {
    path: "/auth-profiles/new",
    title: "New authentication profile",
    element: <AuthProfileCreatePage />,
  },
  {
    path: "/auth-profiles/:profileId",
    title: "Authentication profile",
    element: <AuthProfileDetailPage />,
  },
  {
    path: "/auth-checkpoints",
    title: "Manual checkpoints",
    element: <AuthCheckpointsPage />,
    nav: { label: "Checkpoints", section: "Settings" },
  },
];
