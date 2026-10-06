import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  action,
  assertion,
  controlledShop,
  executable,
  healthPlan,
  items,
  journey,
  locator,
  object,
  text,
} from "./harness.js";
import {
  assertNoTestSpriteRequests,
  assertOnlyTargetConnections,
  recordNetwork,
} from "./network-recorder.js";

it("NFR-002/UX-002/M1-08 real CLI replay tree connects only to the authorized shop without keys, telemetry overrides or offline flags", async () => {
  await journey("network-replay-boundary", async (session) => {
    const target = await controlledShop();
    try {
      for (const key of Object.keys(session.env)) {
        if (/TOKEN|SECRET|API_KEY/i.test(key)) delete session.env[key];
      }
      delete session.env.TESTMASTER_OFFLINE;
      delete session.env.TESTMASTER_NO_TELEMETRY;
      const recorder = await recordNetwork(session, "replay");
      const command = async (args: string[]) => {
        const result = await session.command(args);
        await recorder.checkpoint();
        return result;
      };
      await command(["init", "--mode", "local", "--base-url", target.url]);
      // The real default config is used, including default telemetry/provider settings.
      await command(["doctor"]);
      for (const [name, plan] of [
        ["http", healthPlan()],
        [
          "browser",
          executable("Browser login validation", "playwright", [
            action("login", "navigate", { path: "/login" }),
            assertion("password_visible", { locator: locator("password") }, "visible"),
            action("submit_empty", "click", {
              locator: { by: "role", role: "button", name: "Sign in", exact: true },
            }),
            assertion(
              "password_rejected",
              { locator: locator("password-error") },
              "textContains",
              "Password is required",
            ),
          ]),
        ],
      ] as const) {
        const path = await session.plan(plan, `${name}.json`);
        await command(["test", "lint", "--plan", path]);
        const test = await command(["test", "create", "--plan", path]);
        const result = await command(["test", "run", text(test.id), "--wait", "--timeout", "180"]);
        expect(object(result.run).outcome).toBe("passed");
        const runId = text(object(result.receipt).runId);
        const bundle = await command([
          "artifact",
          "get",
          runId,
          "--out",
          join(session.cwd, `${name}-evidence`),
        ]);
        const manifest = object(bundle.manifest);
        const egress = items(manifest.entries).find(
          (entry) => entry.relativePath === "logs/egress.ndjson",
        );
        expect(egress?.state).toBe("available");
        const log = await readFile(join(text(bundle.bundleDir), "logs/egress.ndjson"), "utf8");
        const decisions = log
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => object(JSON.parse(line)));
        expect(decisions.length).toBeGreaterThan(0);
        for (const decision of decisions) expect(decision.origin).toBe(target.url);
        const reportPath = join(session.cwd, `${name}-report.json`);
        await command(["report", "export", runId, "--format", "json", "--out", reportPath]);
        expect(JSON.parse(await readFile(reportPath, "utf8"))).toBeDefined();
        const rerun = await command(["test", "rerun", runId, "--wait", "--timeout", "180"]);
        expect(object(rerun.run).outcome).toBe("passed");
        session.oracles.push({
          check: "containerEgressOnlyAuthorizedTarget",
          healthy: true,
          runId,
          decisions,
        });
      }
      const { trace, events } = await recorder.all();
      const connections = assertOnlyTargetConnections(trace, target.url);
      expect(
        events.filter((event) => ["fetch", "undici", "tls", "dns"].includes(String(event.kind))),
      ).toEqual([]);
      assertNoTestSpriteRequests(events);
      const evidence = await recorder.save(trace, events);
      session.oracles.push({
        check: "replayControllerProcessTreeBoundary",
        healthy: true,
        targetConnections: connections,
        unauthorizedConnections: 0,
        analyticsUpdateModelTestSpriteRequests: 0,
        evidence,
        commands: session.commands.length,
      });
      expect(target.hits()).toBeGreaterThan(0);
    } finally {
      await target.close();
    }
  });
}, 600_000);
