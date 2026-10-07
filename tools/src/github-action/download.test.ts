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

it("refuses a workflow head SHA mismatch or unsupported event before artifact access", async () => {
  for (const run of [
    { head_sha: input.checkoutSha, event: "workflow_dispatch" },
    { head_sha: input.assessedSha, event: "push" },
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
  for (const event of ["workflow_dispatch", "pull_request"]) {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          head_sha: input.assessedSha,
          event,
          pull_requests: [{ head: { repo: { full_name: input.repository } } }],
        }),
      )
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
