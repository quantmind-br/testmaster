import type { Controller } from "../controllers.js";

/** Delivery loop: schedule new notifications from the outbox and send what is due, per workspace. */
export const notificationDispatchController: Controller = {
  name: "notifications",
  intervalMs: 2000,
  local: true,
  async run(scope, signal) {
    for (const workspaceId of scope.operator.workspaceIds()) {
      if (signal.aborted) return;
      await scope.systemScope(workspaceId).notifications.tick();
    }
  },
};

/** Removes finished notification deliveries once they are past retention. */
export const notificationRetentionController: Controller = {
  name: "notifications-retention",
  intervalMs: 3_600_000,
  local: true,
  elected: true,
  run(scope, signal) {
    for (const workspaceId of scope.operator.workspaceIds()) {
      if (signal.aborted) return;
      scope.systemScope(workspaceId).notifications.purge();
    }
  },
};

/** Marks workers whose heartbeat stopped as offline and announces the loss once (REQ-038). */
export const workerLivenessController: Controller = {
  name: "worker-liveness",
  intervalMs: 10_000,
  local: true,
  run(scope) {
    for (const workspaceId of scope.operator.workspaceIds())
      scope.systemScope(workspaceId).workerPool.sweepOffline();
  },
};

export const notificationControllers: readonly Controller[] = [
  notificationDispatchController,
  notificationRetentionController,
  workerLivenessController,
];
