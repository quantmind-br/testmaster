import { semanticHash } from "@testmaster/domain";
import type { CiResult } from "../../ci.js";
import { type CheckName, checkConclusion, checkNames } from "../../delivery.js";
import type { PullRecord } from "./store.js";

/** What a pull's checks must say right now; `conclusion: null` means the check is still open. */
export interface DesiredCheck {
  name: CheckName;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "action_required" | null;
  title: string;
  summary: string;
  detailsUrl: string | null;
}
/** Stored with a completed pull: the frozen CI verdict plus the Runs it covers. */
export interface StoredResult {
  ci: CiResult;
  runs: { id: string; outcome: string | null; gate: string }[];
  environmentName: string;
  selection: string;
  completedAt: string;
}

const zeroWidth = "\u200b";
/**
 * Neutralizes Markdown, HTML and @mentions in text that came from outside (PR data, repository names,
 * reason codes). The output is safe to place in a check summary or comment as plain text.
 */
export function mdEscape(input: string, max = 200): string {
  const flat = input
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters never belong in rendered text.
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/gu, " ")
    .trim()
    .slice(0, max);
  return flat
    .replace(/[\\`*_{}[\]()#+!|~<>&]/gu, (character) => `\\${character}`)
    .replace(/@/gu, `@${zeroWidth}`)
    .replace(/^([-.:])/u, "\\$1");
}
/** Inline code span that cannot be closed from inside. */
export function mdCode(input: string, max = 200): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters never belong in rendered text.
  const flat = input.replace(/[\u0000-\u001f\u007f\u2028\u2029`]+/gu, " ").trim().slice(0, max);
  return `\`${flat}\``;
}
const short = (sha: string): string => sha.slice(0, 12);
function link(origin: string | null, path: string, label: string): string {
  return origin ? `[${mdEscape(label)}](${origin}${path})` : mdCode(label);
}

const reasonText: Record<string, string> = {
  fork_policy_denied: "Pull requests from forks are not executed (fork policy: deny).",
  fixture_secret_refs: "A fork run may use only fixtures; the selected tests reference secrets.",
  fixture_environment_unsafe: "The fork fixture environment is not secret-free and isolated.",
  fixture_environment_missing: "The fork fixture environment is not configured.",
  preview_timeout: "The preview deployment did not become ready before the deadline.",
  preview_url_denied: "The preview URL is refused by the network policy.",
  admission_failed: "TestMaster could not admit the selected tests.",
  selection_empty: "The repository selection matched no executable test.",
  actor_revoked: "The integration owner is no longer allowed to run tests.",
  repository_removed: "The repository was removed from the installation.",
  installation_revoked: "The GitHub App installation was revoked.",
};
export const reasonSentence = (code: string | null): string =>
  mdEscape(reasonText[(code ?? "").split(":")[0] ?? ""] ?? code ?? "No further detail.", 300);

function resultSummary(pull: PullRecord, stored: StoredResult, origin: string | null): string {
  const { ci } = stored;
  const counts = ci.counts;
  const lines = [
    `**Gate:** ${mdEscape(ci.gate)}`,
    `**Commit:** ${mdCode(ci.provenance.assessedSha ?? pull.headSha)}${
      ci.provenance.checkoutSha && ci.provenance.checkoutSha !== ci.provenance.assessedSha
        ? ` (checkout ${mdCode(short(ci.provenance.checkoutSha))})`
        : ""
    }`,
    `**Binding:** ${mdEscape(ci.provenance.binding)} (${mdEscape(ci.provenance.targetBinding)})`,
    ...(pull.previewUrl ? [`**Preview:** ${mdCode(pull.previewUrl, 300)}`] : []),
    `**Environment:** ${mdCode(stored.environmentName)}`,
    `**Selection:** ${mdEscape(stored.selection)}; requested ${ci.selection.requested}, excluded ${ci.selection.excluded.length}`,
    ...ci.selection.excluded
      .slice(0, 10)
      .map((item) => `- excluded ${mdCode(item.testId)}: ${mdEscape(item.reason)}`),
    `**First attempt:** passed ${counts?.passed ?? 0}, failed ${counts?.failed ?? 0}, blocked ${counts?.blocked ?? 0}, cancelled ${counts?.cancelled ?? 0}, inconclusive ${counts?.inconclusive ?? 0}`,
    `**Freshness:** completed ${mdEscape(stored.completedAt)}; report ${mdCode(ci.reportHash ?? "none", 64)}`,
    ...(ci.batchId ? [`**Batch:** ${link(origin, `/batches/${ci.batchId}`, ci.batchId)}`] : []),
    ...stored.runs
      .slice(0, 20)
      .map(
        (run) =>
          `- ${link(origin, `/runs/${run.id}`, run.id)}: ${mdEscape(run.outcome ?? "no outcome")}`,
      ),
    ...(origin ? ["Sign in to the portal to open the evidence."] : []),
  ];
  return lines.join("\n");
}

