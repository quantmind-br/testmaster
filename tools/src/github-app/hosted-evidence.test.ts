import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  findHostedAppViolations,
  type HostedAppEvidence,
  loadHostedAppEvidence,
} from "./hosted-evidence.js";

const hosted = resolve("validation/results/m4-acceptance/hosted");

type Json = Record<string, unknown>;

/** Walks a retained record by key and index, so a control edits the raw GitHub or TestMaster JSON. */
function dig(value: unknown, ...path: (string | number)[]): Json {
  let current = value;
  for (const key of path) current = (current as Record<string | number, unknown>)[key];
  return current as Json;
}
function checkRun(checks: Json, name: string): Json {
  const runs = checks.check_runs as Json[];
  return runs.find((run) => run.name === name) as Json;
}
function replayOf(evidence: HostedAppEvidence, event: string): Json {
  const deliveries = evidence.redelivery.after.deliveries as Json[];
  return deliveries.find((entry) => entry.redelivery === true && entry.event === event) as Json;
}

const controls: [string, (copy: HostedAppEvidence) => void, string][] = [
  [
    "a fork pull request",
    (copy) => {
      dig(copy.pullRequest, "head", "repo").full_name = "someone-else/fork";
    },
    "the proof pull request is not a same-repository pull request",
  ],
  [
    "a check moved to another SHA",
    (copy) => {
      const shaB = String(copy.summary.shaB);
      checkRun(copy.checks.healthy, "TestMaster / result").head_sha = shaB;
    },
    "A: a check is bound to a SHA other than",
  ],
  [
    "a neutral required gate",
    (copy) => {
      checkRun(copy.checks.healthy, "TestMaster / required-gate").conclusion = "neutral";
    },
    "A: TestMaster / required-gate is neutral, expected success",
  ],
  [
    "a missing check on the cancelled commit",
    (copy) => {
      (copy.checks.cancelled.check_runs as Json[]).pop();
    },
    "B cancelled: the commit does not carry exactly the two TestMaster checks",
  ],
  [
    "a check written by another App",
    (copy) => {
      dig(checkRun(copy.checks.failing, "TestMaster / result"), "app").slug = "other-app";
    },
    "C: a check was not created by the proof App",
  ],
  [
    "an unverified deployment binding",
    (copy) => {
      const output = dig(checkRun(copy.checks.healthy, "TestMaster / result"), "output");
      output.summary = String(output.summary).replace(
        "Binding:** verified",
        "Binding:** unverified",
      );
    },
    "A: TestMaster / result does not report a verified deployment binding",
  ],
  [
    "a link outside the public origin",
    (copy) => {
      checkRun(copy.checks.healthy, "TestMaster / result").details_url =
        "https://evil.example/batches/bat_1";
    },
    "A: TestMaster / result does not link its batch under the public origin",
  ],
  [
    "a duplicated comment",
    (copy) => {
      copy.comments.afterRedelivery.push(structuredClone(copy.comments.afterRedelivery[0] as Json));
    },
    "comment after redelivery: expected exactly one TestMaster comment, found 2",
  ],
  [
    "a comment for another pull request",
    (copy) => {
      const comment = copy.comments.healthy[0] as Json;
      comment.body = String(comment.body).replace(/pr=\d+ -->/, "pr=99 -->");
    },
    "comment after A: the marker does not bind installation, repository and pull request",
  ],
  [
    "a comment re-created on redelivery",
    (copy) => {
      (copy.comments.afterRedelivery[0] as Json).id = "1";
    },
    "the TestMaster comment was re-created instead of edited in place",
  ],
  [
    "a redelivery answered as new work",
    (copy) => {
      replayOf(copy, "pull_request").status_code = 409;
    },
    "was not answered as a duplicate with HTTP 200",
  ],
  [
    "a redelivery that created a Run",
    (copy) => {
      copy.testmaster.redeliveryRuns.push({ id: "run_extra" });
    },
    "a redelivery created a Run or a pull record",
  ],
  [
    "a push that did not wait for its preview",
    (copy) => {
      const pull = copy.testmaster.waitingPulls.find((row) => row.headSha === copy.summary.shaB);
      (pull as Json).state = "running";
    },
    "B: TestMaster did not wait for a preview of its own commit",
  ],
  [
    "a superseded commit without its successor",
    (copy) => {
      const output = dig(checkRun(copy.checks.cancelled, "TestMaster / result"), "output");
      output.summary = "Superseded.";
    },
    "B: TestMaster / result does not say which commit superseded it",
  ],
  [
    "a passing verdict for the failing preview",
    (copy) => {
      const output = dig(checkRun(copy.checks.failing, "TestMaster / required-gate"), "output");
      output.summary = String(output.summary).replace("Gate:** failed", "Gate:** passed");
    },
    "C: TestMaster / required-gate does not report the failed gate for commit C",
  ],
  [
    "a late deployment that revived the superseded commit",
    (copy) => {
      copy.testmaster.lateRuns.push({ id: "run_revived" });
    },
    "a deployment for the superseded commit B created a Run or revived B",
  ],
  [
    "an unreplayed failed push",
    (copy) => {
      for (const entry of copy.failedPushReplay.summary.replayed as Json[]) entry.statusCode = 500;
    },
    "was not replayed successfully",
  ],
  [
    "an installation that stayed active after the uninstall",
    (copy) => {
      for (const row of copy.uninstall.installationsAfter) row.state = "active";
    },
    "TestMaster did not revoke the installation after installation.deleted",
  ],
  [
    "a refused installation deletion",
    (copy) => {
      copy.uninstall.deleteInstallation.status = 404;
    },
    "GitHub did not accept DELETE /app/installations/{id}",
  ],
  [
    "an App manifest with an always-delivered event",
    (copy) => {
      (copy.app.events as string[]).push("installation");
    },
    "always-delivered installation event",
  ],
  [
    "a leaked private key",
    (copy) => {
      copy.files.push({
        path: "01-app-and-installation/leak.json",
        text: "-----BEGIN RSA PRIVATE KEY-----\nMIIE",
      });
    },
    "contains a private key",
  ],
  [
    "a leaked installation token",
    (copy) => {
      copy.files.push({
        path: "x.json",
        text: `{"note":"ghs_${"a".repeat(36)}"}`,
      });
    },
    "contains a GitHub token",
  ],
  [
    "a non-empty webhook secret field",
    (copy) => {
      copy.files.push({ path: "y.json", text: '{"webhook_secret":"hunter2hunter2"}' });
    },
    "carries a non-empty secret-bearing field",
  ],
  [
    "another repository of the account",
    (copy) => {
      copy.files.push({
        path: "z.json",
        text: '{"url":"https://api.github.com/repos/quantmind-br/private-notes"}',
      });
    },
    "names a repository other than the proof repository",
  ],
];

it("M4-07 J12 the hosted GitHub App proof retains raw GitHub and TestMaster records that bind both checks, the comment and the revocation to the right commit", async () => {
  const evidence = await loadHostedAppEvidence(hosted);
  expect(findHostedAppViolations(evidence)).toEqual([]);
  expect(evidence.files.length).toBeGreaterThan(60);
});

it("M4-07 J12 tampering with any retained hosted GitHub App record makes the matching rule fail", async () => {
  const evidence = await loadHostedAppEvidence(hosted);
  expect(controls.length).toBeGreaterThanOrEqual(20);
  for (const [name, mutate, expected] of controls) {
    const copy = structuredClone(evidence);
    mutate(copy);
    const violations = findHostedAppViolations(copy);
    expect(
      violations.some((violation) => violation.includes(expected)),
      `${name}: expected a violation containing "${expected}", got ${JSON.stringify(violations)}`,
    ).toBe(true);
  }
});
