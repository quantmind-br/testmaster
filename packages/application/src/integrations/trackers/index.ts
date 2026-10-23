import type { Controller } from "../../controllers.js";

export * from "./adapter.js";
export { adfToText, createJiraAdapter, createJiraProvider, trackerCapabilities } from "./jira.js";
export { createLinearAdapter, createLinearProvider, linearDefaultApiUrl } from "./linear.js";
export { buildTrackerAdapter, isTrackerProvider, registerTrackerProviders } from "./providers.js";
export {
  type IssueLinkListFilter,
  TrackersService,
  type TrackersServiceDeps,
} from "./service.js";

/** Records what the trackers say about executed issue links, per workspace, every 15 minutes. */
export const issueLinkSyncController: Controller = {
  name: "issue-link-sync",
  intervalMs: 15 * 60_000,
  elected: true,
  async run(scope, signal) {
    for (const workspaceId of scope.operator.workspaceIds()) {
      if (signal.aborted) return;
      await scope.systemScope(workspaceId).trackers.syncAll();
    }
  },
};
