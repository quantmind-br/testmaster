import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Application } from "../../application.js";
import { type GithubWorld, startGithubWorld } from "./testing/world.js";

// Backup and restore of the metadata database is a SQLite-file operation (PostgreSQL goes through
// pg_dump, proven by the operations slice), so this file is excluded from the PostgreSQL parity run.
const worlds: GithubWorld[] = [];
const extras: Application[] = [];
afterEach(async () => {
  for (const app of extras.splice(0)) await app.close();
  for (const world of worlds.splice(0)) await world.stop();
});
async function world(): Promise<GithubWorld> {
  const created = await startGithubWorld();
  worlds.push(created);
  return created;
}
const SHA_A = "a".repeat(40);
const SHA_B = "b1".repeat(20);

async function restoredFrom(w: GithubWorld, backup: string): Promise<Application> {
  const restoredDir = join(w.app.config.cwd, "restored");
  await w.app.backups.restore(backup, restoredDir);
  const restored = await Application.open({
    cwd: w.app.config.cwd,
    home: w.app.config.home,
    env: { TESTMASTER_DATA_DIR: restoredDir, TESTMASTER_EXECUTOR: "process" },
    github: {
      apiBaseUrl: w.fake.url,
      now: () => w.clock.t,
      sleep: () => Promise.resolve(),
      random: () => 0.5,
    },
  });
  extras.push(restored);
  return restored;
}

/**
 * A restore starts isolated and pauses every integration (OPS-025). The operator confirms the
 * review, lifts the isolation and re-enables the integration; only then may an event act again.
 */
function reviewedAndReenabled(restored: Application, integrationId: string): void {
  const scope = restored.controllerScope();
  scope.backups.review({
    apply: true,
    revocationsConfirmed: true,
    ledgerLossAccepted: true,
    incompleteEvidenceAccepted: true,
  });
  scope.operations.releaseIsolation("restore reviewed");
  const paused = scope.integrations.get(integrationId);
  expect(paused.state).toBe("paused");
  scope.integrations.update(integrationId, { state: "active" }, paused.version);
}

describe("OPS-037 revocation survives a restore from an older backup", () => {
  it("OPS-037 OPS-025 a revoked installation stays revoked after restoring a backup taken while it was active", async () => {
    const w = await world();
    await w.install();
    await w.openPr(7, SHA_A);
    expect(w.pull(SHA_A).state).toBe("awaiting_preview");
    const backup = join(w.app.config.cwd, "backup");
    await w.app.backups.create(backup);
    await w.send(
      "installation",
      w.fake.installationPayload("deleted", w.fake.installations.get(w.installationId) as never),
    );
    const revoked = w.app.database.get(
      "SELECT state FROM github_installations WHERE installation_id=?",
      String(w.installationId),
    );
    expect(revoked?.state).toBe("revoked");
    const restored = await restoredFrom(w, backup);
    // The backup still says "active", but the tombstone re-applied from the live state wins.
    const tombstone = restored.database.get(
      "SELECT value FROM operational_state WHERE key=?",
      `integration:revoked:github:${w.installationId}`,
    );
    expect(tombstone).toBeDefined();
    reviewedAndReenabled(restored, w.integration.id);
    const tokens = w.fake.requestsMatching("POST", /access_tokens$/u).length;
    const receipt = await restored.controllerScope().integrations.receiveWebhook(
      "github",
      w.fake.signedRequest(
        "pull_request",
        w.fake.pullRequestPayload({
          installationId: w.installationId,
          repository: w.repository,
          number: 7,
          headSha: SHA_B,
          action: "synchronize",
        }),
      ),
    );
    expect(receipt).toMatchObject({ outcome: "ignored", ignoredReason: "revoked_installation" });
    await restored.controllerScope().github.reconcile();
    expect(w.fake.requestsMatching("POST", /access_tokens$/u)).toHaveLength(tokens);
    expect(
      restored.database.get("SELECT COUNT(*) AS n FROM github_checks WHERE head_sha=?", SHA_B)?.n,
    ).toBe(0);
    expect(
      restored.database.get(
        "SELECT state FROM github_installations WHERE installation_id=?",
        String(w.installationId),
      )?.state,
    ).toBe("revoked");
  });

  it("OPS-037 a restored installation that was never revoked keeps working (the tombstone is not a blanket block)", async () => {
    const w = await world();
    await w.install();
    const backup = join(w.app.config.cwd, "backup");
    await w.app.backups.create(backup);
    const restored = await restoredFrom(w, backup);
    reviewedAndReenabled(restored, w.integration.id);
    const receipt = await restored.controllerScope().integrations.receiveWebhook(
      "github",
      w.fake.signedRequest(
        "pull_request",
        w.fake.pullRequestPayload({
          installationId: w.installationId,
          repository: w.repository,
          number: 9,
          headSha: SHA_B,
          action: "opened",
        }),
      ),
    );
    expect(receipt.outcome).toBe("accepted");
    expect(
      restored.database.get("SELECT COUNT(*) AS n FROM github_pulls WHERE head_sha=?", SHA_B)?.n,
    ).toBe(1);
  });
});
