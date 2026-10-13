import "./authoring/authoring.css";
import { BatchPage } from "./authoring/batch-page";
import { ProposalsPage } from "./authoring/proposals-page";
import { TestPage } from "./authoring/test-page";
import { TestsPage } from "./authoring/tests-page";
import type { PortalRoute } from "./types";

export const routes: PortalRoute[] = [
  {
    path: "/projects/:projectId/proposals",
    title: "Proposals",
    element: <ProposalsPage />,
    projectNav: { label: "Proposals", order: 30 },
  },
  { path: "/proposal-batches/:batchId", title: "Proposal batch", element: <BatchPage /> },
  {
    path: "/projects/:projectId/tests",
    title: "Tests",
    element: <TestsPage />,
    projectNav: { label: "Tests", order: 40 },
  },
  { path: "/tests/:testId", title: "Test", element: <TestPage /> },
];
