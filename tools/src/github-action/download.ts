import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ActionInputError } from "./inputs.js";
export interface DownloadEnvelopeInput {
  repository: string;
  workflowRunId: string;
  executionJobId: string;
  artifactId: string;
  archiveSha256: string;
  assessedSha: string;
  checkoutSha: string;
  token: string;
  runnerTemp: string;
}
async function unzip(path: string, args: string[], maxBytes: number): Promise<Buffer> {
  const done = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  let bytes = 0;
  const child = spawn("unzip", [...args, path], {
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH },
  });
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      child.kill();
      done.reject(new ActionInputError("PAYLOAD_TOO_LARGE", "Artifact exceeds publisher limit"));
    } else chunks.push(chunk);
  });
  child.once("error", done.reject);
  child.once("close", (code) =>
    code === 0
      ? done.resolve(Buffer.concat(chunks))
      : done.reject(new ActionInputError("INVALID_ARGUMENT", "Artifact ZIP is invalid")),
  );
  return done.promise;
}
export async function downloadEnvelope(input: DownloadEnvelopeInput): Promise<string> {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
    ![input.workflowRunId, input.executionJobId, input.artifactId].every((id) =>
      /^[0-9]+$/.test(id),
    ) ||
    ![input.assessedSha, input.checkoutSha].every((sha) => /^[0-9a-f]{40}$/.test(sha)) ||
    !/^[0-9a-f]{64}$/.test(input.archiveSha256)
  )
    throw new ActionInputError("INVALID_ARGUMENT", "Trusted artifact identity is invalid");
  const headers = {
    Authorization: `Bearer ${input.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const runResponse = await fetch(
    `https://api.github.com/repos/${input.repository}/actions/runs/${input.workflowRunId}`,
    { headers, redirect: "error" },
  );
  if (!runResponse.ok) throw new ActionInputError("UNAVAILABLE", "Workflow identity lookup failed");
  const run = (await runResponse.json()) as {
    head_sha?: unknown;
    event?: unknown;
    repository?: { id?: unknown; full_name?: unknown };
    head_repository?: { full_name?: unknown } | null;
    pull_requests?: unknown;
  };
  // A pull_request run executes the synthetic merge checkout while GitHub records the PR head as
  // the run's head_sha; the published check targets that assessed head, never the merge commit.
  if (
    run.head_sha !== input.assessedSha ||
    !["workflow_dispatch", "pull_request"].includes(String(run.event)) ||
    run.repository?.full_name !== input.repository
  )
    throw new ActionInputError(
      "POLICY_DENIED",
      "Workflow SHA/event differs from publication context",
    );
  if (run.event === "pull_request") {
    // The workflow-run API identifies PR head repositories only by id/url/name (no full_name);
    // head_repository is the fork for fork PRs, whose pull_requests list is also empty.
    const repositoryId = run.repository.id;
    const sameRepository = (pr: unknown): boolean => {
      if (!pr || typeof pr !== "object" || !("head" in pr)) return false;
      const head = pr.head as { sha?: unknown; repo?: { id?: unknown } | null } | null;
      return head?.sha === input.assessedSha && head.repo?.id === repositoryId;
    };
    if (
      typeof repositoryId !== "number" ||
      run.head_repository?.full_name !== input.repository ||
      !Array.isArray(run.pull_requests) ||
      !run.pull_requests.length ||
      !run.pull_requests.every(sameRepository)
    )
      throw new ActionInputError(
        "POLICY_DENIED",
        "Fork publication is denied before runtime installation",
      );
  }
  const jobResponse = await fetch(
    `https://api.github.com/repos/${input.repository}/actions/jobs/${input.executionJobId}`,
    { headers, redirect: "error" },
  );
  if (!jobResponse.ok) throw new ActionInputError("UNAVAILABLE", "Execution job lookup failed");
  const job = (await jobResponse.json()) as Record<string, unknown>;
  if (String(job.run_id) !== input.workflowRunId || job.status !== "completed")
    throw new ActionInputError("POLICY_DENIED", "Artifact execution job differs from frozen run");
  const artifactResponse = await fetch(
    `https://api.github.com/repos/${input.repository}/actions/artifacts/${input.artifactId}`,
    { headers, redirect: "error" },
  );
  if (!artifactResponse.ok)
    throw new ActionInputError("UNAVAILABLE", "Artifact metadata lookup failed");
  const artifact = (await artifactResponse.json()) as {
    expired?: boolean;
    name?: string;
    workflow_run?: { id?: number; head_sha?: string };
    digest?: string;
  };
  if (
    artifact.expired ||
    artifact.name !== `testmaster-ci-${input.executionJobId}` ||
    String(artifact.workflow_run?.id) !== input.workflowRunId ||
    artifact.workflow_run?.head_sha !== input.assessedSha ||
    artifact.digest !== `sha256:${input.archiveSha256}`
  )
    throw new ActionInputError(
      "POLICY_DENIED",
      "Artifact identity/hash differs from trusted execution job",
    );
  const redirect = await fetch(
    `https://api.github.com/repos/${input.repository}/actions/artifacts/${input.artifactId}/zip`,
    { headers, redirect: "manual" },
  );
  const location = redirect.headers.get("location");
  if (redirect.status !== 302 || !location || new URL(location).protocol !== "https:")
    throw new ActionInputError("UNAVAILABLE", "Artifact download capability unavailable");
  // Signed capability receives no GitHub token. It is never returned or logged.
  const archive = await fetch(location, { redirect: "error", signal: AbortSignal.timeout(60000) });
  if (!archive.ok || !archive.body)
    throw new ActionInputError("UNAVAILABLE", "Artifact download failed");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of archive.body) {
    bytes += chunk.length;
    if (bytes > 32 * 1024 * 1024)
      throw new ActionInputError("PAYLOAD_TOO_LARGE", "Artifact archive exceeds publisher limit");
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (createHash("sha256").update(buffer).digest("hex") !== input.archiveSha256)
    throw new ActionInputError("POLICY_DENIED", "Downloaded archive hash differs");
  const directory = await mkdtemp(join(input.runnerTemp, "testmaster-envelope-"));
  const path = join(directory, "artifact.zip");
  await writeFile(path, buffer, { flag: "wx", mode: 0o600 });
  const listing = (await unzip(path, ["-Z1"], 65536)).toString("utf8").trim().split("\n");
  const names = ["report.json", "junit.xml", "summary.md", "bundle-index.json", "completion.json"];
  if (
    listing.length !== names.length ||
    names.some((name) => listing.filter((entry) => entry === name).length !== 1)
  )
    throw new ActionInputError("POLICY_DENIED", "Artifact contains unexpected paths");
  // Never extract links/permissions or execute payload. Read each fixed regular byte stream.
  for (const name of names) {
    const done = Promise.withResolvers<Buffer>();
    const output: Buffer[] = [];
    let size = 0;
    const child = spawn("unzip", ["-p", path, name], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH },
    });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        child.kill();
        done.reject(new ActionInputError("PAYLOAD_TOO_LARGE", "Artifact entry exceeds limit"));
      } else output.push(chunk);
    });
    child.once("error", done.reject);
    child.once("close", (code) =>
      code === 0
        ? done.resolve(Buffer.concat(output))
        : done.reject(new ActionInputError("INVALID_ARGUMENT", "Artifact entry is invalid")),
    );
    await writeFile(join(directory, name), await done.promise, { flag: "wx", mode: 0o600 });
  }
  return join(directory, "report.json");
}
