import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  action,
  controlledShop,
  eventually,
  executable,
  healthPlan,
  journey,
  literal,
  terminal,
  text,
} from "./harness.js";

it("SEC-021 revocation stops active Docker access and denies queued login before another target request", async () => {
  await journey("sec-021-active-queued-revocation", async (session) => {
    const target = await controlledShop();
    try {
      await session.init(target.url);
      const secret = await session.command(
        [
          "secret",
          "set",
          "login-token",
          "--from-env",
          "LOGIN_CANARY",
          "--allowed-origin",
          target.url,
        ],
        0,
        {
          LOGIN_CANARY: "tm-canary-revoke-never-public",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-testmaster-bus",
        },
      );
      const plan = executable("Revocable login", "http", [
        action("login", "request", {
          method: "GET",
          pathSegments: [literal("health")],
          headers: { "X-Api-Key": { secretRef: text(secret.id) } },
        }),
        {
          id: "healthy",
          description: "Expected authenticated response",
          kind: "assertion",
          operation: "assert",
          input: { responseStepId: "login" },
          expectation: { predicate: "statusIn", values: [200] },
        },
      ]);
      const test = await session.createTest(plan);
      const worker = await session.worker();
      target.hold();
      const first = await session.command(["test", "run", text(test.id)]);
      const firstId = text(first.runId);
      await session.observe(firstId, (run) => run.status === "running");
      await eventually(
        async () => target.hits(),
        (hits) => hits > 0,
      );
      const second = await session.command(["test", "run", text(test.id)]);
      const secondId = text(second.runId);
      const hits = target.hits();
      await session.command(["secret", "remove", text(secret.id)]);
      await session.observe(firstId, (run) => terminal[text(run.status)] === true);
      const denied = await session.observe(secondId, (run) => terminal[text(run.status)] === true);
      expect(denied.outcome).not.toBe("passed");
      expect(target.hits()).toBe(hits);
      const db = new DatabaseSync(join(session.dataDir, "testmaster.db"), { readOnly: true });
      try {
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM steps s JOIN attempts a ON a.id=s.attempt_id WHERE a.run_id=?",
            )
            .get(secondId)?.n,
        ).toBe(0);
      } finally {
        db.close();
      }
      target.release();
      worker.child.kill("SIGTERM");
      await worker.result;
      // Product environment alone cannot activate acceptance fault hooks.
      const ordinary = await session.createTest(healthPlan());
      const positive = await session.command(
        ["test", "run", text(ordinary.id), "--wait", "--timeout", "120"],
        0,
        { TESTMASTER_ACCEPTANCE_FAULTS: "1", TESTMASTER_ACCEPTANCE_BOUNDARY: "before-publication" },
      );
      expect(positive.run).toMatchObject({ outcome: "passed", gate: "passed" });
      session.oracles.push({
        check: "activeQueuedRevocationAndProductHookUnreachable",
        healthy: true,
        firstId,
        secondId,
        requestsDuringRevocation: 0,
        positiveControlRequests: target.hits() - hits,
      });
    } finally {
      target.release();
      await target.close();
    }
  });
}, 180_000);
