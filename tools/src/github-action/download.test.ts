import { afterEach, expect, it, vi } from "vitest";
import { type DownloadEnvelopeInput, downloadEnvelope } from "./download.js";

const input: DownloadEnvelopeInput = {
  repository: "owner/repo",
  workflowRunId: "10",
  executionJobId: "20",
  artifactId: "30",
  archiveSha256: "c".repeat(64),
  assessedSha: "a".repeat(40),
  checkoutSha: "b".repeat(40),
  token: "test-token",
  runnerTemp: "/unused",
};
afterEach(() => vi.restoreAllMocks());

// Shape of GET /repos/{owner}/{repo}/actions/runs/{id} as returned by GitHub: pull_requests
// identify the head repository by id/url/name only (captured from a hosted same-repo PR run).
const repository = { id: 1408086281, full_name: input.repository };
const pullRequest = (sha: string, repoId: number) => ({
  url: "https://api.github.com/repos/owner/repo/pulls/1",
  id: 4772042674,
  number: 1,
  head: {
    ref: "pr-healthy",
    sha,
    repo: { id: repoId, url: "https://api.github.com/repos/owner/repo", name: "repo" },
  },
  base: {
    ref: "main",
    sha: "d".repeat(40),
    repo: { id: repository.id, url: "https://api.github.com/repos/owner/repo", name: "repo" },
  },
});

it("refuses a workflow head SHA mismatch or unsupported event before artifact access", async () => {
  for (const run of [
    { head_sha: input.checkoutSha, event: "workflow_dispatch", repository },
    { head_sha: input.assessedSha, event: "push", repository },
    {
      head_sha: input.assessedSha,
      event: "workflow_dispatch",
      repository: { id: 7, full_name: "other/repo" },
    },
  ]) {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(run))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(downloadEnvelope(input)).rejects.toMatchObject({
      code: "POLICY_DENIED",
      message: "Workflow SHA/event differs from publication context",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockRestore();
  }
});

it("accepts matching assessed head for dispatch and same-repository pull request before job lookup", async () => {
  for (const run of [
    { head_sha: input.assessedSha, event: "workflow_dispatch", repository, pull_requests: [] },
    {
      head_sha: input.assessedSha,
      event: "pull_request",
      repository,
      head_repository: repository,
      pull_requests: [pullRequest(input.assessedSha, repository.id)],
    },
  ]) {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(run))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(downloadEnvelope(input)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Execution job lookup failed",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/owner/repo/actions/jobs/20",
    );
    fetch.mockRestore();
  }
});

it("refuses fork or foreign-head pull request runs before job lookup", async () => {
  for (const run of [
    // Fork PR: head_repository is the fork and GitHub lists no pull_requests for it.
    {
      head_sha: input.assessedSha,
      event: "pull_request",
      repository,
      head_repository: { id: 99, full_name: "fork/repo" },
      pull_requests: [],
    },
    {
      head_sha: input.assessedSha,
      event: "pull_request",
      repository,
      head_repository: repository,
      pull_requests: [pullRequest(input.assessedSha, 99)],
    },
    {
      head_sha: input.assessedSha,
      event: "pull_request",
      repository,
      head_repository: repository,
      pull_requests: [pullRequest(input.checkoutSha, repository.id)],
    },
  ]) {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(run))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(downloadEnvelope(input)).rejects.toMatchObject({
      code: "POLICY_DENIED",
      message: "Fork publication cannot use private runtime assets",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockRestore();
  }
});
