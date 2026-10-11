import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  type ForkIsolationEvidence,
  findForkIsolationViolations,
  findShaBindingViolations,
  loadForkIsolationEvidence,
  loadShaBindingEvidence,
  type ShaBindingEvidence,
} from "./hosted-evidence.js";

const hosted = resolve("validation/results/m3-acceptance/hosted/public");

function field(value: unknown, key: string): Record<string, unknown> {
  const child = (value as Record<string, unknown>)[key];
  return child as Record<string, unknown>;
}

it("HOSTED-FORK a cross-owner fork PR with its guard removed gets no secret, writable token, check or execution", async () => {
  const evidence = await loadForkIsolationEvidence(hosted);
  expect(findForkIsolationViolations(evidence)).toEqual([]);

  const controls: [string, (copy: ForkIsolationEvidence) => void, string][] = [
    [
      "same-owner head",
      (copy) => {
        field(field(copy.hostile.pull, "head"), "repo").owner = {
          login: field(field(field(copy.hostile.pull, "base"), "repo"), "owner").login,
        };
      },
      "hostile: head and base repositories share one owner",
    ],
    [
      "readable secret",
      (copy) => {
        copy.hostile.probeLog = copy.hostile.probeLog.replace(
          "canary-length=0",
          "canary-length=48",
        );
      },
      "hostile: a repository secret was readable from fork code",
    ],
    [
      "writable check API",
      (copy) => {
        copy.hostile.probeLog = copy.hostile.probeLog.replace(
          "probe write-check-run http=403",
          "probe write-check-run http=201",
        );
      },
      "hostile: write-check-run was not refused with HTTP 403",
    ],
    [
      "writable contents API",
      (copy) => {
        copy.hostile.probeLog = copy.hostile.probeLog.replace(
          "probe write-contents http=403",
          "probe write-contents http=200",
        );
      },
      "hostile: write-contents was not refused with HTTP 403",
    ],
    [
      "exposed OIDC endpoint",
      (copy) => {
        copy.hostile.probeLog = copy.hostile.probeLog.replace(
          /oidc-request-url=absent$/m,
          "oidc-request-url=present",
        );
      },
      "hostile: an OIDC token request endpoint was exposed to fork code",
    ],
    [
      "missing action refusal",
      (copy) => {
        copy.hostile.executeLog = copy.hostile.executeLog.replace(
          "POLICY_DENIED: Fork execution is denied before runtime installation",
          "completed",
        );
      },
      "hostile: the pinned Action did not refuse fork execution before runtime installation",
    ],
    [
      "publisher ran for fork code",
      (copy) => {
        const publish = (
          field(copy.hostile.execute.jobs, "jobs") as unknown as Record<string, unknown>[]
        ).find((job) => job.name === "publish");
        if (publish) publish.conclusion = "success";
      },
      "hostile: publisher job ran for fork code",
    ],
    [
      "unapproved fork run executed",
      (copy) => {
        copy.benign.run.runBeforeApproval.conclusion = "success";
      },
      "benign: run did not wait for approval before creating any job",
    ],
    [
      "benign fork job ran",
      (copy) => {
        const execute = (
          field(copy.benign.run.jobs, "jobs") as unknown as Record<string, unknown>[]
        ).find((job) => job.name === "execute");
        if (execute) execute.conclusion = "success";
      },
      "benign: execute job did not stay skipped for the fork",
    ],
    [
      "gate check on fork head",
      (copy) => {
        (copy.hostile.headCheckRuns.check_runs as unknown[]).push({
          name: "TestMaster / required-gate",
        });
      },
      "hostile: a TestMaster gate check exists on the fork head SHA",
    ],
    [
      "commit status on fork head",
      (copy) => {
        copy.benign.headStatus.total_count = 1;
      },
      "benign: a commit status exists on the fork head SHA",
    ],
    [
      "pull_request_target workflow",
      (copy) => {
        copy.baseWorkflows[0] = { name: "x.yml", text: "on:\n  pull_request_target: {}\n" };
      },
      "base workflows are missing or use pull_request_target",
    ],
    [
      "relaxed approval policy",
      (copy) => {
        copy.approvalPolicy.approval_policy = "first_time_contributors";
      },
      "fork pull request workflows do not require approval for all external contributors",
    ],
    [
      "moved base",
      (copy) => {
        field(copy.baseMainRef, "object").sha = "f".repeat(40);
      },
      "benign: base main moved while the fork controls ran",
    ],
  ];
  for (const [name, mutate, expected] of controls) {
    const copy = structuredClone(evidence);
    mutate(copy);
    expect(findForkIsolationViolations(copy), name).toContain(expected);
  }
});

it("HOSTED-BINDING a merge-ref pull request run keeps the assessed head and the checkout SHA distinct and binds checks to the head", async () => {
  const [healthy, defect] = await Promise.all(
    ["17-same-repo-pr-healthy-fixed-action", "18-same-repo-pr-defect-fixed-action"].map((run) =>
      loadShaBindingEvidence(resolve(hosted, run)),
    ),
  );
  if (!healthy || !defect) throw new Error("retained same-repository PR evidence is missing");
  expect(findShaBindingViolations(healthy)).toEqual([]);
  expect(findShaBindingViolations(defect)).toEqual([]);

  const base: ShaBindingEvidence = healthy;
  const controls: [string, (copy: ShaBindingEvidence) => void, string][] = [
    [
      "checkout collapsed onto head",
      (copy) => {
        field(copy.report, "provenance").checkoutSha = field(copy.report, "provenance").assessedSha;
      },
      "merge-ref run did not distinguish the assessed head from the checkout SHA",
    ],
    [
      "assessed migrated to the merge commit",
      (copy) => {
        field(copy.report, "provenance").assessedSha = field(copy.report, "provenance").checkoutSha;
      },
      "persisted assessed SHA is not the pull request head SHA",
    ],
    [
      "check migrated to another SHA",
      (copy) => {
        copy.publishedChecks[0] = { ...copy.publishedChecks[0], headSha: "e".repeat(40) };
      },
      "a published check is bound to a SHA other than the assessed head",
    ],
    [
      "unbound repository",
      (copy) => {
        field(copy.report, "provenance").binding = "unbound";
      },
      "repository binding is not verified",
    ],
    [
      "no published check",
      (copy) => {
        copy.publishedChecks = [];
      },
      "no TestMaster check was published for the run",
    ],
  ];
  for (const [name, mutate, expected] of controls) {
    const copy = structuredClone(base);
    mutate(copy);
    expect(findShaBindingViolations(copy), name).toContain(expected);
  }
});
