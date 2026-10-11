import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Validators for raw GitHub API records retained from hosted Action acceptance runs. They read the
 * unmodified API payloads and workflow logs, never a hand-written summary, so removing or
 * tampering with a retained control makes the corresponding rule report a violation.
 */

type Json = Record<string, unknown>;

export interface ForkRunEvidence {
  runBeforeApproval: Json;
  jobsBeforeApproval: Json;
  run: Json;
  jobs: Json;
}

export interface ForkIsolationEvidence {
  baseMainRef: Json;
  approvalPolicy: Json;
  baseWorkflows: { name: string; text: string }[];
  benign: {
    pull: Json;
    run: ForkRunEvidence;
    headCheckRuns: Json;
    headStatus: Json;
  };
  hostile: {
    pull: Json;
    execute: ForkRunEvidence;
    probe: ForkRunEvidence;
    executeLog: string;
    probeLog: string;
    headCheckRuns: Json;
    headStatus: Json;
  };
}

export interface ShaBindingEvidence {
  event: string;
  headSha: string;
  report: Json;
  publishedChecks: Json[];
}

const WRITE_PROBES = [
  "write-check-run",
  "write-commit-status",
  "write-pr-comment",
  "write-contents",
  "write-ref",
] as const;

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function logLines(log: string): string[] {
  return log.split("\n").map((line) => {
    const message = line.split("\t").at(-1) ?? "";
    return message.replace(/^\uFEFF/, "").replace(/^\S+Z /, "");
  });
}

function probeCodes(log: string): Map<string, string> {
  const codes = new Map<string, string>();
  for (const line of logLines(log)) {
    const match = /^probe ([a-z-]+) http=(\d{3}|none)$/.exec(line.trim());
    if (match?.[1] && match[2]) codes.set(match[1], match[2]);
  }
  return codes;
}

