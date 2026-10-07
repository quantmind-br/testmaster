import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepositoryProvenance } from "@testmaster/application";
import { describe, expect, it } from "vitest";
import { type GithubWorkflowOptions, githubWorkflow } from "./ci-workflow.js";

const options: GithubWorkflowOptions = {
  actionRef: `quantmind-br/testmaster@${"a".repeat(40)}`,
  setupScript: "scripts/testmaster-ci.sh",
  runtimeRepo: "quantmind-br/testmaster",
  runtimeTag: "experimental",
  runtimeAssets: [
    "manifest.json",
    "runtime.tar.gz",
    "testmaster-runner.tar.gz.part-0000",
    "testmaster-runner-python.tar.gz.part-0000",
  ],
  manifestSha256: "b".repeat(64),
};
describe("operational public GitHub onboarding", () => {
  it("isolates assessed execution from pinned clean publication and denies forks before setup/download", () => {
    const workflow = JSON.parse(githubWorkflow(options));
    expect(workflow.on.pull_request_target).toBeUndefined();
    expect(workflow.jobs.execute.permissions.checks).toBeUndefined();
    expect(workflow.jobs.publish.permissions.checks).toBe("write");
    for (const job of Object.values(workflow.jobs) as {
      if: string;
      steps: Record<string, any>[];
    }[]) {
      expect(job.if).toContain(
        "github.event.pull_request.head.repo.full_name == github.repository",
      );
      const checkout = job.steps.filter((step) =>
        String(step.uses).startsWith("actions/checkout@"),
      );
      expect(checkout.every((step) => step.with["persist-credentials"] === false)).toBe(true);
      const download = job.steps.find((step) => String(step.run).includes("curl --fail"))!;
      expect(download.run).not.toContain("TOKEN");
      expect(download.run).toContain("sha256sum --check");
    }
    expect(
      workflow.jobs.publish.steps.some(
        (step: Record<string, any>) =>
          step.with?.repository !== undefined && step.with.ref === "a".repeat(40),
      ),
    ).toBe(true);
    expect(
      workflow.jobs.publish.steps.some((step: Record<string, any>) =>
        String(step.run).includes(options.setupScript),
      ),
    ).toBe(false);
    expect(
      workflow.jobs.execute.steps.find((step: Record<string, any>) => step.id === "upload").with
        .path,
    ).not.toContain("data");
    const action = workflow.jobs.execute.steps.find(
      (step: Record<string, any>) => step.id === "testmaster",
    );
    expect(action.with["quarantine-policy"]).toBe("strict");
    expect(action.with["publish-check"]).toBe("false");
    const publisher = workflow.jobs.publish.steps.at(-1);
    expect(publisher.env.TESTMASTER_WORKFLOW_RUN_ID).toBe("${{ github.run_id }}");
    expect(publisher.env.TESTMASTER_EXECUTION_JOB_ID).toBe("${{ needs.execute.outputs.job-id }}");
  });
  it("uses only contexts GitHub allows at job level", () => {
    // Job env/if/outputs are evaluated before a runner exists; `runner.*` there makes the
    // whole workflow file invalid.
    const workflow = JSON.parse(githubWorkflow(options));
    for (const job of Object.values(workflow.jobs) as Record<string, unknown>[]) {
      const jobLevel = JSON.stringify({ env: job.env, if: job.if, outputs: job.outputs });
      expect(jobLevel).not.toMatch(/\$\{\{[^}]*\brunner\./u);
    }
  });
  it("keeps the assessed pull request head reachable from the synthetic merge checkout", () => {
    const workflow = JSON.parse(githubWorkflow(options));
    const source = workflow.jobs.execute.steps.find(
      (step: Record<string, any>) =>
        String(step.uses).startsWith("actions/checkout@") && !step.with.repository,
    );
    // Depth 1 omits the merge's second parent, so the PR head ancestry binding is refused.
    const depth = source.with["fetch-depth"];
    expect(depth === 0 || depth >= 2).toBe(true);
  });
  it("keeps the assessed tree clean after the trusted distribution checkout", async () => {
    const workflow = JSON.parse(githubWorkflow(options));
    const steps = workflow.jobs.execute.steps as Record<string, any>[];
    const trusted = steps.findIndex((step) => step.with?.path === ".testmaster-trusted");
    const root = await mkdtemp(join(tmpdir(), "testmaster-ci-workspace-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root });
      git("init", "--quiet");
      await writeFile(join(root, "app.js"), "app\n");
      git("add", "app.js");
      git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "app");
      // The trusted checkout is a nested repository inside the workspace.
      execFileSync("git", ["init", "--quiet", join(root, ".testmaster-trusted")]);
      await writeFile(join(root, ".testmaster-trusted", "install.js"), "tool\n");
      expect(resolveRepositoryProvenance(root).dirtyHash).not.toBeNull();
      for (const step of steps
        .slice(trusted + 1)
        .filter((step) => step.run)
        .slice(0, 1))
        execFileSync("bash", ["-c", step.run], { cwd: root });
      expect(resolveRepositoryProvenance(root)).toMatchObject({
        binding: "verified",
        dirtyHash: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    "../setup.sh",
    "/setup.sh",
    "scripts/setup.sh\npermissions: write-all",
    "scripts/./setup.sh",
  ])("refuses unsafe setup path %s", (setupScript) => {
    expect(() => githubWorkflow({ ...options, setupScript })).toThrow();
  });
  it("refuses mutable Action coordinates and incomplete public asset sets", () => {
    expect(() =>
      githubWorkflow({ ...options, actionRef: "quantmind-br/testmaster@main" }),
    ).toThrow();
    expect(() =>
      githubWorkflow({ ...options, runtimeAssets: ["manifest.json", "runtime.tar.gz"] }),
    ).toThrow();
  });
});
