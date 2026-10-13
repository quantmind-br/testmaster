import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Validators for the raw GitHub and TestMaster records retained from the hosted GitHub App proof
 * (`validation/hosted/github-app-hosted.mjs`). They read the unmodified API payloads, never a
 * hand-written verdict, so editing or removing a retained record makes the matching rule report a
 * violation (M4-07, J12, INT-014/015/019/020/021/022, SEC-047).
 */

type Json = Record<string, unknown>;

export interface RetainedFile {
  path: string;
  text: string;
}

export interface HostedAppEvidence {
  summary: Json;
  app: Json;
  installationApi: Json[];
  tmInstallations: Json[];
  repositoryEnabled: Json;
  pullRequest: Json;
  deployments: { healthy: Json; failing: Json; late: Json };
  checks: {
    healthyQueued: Json;
    healthy: Json;
    healthyAfterRedelivery: Json;
    waiting: Json;
    healthyAfterPush: Json;
    cancelled: Json;
    healthyAfterSupersede: Json;
    failing: Json;
    cancelledAfterLate: Json;
    failingAfterLate: Json;
  };
  comments: { healthy: Json[]; afterRedelivery: Json[]; waiting: Json[]; failing: Json[] };
  testmaster: {
    healthyPulls: Json[];
    healthyRuns: Json[];
    redeliveryPulls: Json[];
    redeliveryRuns: Json[];
    waitingPulls: Json[];
    failingPulls: Json[];
    failingRuns: Json[];
    latePulls: Json[];
    lateRuns: Json[];
  };
  redelivery: { attempts: Json[]; before: Json; after: Json };
  failedPushReplay: { summary: Json; after: Json };
  uninstall: {
    deleteInstallation: Json;
    installationsBefore: Json[];
    installationsAfter: Json[];
    deliveries: Json;
    replayAfterUninstall: Json;
    deliveriesAfterReplay: Json;
    pullsAfter: Json[];
    runsAfter: Json[];
  };
  conflictReplay: Json;
  previewHits: Json[];
  files: RetainedFile[];
}

const checkNames = ["TestMaster / result", "TestMaster / required-gate"] as const;
const expectedPermissions = {
  checks: "write",
  contents: "read",
  deployments: "read",
  metadata: "read",
  pull_requests: "write",
};

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}
function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().join("|") === [...right].sort().join("|");
}
function samePermissions(actual: unknown, expected: Record<string, string>): boolean {
  const entries = (value: Record<string, unknown>) =>
    Object.entries(value).map(([key, level]) => `${key}=${level}`);
  return sameSet(entries(record(actual)), entries(expected));
}
const ids = (rows: Json[]): string[] => rows.map((row) => text(row.id));
const short = (sha: string): string => sha.slice(0, 12);

function checkRuns(checks: Json): Json[] {
  return list(checks.check_runs);
}
function verdictOf(checks: Json): Record<string, string> {
  return Object.fromEntries(
    checkRuns(checks).map((run) => [
      text(run.name),
      run.status === "completed" ? text(run.conclusion) : text(run.status),
    ]),
  );
}

/** The chain of identifiers the PR check links: batch and run IDs under the public origin. */
function linkedIds(summary: string, origin: string): { batch: string[]; runs: string[] } {
  const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    batch: [...summary.matchAll(new RegExp(`${escaped}/batches/(bat_[0-9a-f-]+)`, "g"))].map(
      (match) => match[1] ?? "",
    ),
    runs: [...summary.matchAll(new RegExp(`${escaped}/runs/(run_[0-9a-f-]+)`, "g"))].map(
      (match) => match[1] ?? "",
    ),
  };
}

const secretPatterns: [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["TestMaster token", /\btm_(?:api|op|local|wrk|rec)_[A-Za-z0-9_-]{20,}/],
];
const secretKeys =
  /"(?:private_key|pem|webhook_secret|client_secret|password|token)"\s*:\s*"([^"]*)"/g;