function logValue(log: string, key: string): string | undefined {
  for (const line of logLines(log)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`) && !trimmed.includes(" "))
      return trimmed.slice(key.length + 1);
  }
  return undefined;
}

function jobNamed(jobs: Json, name: string): Json | undefined {
  return list(jobs.jobs).find((job) => job.name === name);
}

function checkRunNames(headCheckRuns: Json): string[] {
  return list(headCheckRuns.check_runs).map((check) => text(check.name));
}

export function findForkIsolationViolations(evidence: ForkIsolationEvidence): string[] {
  const violations: string[] = [];
  const fail = (message: string) => violations.push(message);
  const baseSha = text(record(evidence.baseMainRef.object).sha);

  for (const [label, pull] of [
    ["benign", evidence.benign.pull],
    ["hostile", evidence.hostile.pull],
  ] as const) {
    const head = record(pull.head);
    const headRepo = record(head.repo);
    const base = record(pull.base);
    const baseRepo = record(base.repo);
    if (!text(record(headRepo.owner).login) || !text(record(baseRepo.owner).login))
      fail(`${label}: pull request owners are unavailable`);
    else if (record(headRepo.owner).login === record(baseRepo.owner).login)
      fail(`${label}: head and base repositories share one owner`);
    if (headRepo.fork !== true || headRepo.id === baseRepo.id)
      fail(`${label}: head is not a distinct fork repository`);
    if (pull.merged !== false || pull.mergeable_state !== "blocked")
      fail(`${label}: fork pull request is not unmerged and blocked by the required gate`);
    if (!baseSha || text(base.sha) !== baseSha)
      fail(`${label}: base main moved while the fork controls ran`);
  }

  if (evidence.approvalPolicy.approval_policy !== "all_external_contributors")
    fail("fork pull request workflows do not require approval for all external contributors");

  const workflowText = evidence.baseWorkflows.map((workflow) => workflow.text).join("\n");
  if (!evidence.baseWorkflows.length || /pull_request_target/.test(workflowText))
    fail("base workflows are missing or use pull_request_target");
  const executeGuard = "head.repo.full_name == github.repository";
  if (!evidence.baseWorkflows.some((workflow) => workflow.text.includes(executeGuard)))
    fail("the generated workflow lacks its same-repository guard");

  for (const [label, run] of [
    ["benign", evidence.benign.run],
    ["hostile execute", evidence.hostile.execute],
    ["hostile probe", evidence.hostile.probe],
  ] as const) {
    const before = run.runBeforeApproval;
    if (
      before.event !== "pull_request" ||
      before.conclusion !== "action_required" ||
      record(before.head_repository).id !== record(run.run.head_repository).id ||
      record(run.run.head_repository).id === record(run.run.repository).id ||
      list(run.jobsBeforeApproval.jobs).length !== 0
    )
      fail(`${label}: run did not wait for approval before creating any job`);
  }

  const benign = evidence.benign.run.jobs;
  for (const name of ["execute", "publish"]) {
    const job = jobNamed(benign, name);
    if (job?.conclusion !== "skipped" || list(job.steps).length !== 0)
      fail(`benign: ${name} job did not stay skipped for the fork`);
  }

  const hostileExecute = jobNamed(evidence.hostile.execute.jobs, "execute");
  if (!hostileExecute || list(hostileExecute.steps).length === 0)
    fail("hostile: execute job never started, so the removed workflow guard was not exercised");
  if (hostileExecute?.conclusion !== "failure") fail("hostile: execute job did not fail closed");
  if (
    !logLines(evidence.hostile.executeLog).some(
      (line) =>
        line.trim() === "POLICY_DENIED: Fork execution is denied before runtime installation",
    )
  )
    fail("hostile: the pinned Action did not refuse fork execution before runtime installation");
  if (jobNamed(evidence.hostile.execute.jobs, "publish")?.conclusion !== "skipped")
    fail("hostile: publisher job ran for fork code");

  const probeLog = evidence.hostile.probeLog;
  if (logValue(probeLog, "canary-length") !== "0")
    fail("hostile: a repository secret was readable from fork code");
  if (logValue(probeLog, "oidc-request-url") !== "absent")
    fail("hostile: an OIDC token request endpoint was exposed to fork code");
  const codes = probeCodes(probeLog);
  if (codes.get("read-repo") !== "200") fail("hostile: read-only baseline probe did not succeed");
  for (const name of [...WRITE_PROBES, "list-secrets"])
    if (codes.get(name) !== "403") fail(`hostile: ${name} was not refused with HTTP 403`);

  for (const [label, checks, status] of [
    ["benign", evidence.benign.headCheckRuns, evidence.benign.headStatus],
    ["hostile", evidence.hostile.headCheckRuns, evidence.hostile.headStatus],
  ] as const) {
    if (checkRunNames(checks).some((name) => name.startsWith("TestMaster /")))
      fail(`${label}: a TestMaster gate check exists on the fork head SHA`);
    if (status.total_count !== 0 || status.state === "success")
      fail(`${label}: a commit status exists on the fork head SHA`);
  }
  return violations;
}

export function findShaBindingViolations(evidence: ShaBindingEvidence): string[] {
  const violations: string[] = [];
  const provenance = record(evidence.report.provenance);
  const assessed = text(provenance.assessedSha);
  const checkout = text(provenance.checkoutSha);
  if (evidence.event !== "pull_request") violations.push("run is not a pull_request merge-ref run");
  if (!/^[0-9a-f]{40}$/.test(assessed) || !/^[0-9a-f]{40}$/.test(checkout))
    violations.push("assessed and checkout SHAs must both be persisted as full SHAs");
  if (assessed === checkout)
    violations.push("merge-ref run did not distinguish the assessed head from the checkout SHA");
  if (assessed !== evidence.headSha)
    violations.push("persisted assessed SHA is not the pull request head SHA");
  if (provenance.binding !== "verified") violations.push("repository binding is not verified");
  const checks = evidence.publishedChecks.filter((check) =>
    text(check.name).startsWith("TestMaster /"),
  );
  if (!checks.length) violations.push("no TestMaster check was published for the run");
  if (checks.some((check) => check.headSha !== assessed))
    violations.push("a published check is bound to a SHA other than the assessed head");
  return violations;
}

async function json(path: string): Promise<Json> {
  return record(JSON.parse(await readFile(path, "utf8")));
}

export async function loadForkIsolationEvidence(root: string): Promise<ForkIsolationEvidence> {
  const benign = join(root, "22-fork-benign");
  const hostile = join(root, "23-fork-hostile");
  const run = async (
    dir: string,
    before: string,
    jobsBefore: string,
    now: string,
    jobs: string,
  ) => ({
    runBeforeApproval: await json(join(dir, before)),
    jobsBeforeApproval: await json(join(dir, jobsBefore)),
    run: await json(join(dir, now)),
    jobs: await json(join(dir, jobs)),
  });
  return {
    baseMainRef: await json(join(root, "base-main-ref-after-fork-controls.json")),
    approvalPolicy: await json(join(root, "fork-pr-contributor-approval.json")),
    baseWorkflows: await Promise.all(
      ["testmaster.yml", "acceptance-controls.yml"].map(async (name) => ({
        name,
        text: await readFile(join(root, `base-workflow-${name}`), "utf8"),
      })),
    ),
    benign: {
      pull: await json(join(benign, "pull.json")),
      run: await run(
        benign,
        "run-before-approval.json",
        "jobs-before-approval.json",
        "run.json",
        "jobs.json",
      ),
      headCheckRuns: await json(join(benign, "head-check-runs.json")),
      headStatus: await json(join(benign, "head-status.json")),
    },
    hostile: {
      pull: await json(join(hostile, "pull.json")),
      execute: await run(
        hostile,
        "run-before-approval-TestMaster.json",
        "jobs-before-approval-TestMaster.json",
        "run-testmaster.json",
        "jobs-testmaster.json",
      ),
      probe: await run(
        hostile,
        "run-before-approval-ForkProbe.json",
        "jobs-before-approval-ForkProbe.json",
        "run-probe.json",
        "jobs-probe.json",
      ),
      executeLog: await readFile(join(hostile, "log-testmaster.txt"), "utf8"),
      probeLog: await readFile(join(hostile, "log-probe.txt"), "utf8"),
      headCheckRuns: await json(join(hostile, "head-check-runs.json")),
      headStatus: await json(join(hostile, "head-status.json")),
    },
  };
}

export async function loadShaBindingEvidence(dir: string): Promise<ShaBindingEvidence> {
  const summary = await json(join(dir, "summary.json"));
  return {
    event: text(summary.event),
    headSha: text(summary.headSha),
    report: record(summary.report),
    publishedChecks: list(summary.publishedChecks),
  };
}
