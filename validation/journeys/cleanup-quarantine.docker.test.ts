import { Application } from "@testmaster/application";
import { type ExecutablePlan, validate } from "@testmaster/contracts";
import { startShop } from "@testmaster/reference-shop";
import { expect, it } from "vitest";
import { type DockerCommand, dockerCommand } from "../../packages/sandbox/src/index.js";
import { action, assertion, eventually, executable, journey, locator, text } from "./harness.js";

const sessionPlan = (): ExecutablePlan =>
  executable("Ephemeral browser session positive control", "playwright", [
    action("open", "navigate", { path: "/acceptance/browser-session" }),
    assertion("fresh", { locator: locator("session-state") }, "textEquals", "fresh"),
    action("reload", "navigate", { path: "/acceptance/browser-session" }),
    assertion(
      "cookie-positive-control",
      { locator: locator("session-state") },
      "textEquals",
      "reused",
    ),
  ]);

it("SEC-025: quarantines worker upon cleanup failure, persists incident and outbox, blocks dispatch across restart, denies unauthorized clear, safely clears, and proves fresh session", async () => {
  await journey("cleanup-quarantine-isolation", async (session) => {
    const shop = await startShop({ port: 0 });
    let failRm = false;
    let failedContainerName = "";

    const injectedDockerCommand: DockerCommand = async (args, timeoutMs) => {
      if (failRm && args[0] === "rm") {
        failedContainerName = args[args.length - 1] ?? "";
        return {
          code: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("Error response from daemon: simulated teardown failure"),
          droppedBytes: 0,
        };
      }
      return dockerCommand(args, timeoutMs);
    };

    let app: Application | undefined;
    try {
      const init = await session.init(shop.url);
      app = await Application.open({
        cwd: session.cwd,
        home: session.home,
        env: session.env,
        dockerCommand: injectedDockerCommand,
      });

      const test = app.tests.create({
        projectId: text(init.projectId),
        plan: sessionPlan(),
      });

      // 1. Admit first run with wait:true to execute through ephemeral worker; container cleanup teardown fails
      failRm = true;
      const firstRun = await app.runs.admit(
        {
          testId: test.id,
          environmentId: text(init.environmentId),
        },
        { wait: true },
      );
      await app.worker.run({ ephemeral: true, runIds: [firstRun.runId] });
      // 2. Business verdict is preserved separate from required cleanup failure/gate
      const run1 = app.runs.get(firstRun.runId);
      expect(run1.phase).toBe("completed");
      expect(run1.outcome).toBe("passed");
      expect(run1.status).toBe("passed");
      expect(run1.gate).toBe("failed");
      expect(run1.cleanupOutcome).toBe("failed");

      // 3. Durable incident and quarantine exist in operational_state and outbox
      const quarantineStatus = app.worker.quarantineStatus();
      expect(quarantineStatus.quarantined).toBe(true);
      expect(quarantineStatus.record).toMatchObject({
        reason: "container_cleanup_failed",
        containerName: failedContainerName,
        runId: firstRun.runId,
      });
      expect(quarantineStatus.incident).toMatchObject({
        status: "active",
        severity: "high",
        reason: "container_cleanup_failed",
      });

      const opRow = app.database.get(
        "SELECT value FROM operational_state WHERE key=?",
        `worker:quarantine:${app.context.workspaceId}`,
      );
      expect(opRow).toBeDefined();

      const incRow = app.database.get(
        "SELECT value FROM operational_state WHERE key=?",
        `incident:${quarantineStatus.record?.incidentId}`,
      );
      expect(incRow).toBeDefined();

      const outboxEvents = app.database.all(
        "SELECT type, data_json FROM outbox WHERE workspace_id=?",
        app.context.workspaceId,
      );
      expect(outboxEvents.some((row) => row.type === "worker.quarantined")).toBe(true);
      expect(outboxEvents.some((row) => row.type === "incident.created")).toBe(true);

      // 4. Start background worker; because worker is quarantined, it cannot claim queued runs
      const workerRun = app.worker.run();
      await eventually(async () => app?.worker.live(), Boolean);

      const secondRun = await app.runs.admit(
        {
          testId: test.id,
          environmentId: text(init.environmentId),
          extensions: {
            "testmaster:cleanupHook": "fail",
            "testmaster:injectedCleanupFailure": true,
          },
        },
        { wait: false },
      );
      expect(app.runs.get(secondRun.runId).phase).toBe("queued");

      // Cleanly drain and join background worker
      app.worker.drain();
      await workerRun;

      // Second attempt remains unclaimed
      expect(app.runs.get(secondRun.runId).phase).toBe("queued");

      // Simulate restart
      app.close();
      app = await Application.open({
        cwd: session.cwd,
        home: session.home,
        env: session.env,
        dockerCommand: injectedDockerCommand,
      });

      expect(app.worker.isQuarantined()).toBe(true);

      const restartedWorker = app.worker.run();
      await eventually(async () => app?.worker.live(), Boolean);

      // Second attempt still unclaimed across restart
      expect(app.runs.get(secondRun.runId).phase).toBe("queued");

      app.worker.drain();
      await restartedWorker;

      // 5. Unauthorized clear denied (with actual principal and scopes R/W, yielding FORBIDDEN)
      const unauthorizedApp = app.withIdentity({
        principalId: text(init.principalId),
        scopes: ["R", "W"],
      });
      await expect(unauthorizedApp.worker.clearQuarantine()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });

      const auditDenied = app.database.all(
        "SELECT action FROM audit_events WHERE workspace_id=? AND action LIKE '%quarantine.clear%'",
        app.context.workspaceId,
      );
      expect(auditDenied.some((event) => String(event.action).includes("denied"))).toBe(true);

      // 6. Refuse unsafe clear while leftover container remains
      await expect(app.worker.clearQuarantine()).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
      expect(app.worker.isQuarantined()).toBe(true);

      // 7. Authorized clear when safe removes leftover container and clears quarantine
      failRm = false;
      const clearResult = await app.worker.clearQuarantine();
      expect(clearResult.cleared).toBe(true);
      expect(clearResult.containerRemoved).toBe(true);
      expect(app.worker.isQuarantined()).toBe(false);

      expect(
        app.database.get(
          "SELECT value FROM operational_state WHERE key=?",
          `worker:quarantine:${app.context.workspaceId}`,
        ),
      ).toBeUndefined();

      const clearOutbox = app.database.all(
        "SELECT type FROM outbox WHERE workspace_id=? AND type='worker.quarantine_cleared'",
        app.context.workspaceId,
      );
      expect(clearOutbox.length).toBeGreaterThan(0);

      // 8. Now second run can be claimed: starts fresh session, verifies cookie positive control
      const finalWorker = app.worker.run();
      await eventually(async () => app?.runs.get(secondRun.runId).phase === "completed", Boolean);
      app.worker.drain();
      await finalWorker;

      const run2 = app.runs.get(secondRun.runId);
      expect(run2.phase).toBe("completed");
      expect(run2.outcome).toBe("passed");
      expect(run2.status).toBe("passed");
      expect(run2.gate).toBe("passed");
      session.runIds.push(firstRun.runId, secondRun.runId);
      session.oracles.push({
        check:
          "injected host cleanup failure quarantines durable slot; clear produces fresh session with same-attempt cookie positive control; admitted extension cannot activate hook",
        passed: true,
      });

      // 9. Prove hook impossible from wire via shared validators
      expect(() =>
        validate("RunRequest", {
          testId: test.id,
          environmentId: text(init.environmentId),
          dockerCommand: "fail",
        }),
      ).toThrow();

      expect(() =>
        validate("RunRequest", {
          testId: test.id,
          environmentId: text(init.environmentId),
          injectedCleanupFailure: true,
        }),
      ).toThrow();

      // ProjectConfig without hook is valid; with dockerCommand it is rejected
      expect(() =>
        validate("ProjectConfig", {
          schemaVersion: "1.0.0",
          project: { name: "test" },
        }),
      ).not.toThrow();
      expect(() =>
        validate("ProjectConfig", {
          schemaVersion: "1.0.0",
          project: { name: "test" },
          dockerCommand: "fail",
        }),
      ).toThrow();
    } finally {
      app?.close();
      await shop.close();
    }
  });
}, 300_000);