/** The desired state of both checks for the pull's current state (ADR-020). */
export function renderChecks(pull: PullRecord, origin: string | null): DesiredCheck[] {
  const base = (
    status: DesiredCheck["status"],
    conclusion: DesiredCheck["conclusion"],
    title: string,
    summary: string,
    detailsUrl: string | null = null,
  ) => ({ status, conclusion, title, summary, detailsUrl });
  const sha = mdCode(pull.headSha);
  const open = (name: CheckName): DesiredCheck => {
    if (pull.state === "awaiting_preview")
      return {
        name,
        ...base(
          "queued",
          null,
          "Waiting for the preview deployment",
          `Commit ${sha} is waiting for a successful deployment of this exact commit.${
            pull.previewDeadlineAt ? ` Deadline: ${mdEscape(pull.previewDeadlineAt)}.` : ""
          }`,
        ),
      };
    return {
      name,
      ...base(
        "in_progress",
        null,
        "Tests are running",
        `Commit ${sha} is being tested${pull.previewUrl ? ` against ${mdCode(pull.previewUrl, 300)}` : ""}.`,
        origin && pull.batchId ? `${origin}/batches/${pull.batchId}` : null,
      ),
    };
  };
  const closed = (
    conclusion: "cancelled" | "action_required" | "failure",
    title: string,
    detail: string,
    gateFails: boolean,
  ): DesiredCheck[] =>
    checkNames.map((name) => ({
      name,
      ...base(
        "completed",
        name === "TestMaster / required-gate" && gateFails ? "failure" : conclusion,
        title,
        `${detail}\n**Commit:** ${sha}`,
        origin && pull.batchId ? `${origin}/batches/${pull.batchId}` : null,
      ),
    }));
  switch (pull.state) {
    case "awaiting_preview":
    case "running":
      return checkNames.map(open);
    case "completed": {
      const stored = pull.resultJson ? (JSON.parse(pull.resultJson) as StoredResult) : null;
      if (!stored)
        return closed("failure", "No result recorded", "The run finished without a recorded verdict.", true);
      return checkNames.map((name) => {
        const computed = checkConclusion(stored.ci, name);
        // A fork ran fixtures only: its verdict is informative and can never satisfy the required gate.
        const forkLimited = pull.fork && computed !== null;
        const conclusion = !forkLimited
          ? computed
          : name === "TestMaster / required-gate"
            ? "failure"
            : computed === "success"
              ? "neutral"
              : computed;
        return {
          name,
          ...base(
            conclusion === null ? "in_progress" : "completed",
            conclusion,
            forkLimited ? `Fork fixture run: ${stored.ci.gate}` : `TestMaster gate: ${stored.ci.gate}`,
            `${forkLimited ? "A pull request from a fork ran against fixtures only and cannot satisfy the required gate.\n" : ""}${resultSummary(pull, stored, origin)}`,
            origin && stored.ci.batchId ? `${origin}/batches/${stored.ci.batchId}` : null,
          ),
        };
      });
    }
    case "denied":
      return closed(
        "action_required",
        "Action required",
        `Not executed: ${reasonSentence(pull.reasonCode)}`,
        true,
      );
    case "timed_out":
      return closed(
        "action_required",
        "Preview timed out",
        `Not executed: ${reasonSentence(pull.reasonCode ?? "preview_timeout")}`,
        true,
      );
    case "superseded":
      return closed(
        "cancelled",
        "Superseded by a newer commit",
        `Superseded${pull.supersededBy ? ` by ${mdCode(short(pull.supersededBy))}` : ""}; this result no longer applies.`,
        false,
      );
    case "closed":
      return closed(
        "cancelled",
        "Pull request closed",
        `Stopped: ${reasonSentence(pull.reasonCode ?? "pull_request_closed")}`,
        false,
      );
    case "skipped":
      return [];
  }
}

export function checkExternalId(
  installationId: string,
  repositoryId: string,
  prNumber: number,
  sha: string,
  name: CheckName,
): string {
  return semanticHash({ installationId, repositoryId, prNumber, sha, name });
}

export function commentMarker(installationId: string, repositoryId: string, prNumber: number): string {
  return `<!-- testmaster:pr installation=${installationId} repo=${repositoryId} pr=${prNumber} -->`;
}
const stateText: Record<PullRecord["state"], string> = {
  awaiting_preview: "waiting for preview",
  running: "running",
  completed: "completed",
  superseded: "superseded",
  timed_out: "preview timed out",
  denied: "not executed",
  skipped: "skipped",
  closed: "closed",
};
/** The single upserted PR comment: newest commit first, older ones marked superseded. */
export function renderComment(pulls: readonly PullRecord[], origin: string | null): string {
  const first = pulls[0];
  if (!first) return "";
  const rows = pulls.slice(0, 5).map((pull) => {
    const stored = pull.resultJson ? (JSON.parse(pull.resultJson) as StoredResult) : null;
    const gate = stored ? stored.ci.gate : (pull.gate ?? "pending");
    const detail =
      pull.state === "denied" || pull.state === "timed_out"
        ? reasonSentence(pull.reasonCode)
        : pull.state === "superseded"
          ? `superseded by ${mdCode(short(pull.supersededBy ?? ""))}`
          : "";
    const links = [
      pull.batchId ? link(origin, `/batches/${pull.batchId}`, "batch") : null,
      ...(stored?.runs.slice(0, 3).map((run) => link(origin, `/runs/${run.id}`, "run")) ?? []),
    ]
      .filter(Boolean)
      .join(" · ");
    return `| ${mdCode(short(pull.headSha))} | ${mdEscape(stateText[pull.state])} | ${mdEscape(gate)} | ${detail || "—"} | ${links || "—"} |`;
  });
  return [
    commentMarker(first.installationId, first.repositoryId, first.prNumber),
    "### TestMaster",
    "",
    "| Commit | State | Gate | Detail | Links |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    origin ? "Links need a TestMaster portal sign-in." : "No portal origin is configured.",
  ].join("\n");
}