export function findHostedAppViolations(evidence: HostedAppEvidence): string[] {
  const violations: string[] = [];
  const fail = (message: string) => violations.push(message);
  const summary = evidence.summary;
  const repo = text(summary.repo);
  const appSlug = text(summary.appSlug);
  const installationId = text(summary.installationId);
  const serverOrigin = text(summary.serverOrigin);
  const previewOrigin = text(summary.previewOrigin);
  const [shaA, shaB, shaC] = [text(summary.shaA), text(summary.shaB), text(summary.shaC)];
  const prNumber = Number(summary.prNumber);
  const sha40 = /^[0-9a-f]{40}$/;
  if (![shaA, shaB, shaC].every((sha) => sha40.test(sha)) || new Set([shaA, shaB, shaC]).size !== 3)
    fail("the three proof commits are not three distinct full SHAs");
  if (!serverOrigin.startsWith("https://") || !previewOrigin.startsWith("https://"))
    fail("the public origins are not HTTPS");
  if (serverOrigin === previewOrigin) fail("the server and the preview share one origin");

  // -- The App, its installation and the repository binding came from GitHub, not from the harness.
  const app = evidence.app;
  if (text(app.slug) !== appSlug || !appSlug) fail("the GitHub App slug does not match the proof");
  if (!samePermissions(app.permissions, expectedPermissions))
    fail(
      "the App permissions differ from metadata/contents/deployments read and checks/pull_requests write",
    );
  const events = Array.isArray(app.events) ? app.events.map(String) : [];
  for (const event of ["pull_request", "deployment_status", "check_run", "push"])
    if (!events.includes(event)) fail(`the App is not subscribed to ${event}`);
  if (events.some((event) => event === "installation" || event === "installation_repositories"))
    fail("the App manifest subscribes to an always-delivered installation event GitHub rejects");
  const installation = evidence.installationApi.find(
    (entry) => String(entry.id) === installationId,
  );
  if (!installation || text(installation.app_slug) !== appSlug)
    fail("GitHub does not list the installation of this App");
  else if (!samePermissions(installation.permissions, expectedPermissions))
    fail("the installation permissions differ from the requested ones");
  const tmInstallation = evidence.tmInstallations.find(
    (entry) => text(entry.installationId) === installationId,
  );
  const tmRepository = list(tmInstallation?.repositories).find(
    (entry) => text(entry.fullName) === repo,
  );
  if (tmInstallation?.state !== "active" || !tmRepository)
    fail(
      "TestMaster did not learn the installation and the repository from the installation webhook",
    );
  const settings = record(evidence.repositoryEnabled.settings);
  if (
    settings.enabled !== true ||
    record(settings.preview).provider !== "github-deployments" ||
    settings.forkPolicy !== "deny"
  )
    fail(
      "the repository was not enabled with the github-deployments provider and the deny fork policy",
    );
  const repositoryId = text(evidence.repositoryEnabled.repositoryId);

  // -- The pull request is same-repository and its first head is commit A.
  const pull = evidence.pullRequest;
  const head = record(pull.head);
  const base = record(pull.base);
  if (text(head.sha) !== shaA || Number(pull.number) !== prNumber)
    fail("the retained pull request is not the one opened at commit A");
  if (text(record(head.repo).full_name) !== repo || text(record(base.repo).full_name) !== repo)
    fail("the proof pull request is not a same-repository pull request");

  // -- Checks: only the two TestMaster checks, each on its own SHA, created by this App.
  const checkSets: [string, Json, string][] = [
    ["A queued", evidence.checks.healthyQueued, shaA],
    ["A", evidence.checks.healthy, shaA],
    ["A after redelivery", evidence.checks.healthyAfterRedelivery, shaA],
    ["B waiting", evidence.checks.waiting, shaB],
    ["A after push B", evidence.checks.healthyAfterPush, shaA],
    ["B cancelled", evidence.checks.cancelled, shaB],
    ["A after supersede", evidence.checks.healthyAfterSupersede, shaA],
    ["C", evidence.checks.failing, shaC],
    ["B after late deployment", evidence.checks.cancelledAfterLate, shaB],
    ["C after late deployment", evidence.checks.failingAfterLate, shaC],
  ];
  for (const [label, checks, sha] of checkSets) {
    const runs = checkRuns(checks);
    if (
      !sameSet(
        runs.map((run) => text(run.name)),
        [...checkNames],
      )
    )
      fail(`${label}: the commit does not carry exactly the two TestMaster checks`);
    if (runs.some((run) => text(run.head_sha) !== sha))
      fail(`${label}: a check is bound to a SHA other than ${short(sha)}`);
    if (runs.some((run) => text(record(run.app).slug) !== appSlug))
      fail(`${label}: a check was not created by the proof App`);
  }
  const verdictIs = (label: string, checks: Json, expected: string) => {
    const verdict = verdictOf(checks);
    for (const name of checkNames)
      if (verdict[name] !== expected)
        fail(`${label}: ${name} is ${verdict[name]}, expected ${expected}`);
  };
  verdictIs("A queued", evidence.checks.healthyQueued, "queued");
  verdictIs("A", evidence.checks.healthy, "success");
  verdictIs("A after redelivery", evidence.checks.healthyAfterRedelivery, "success");
  verdictIs("B waiting", evidence.checks.waiting, "queued");
  verdictIs("A after push B", evidence.checks.healthyAfterPush, "success");
  verdictIs("B cancelled", evidence.checks.cancelled, "cancelled");
  verdictIs("A after supersede", evidence.checks.healthyAfterSupersede, "success");
  verdictIs("C", evidence.checks.failing, "failure");
  verdictIs("B after late deployment", evidence.checks.cancelledAfterLate, "cancelled");
  verdictIs("C after late deployment", evidence.checks.failingAfterLate, "failure");
  const allCheckIds = new Set<string>();
  for (const [, checks] of checkSets)
    for (const run of checkRuns(checks))
      if (text(run.head_sha) === shaB || text(run.head_sha) === shaC)
        allCheckIds.add(`${text(run.head_sha)}/${text(run.name)}/${text(run.id)}`);
  if (allCheckIds.size !== 4)
    fail("a check was re-created on another publication instead of being updated on its own SHA");

  // -- A: the green result carries the Run and batch IDs, the SHA binding and a link under the public origin.
  const greenRuns = checkRuns(evidence.checks.healthy);
  const batchOfA = text(
    evidence.testmaster.healthyPulls.find((row) => text(row.headSha) === shaA)?.batchId,
  );
  for (const run of greenRuns) {
    const output = record(run.output);
    const body = text(output.summary);
    const linked = linkedIds(body, serverOrigin);
    if (!body.includes(`**Commit:** \`${shaA}\``))
      fail(`A: ${text(run.name)} does not name the head commit`);
    if (!body.includes("**Binding:** verified (github-deployment)"))
      fail(`A: ${text(run.name)} does not report a verified deployment binding`);
    if (!body.includes(`**Preview:** \`${previewOrigin}\``))
      fail(`A: ${text(run.name)} does not name the preview origin`);
    if (
      !body.includes("**Gate:** passed") ||
      !body.includes("**First attempt:** passed 1, failed 0")
    )
      fail(`A: ${text(run.name)} does not report the measured gate and first attempt`);
    if (
      !batchOfA ||
      !linked.batch.includes(batchOfA) ||
      !text(run.details_url).startsWith(`${serverOrigin}/batches/${batchOfA}`)
    )
      fail(`A: ${text(run.name)} does not link its batch under the public origin`);
    const knownRuns = new Set(ids(evidence.testmaster.healthyRuns));
    if (!linked.runs.length || linked.runs.some((id) => !knownRuns.has(id)))
      fail(`A: ${text(run.name)} links a Run TestMaster does not know`);
  }
  const runOfA = evidence.testmaster.healthyRuns.find((row) => text(row.batchId) === batchOfA);
  if (
    !runOfA ||
    runOfA.origin !== "github" ||
    runOfA.outcome !== "passed" ||
    runOfA.phase !== "completed"
  )
    fail("A: the linked Run is not a completed passed GitHub-origin Run of the pull request batch");
  const deploymentA = record(evidence.deployments.healthy.deployment);
  const statusA = record(evidence.deployments.healthy.status);
  if (
    text(deploymentA.sha) !== shaA ||
    statusA.state !== "success" ||
    text(statusA.environment_url) !== previewOrigin
  )
    fail("A: the GitHub deployment is not a success of commit A pointing at the preview origin");
  const pullA = evidence.testmaster.healthyPulls.find((row) => text(row.headSha) === shaA);
  if (
    pullA?.state !== "completed" ||
    pullA.gate !== "passed" ||
    text(pullA.deploymentId) !== String(deploymentA.id) ||
    pullA.fork !== false
  )
    fail("A: TestMaster did not bind the verdict to the deployment GitHub reported for commit A");

  // -- The single PR comment.
  const marker = `<!-- testmaster:pr installation=${installationId} repo=${repositoryId} pr=${prNumber} -->`;
  const owned = (comments: Json[]) =>
    comments.filter((comment) => text(comment.body).startsWith("<!-- testmaster:pr "));
  for (const [label, comments] of [
    ["after A", evidence.comments.healthy],
    ["after redelivery", evidence.comments.afterRedelivery],
    ["after B", evidence.comments.waiting],
    ["after C", evidence.comments.failing],
  ] as const) {
    const mine = owned(comments);
    if (mine.length !== 1)
      fail(`comment ${label}: expected exactly one TestMaster comment, found ${mine.length}`);
    else {
      const comment = mine[0] as Json;
      if (!text(comment.body).startsWith(marker))
        fail(
          `comment ${label}: the marker does not bind installation, repository and pull request`,
        );
      if (text(record(comment.user).login) !== `${appSlug}[bot]`)
        fail(`comment ${label}: not written by the App`);
    }
  }
  const commentId = (comments: Json[]) => text(owned(comments)[0]?.id);
  if (
    new Set(
      [
        evidence.comments.healthy,
        evidence.comments.afterRedelivery,
        evidence.comments.waiting,
        evidence.comments.failing,
      ].map(commentId),
    ).size !== 1
  )
    fail("the TestMaster comment was re-created instead of edited in place");
  const finalComment = text(owned(evidence.comments.failing)[0]?.body);
  if (
    !finalComment.includes(short(shaC)) ||
    !finalComment.includes(short(shaB)) ||
    !/superseded by/.test(finalComment) ||
    !finalComment.includes(short(shaA))
  )
    fail("the final comment does not list commits C, B (superseded) and A");
  if (finalComment.includes("http://") || !finalComment.includes(`${serverOrigin}/runs/`))
    fail("the final comment does not link Runs under the HTTPS public origin");

  // -- Redelivery of the same deliveries creates nothing.
  const deliveriesBefore = list(evidence.redelivery.before.deliveries);
  const deliveriesAfter = list(evidence.redelivery.after.deliveries);
  const redeliverable = deliveriesBefore.filter(
    (entry) => entry.event === "pull_request" || entry.event === "deployment_status",
  );
  if (redeliverable.length < 2)
    fail("the redelivery step did not cover a pull_request and a deployment_status delivery");
  if (
    evidence.redelivery.attempts.length !== redeliverable.length ||
    evidence.redelivery.attempts.some((entry) => entry.status !== 202)
  )
    fail("GitHub did not accept a redelivery attempt for every original delivery");
  for (const original of redeliverable) {
    const replay = deliveriesAfter.find(
      (entry) => entry.redelivery === true && entry.guid === original.guid,
    );
    const answer = (() => {
      try {
        return record(JSON.parse(text(record(replay?.response).payload)).data);
      } catch {
        return {};
      }
    })();
    if (!replay || replay.status_code !== 200 || answer.duplicate !== true)
      fail(
        `redelivery of ${text(original.event)} ${text(original.guid)} was not answered as a duplicate with HTTP 200`,
      );
  }
  if (
    !sameSet(ids(evidence.testmaster.redeliveryRuns), ids(evidence.testmaster.healthyRuns)) ||
    !sameSet(ids(evidence.testmaster.redeliveryPulls), ids(evidence.testmaster.healthyPulls))
  )
    fail("a redelivery created a Run or a pull record");
  if (deliveriesAfter.some((entry) => entry.status_code === 409))
    fail("a redelivery was treated as tampering");

  // -- B waits for its own preview while A keeps its verdict.
  const pullB = evidence.testmaster.waitingPulls.find((row) => text(row.headSha) === shaB);
  if (pullB?.state !== "awaiting_preview" || pullB.deploymentId !== null || pullB.batchId !== null)
    fail("B: TestMaster did not wait for a preview of its own commit");
  if (
    evidence.testmaster.waitingPulls.find((row) => text(row.headSha) === shaA)?.state !==
    "completed"
  )
    fail("B: pushing a new commit changed the stored verdict of commit A");

  // -- C supersedes B: B's checks end cancelled on B, A is untouched.
  for (const run of checkRuns(evidence.checks.cancelled)) {
    const output = record(run.output);
    if (
      text(output.title) !== "Superseded by a newer commit" ||
      !text(output.summary).includes(short(shaC))
    )
      fail(`B: ${text(run.name)} does not say which commit superseded it`);
  }
  const supersededB = evidence.testmaster.failingPulls.find((row) => text(row.headSha) === shaB);
  if (
    supersededB?.state !== "superseded" ||
    supersededB.supersededBy !== shaC ||
    supersededB.batchId !== null
  )
    fail("B: TestMaster did not record B as superseded by C without admitting a batch");

  // -- C: a failing preview fails the result and the required gate and is measured, not assumed.
  for (const run of checkRuns(evidence.checks.failing)) {
    const body = text(record(run.output).summary);
    if (
      !body.includes("**Gate:** failed") ||
      !body.includes("**First attempt:** passed 0, failed 1") ||
      !body.includes(`**Commit:** \`${shaC}\``)
    )
      fail(`C: ${text(run.name)} does not report the failed gate for commit C`);
  }
  const pullC = evidence.testmaster.failingPulls.find((row) => text(row.headSha) === shaC);
  const deploymentC = record(evidence.deployments.failing.deployment);
  if (
    pullC?.state !== "completed" ||
    pullC.gate !== "failed" ||
    text(deploymentC.sha) !== shaC ||
    text(pullC.deploymentId) !== String(deploymentC.id)
  )
    fail("C: TestMaster did not bind the failed verdict to the deployment of commit C");
  const failedRuns = evidence.testmaster.failingRuns.filter(
    (row) => text(row.batchId) === text(pullC?.batchId),
  );
  if (
    failedRuns.length !== 1 ||
    failedRuns[0]?.outcome !== "failed" ||
    failedRuns[0]?.origin !== "github"
  )
    fail("C: the Run of the failing preview is not a failed GitHub-origin Run");
  const hitModes = evidence.previewHits.map((hit) => text(hit.mode));
  if (
    !hitModes.includes("ok") ||
    !hitModes.includes("fail") ||
    hitModes.lastIndexOf("fail") < hitModes.indexOf("ok")
  )
    fail("the preview app was not reached in both its healthy and its failing variant");

  // -- A deployment of the superseded SHA arrives late and creates nothing.
  if (
    text(record(evidence.deployments.late.deployment).sha) !== shaB ||
    record(evidence.deployments.late.status).state !== "success"
  )
    fail("the late deployment is not a success status for the superseded commit B");
  if (
    !sameSet(ids(evidence.testmaster.lateRuns), ids(evidence.testmaster.failingRuns)) ||
    evidence.testmaster.latePulls.find((row) => text(row.headSha) === shaB)?.state !== "superseded"
  )
    fail("a deployment for the superseded commit B created a Run or revived B");

  // -- GitHub recorded the defect-and-fix replays.
  const failedBefore = list(evidence.failedPushReplay.summary.failedBefore);
  const replayed = list(evidence.failedPushReplay.summary.replayed);
  if (
    !failedBefore.length ||
    failedBefore.some((entry) => entry.event !== "push" || entry.statusCode !== 500)
  )
    fail("the retained failed deliveries are not the push deliveries that answered HTTP 500");
  for (const entry of failedBefore)
    if (!replayed.some((replay) => replay.guid === entry.guid && replay.statusCode === 200))
      fail(`the failed push delivery ${text(entry.guid)} was not replayed successfully`);
  if (evidence.failedPushReplay.summary.runsBefore !== evidence.failedPushReplay.summary.runsAfter)
    fail("replaying the push deliveries created a Run");
  const conflictReplayed = list(evidence.conflictReplay.replayed);
  if (
    !list(evidence.conflictReplay.failedBefore).length ||
    !conflictReplayed.some((entry) => entry.statusCode === 200)
  )
    fail("the post-uninstall redelivery that answered 409 was not answered 200 after the fix");

  // -- Uninstall revokes the installation in TestMaster and later events create nothing.
  const uninstall = evidence.uninstall;
  if (uninstall.deleteInstallation.status !== 204)
    fail("GitHub did not accept DELETE /app/installations/{id}");
  if (
    uninstall.installationsBefore.find((row) => text(row.installationId) === installationId)
      ?.state !== "active"
  )
    fail("the installation was not active before the uninstall");
  const revoked = uninstall.installationsAfter.find(
    (row) => text(row.installationId) === installationId,
  );
  if (revoked?.state !== "revoked" || revoked.revokedReason !== "deleted")
    fail("TestMaster did not revoke the installation after installation.deleted");
  const deleted = list(record(uninstall.deliveries).deliveries).find(
    (entry) => entry.event === "installation" && entry.action === "deleted",
  );
  if (!deleted || deleted.status_code !== 200)
    fail("GitHub's installation.deleted delivery was not answered with HTTP 200");
  const replay = record(uninstall.replayAfterUninstall);
  if (
    replay.runsBefore !== replay.runsAfter ||
    replay.pullsBefore !== replay.pullsAfter ||
    !sameSet(ids(uninstall.runsAfter), ids(evidence.testmaster.failingRuns)) ||
    !sameSet(ids(uninstall.pullsAfter), ids(evidence.testmaster.latePulls))
  )
    fail("an event after the uninstall created a Run or a pull record");

  // -- Retained files hold no secret material and no other repository of the account.
  const [owner = "", allowed = ""] = repo.split("/");
  const otherRepository = new RegExp(
    `(?:(?:github\\.com|repos)/|(?:full_name|fullName)"\\s*:\\s*")${owner}/([A-Za-z0-9._-]+)`,
    "g",
  );
  for (const file of evidence.files) {
    for (const [label, pattern] of secretPatterns)
      if (pattern.test(file.text)) fail(`${file.path}: contains a ${label}`);
    for (const match of file.text.matchAll(secretKeys))
      if (match[1] && match[1] !== "[redacted]" && !/^\*+$/.test(match[1]))
        fail(`${file.path}: carries a non-empty secret-bearing field`);
    for (const match of file.text.matchAll(otherRepository))
      if ((match[1] ?? "").replace(/\.git$/, "") !== allowed) {
        fail(`${file.path}: names a repository other than the proof repository`);
        break;
      }
  }
  return violations;
}

async function json(path: string): Promise<Json> {
  return record(JSON.parse(await readFile(path, "utf8")));
}
async function jsonList(path: string): Promise<Json[]> {
  return list(JSON.parse(await readFile(path, "utf8")));
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
    ),
  );
  return files.flat().sort();
}

export async function loadHostedAppEvidence(root: string): Promise<HostedAppEvidence> {
  const at = (...parts: string[]) => join(root, ...parts);
  const paths = await walk(root);
  const files = await Promise.all(
    paths.map(async (path) => ({ path: relative(root, path), text: await readFile(path, "utf8") })),
  );
  const previewHitsText = await readFile(at("08-deliveries", "preview-hits.jsonl"), "utf8");
  return {
    summary: await json(at("02-pr-healthy", "summary.json")),
    app: await json(at("01-app-and-installation", "github-app.json")),
    installationApi: await jsonList(at("01-app-and-installation", "github-installations.json")),
    tmInstallations: await jsonList(at("01-app-and-installation", "testmaster-installations.json")),
    repositoryEnabled: await json(at("01-app-and-installation", "repository-enabled.json")),
    pullRequest: await json(at("02-pr-healthy", "pull.json")),
    deployments: {
      healthy: await json(at("02-pr-healthy", "deployment-A.json")),
      failing: await json(at("06-failing-preview", "deployment-C.json")),
      late: await json(at("07-late-deployment", "deployment-B-late.json")),
    },
    checks: {
      healthyQueued: await json(at("02-pr-healthy", "check-runs-A-queued.json")),
      healthy: await json(at("02-pr-healthy", "check-runs-A.json")),
      healthyAfterRedelivery: await json(at("03-redelivery", "check-runs-A-after.json")),
      waiting: await json(at("04-push-waits", "check-runs-B-waiting.json")),
      healthyAfterPush: await json(at("04-push-waits", "check-runs-A-after-push.json")),
      cancelled: await json(at("05-superseded", "check-runs-B-cancelled.json")),
      healthyAfterSupersede: await json(at("05-superseded", "check-runs-A.json")),
      failing: await json(at("06-failing-preview", "check-runs-C.json")),
      cancelledAfterLate: await json(
        at("07-late-deployment", "check-runs-B-after-late-deployment.json"),
      ),
      failingAfterLate: await json(
        at("07-late-deployment", "check-runs-C-after-late-deployment.json"),
      ),
    },
    comments: {
      healthy: await jsonList(at("02-pr-healthy", "comments-A.json")),
      afterRedelivery: await jsonList(at("03-redelivery", "comments-after.json")),
      waiting: await jsonList(at("04-push-waits", "comments.json")),
      failing: await jsonList(at("06-failing-preview", "comments-C.json")),
    },
    testmaster: {
      healthyPulls: await jsonList(at("02-pr-healthy", "A-testmaster-pulls.json")),
      healthyRuns: await jsonList(at("02-pr-healthy", "A-testmaster-runs.json")),
      redeliveryPulls: await jsonList(at("03-redelivery", "after-testmaster-pulls.json")),
      redeliveryRuns: await jsonList(at("03-redelivery", "after-testmaster-runs.json")),
      waitingPulls: await jsonList(at("04-push-waits", "B-waiting-testmaster-pulls.json")),
      failingPulls: await jsonList(at("06-failing-preview", "C-testmaster-pulls.json")),
      failingRuns: await jsonList(at("06-failing-preview", "C-testmaster-runs.json")),
      latePulls: await jsonList(at("07-late-deployment", "after-testmaster-pulls.json")),
      lateRuns: await jsonList(at("07-late-deployment", "after-testmaster-runs.json")),
    },
    redelivery: {
      attempts: await jsonList(at("03-redelivery", "redelivery-attempts.json")),
      before: await json(at("03-redelivery", "deliveries-before.json")),
      after: await json(at("03-redelivery", "deliveries-after.json")),
    },
    failedPushReplay: {
      summary: await json(at("10-failed-push-redelivery", "summary.json")),
      after: await json(at("10-failed-push-redelivery", "deliveries-after.json")),
    },
    uninstall: {
      deleteInstallation: await json(at("09-uninstall", "github-delete-installation.json")),
      installationsBefore: await jsonList(
        at("09-uninstall", "testmaster-installations-before.json"),
      ),
      installationsAfter: await jsonList(at("09-uninstall", "testmaster-installations-after.json")),
      deliveries: await json(at("09-uninstall", "github-deliveries.json")),
      replayAfterUninstall: await json(at("09-uninstall", "post-uninstall-redelivery.json")),
      deliveriesAfterReplay: await json(at("09-uninstall", "github-deliveries-after-replay.json")),
      pullsAfter: await jsonList(at("09-uninstall", "testmaster-pulls-after.json")),
      runsAfter: await jsonList(at("09-uninstall", "testmaster-runs-after.json")),
    },
    conflictReplay: await json(at("11-post-uninstall-replay", "summary.json")),
    previewHits: previewHitsText
      .split("\n")
      .filter(Boolean)
      .map((line) => record(JSON.parse(line))),
    files,
  };
}
