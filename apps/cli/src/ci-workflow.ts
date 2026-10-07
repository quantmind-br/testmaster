import { ContractError } from "@testmaster/contracts";
export interface GithubWorkflowOptions {
  actionRef: string;
  setupScript: string;
  runtimeRepo: string;
  runtimeTag: string;
  runtimeAssets: string[];
  manifestSha256: string;
  /** Loopback origin the setup script serves from the checkout; only it binds CI evidence. */
  targetUrl: string;
}
const expression = (body: string) => `\${{ ${body} }}`;
function loopbackTarget(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ContractError("INVALID_ARGUMENT", "Invalid target URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new ContractError(
      "INVALID_ARGUMENT",
      "CI evidence binds only a credential-free loopback target served from the checkout",
    );
  // The serialized URL percent-encodes braces, so it cannot form a workflow expression.
  return url.href;
}
export function githubWorkflow(options: GithubWorkflowOptions): string {
  const { actionRef, setupScript, runtimeRepo, runtimeTag, runtimeAssets, manifestSha256 } =
    options;
  const targetUrl = loopbackTarget(options.targetUrl);
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/u.test(actionRef) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(runtimeRepo) ||
    !/^[A-Za-z0-9_.-]+$/u.test(runtimeTag) ||
    !/^[a-f0-9]{64}$/u.test(manifestSha256) ||
    !/^[A-Za-z0-9_./-]+\.sh$/u.test(setupScript) ||
    setupScript.startsWith("/") ||
    setupScript.split("/").some((part) => !part || part === "." || part === "..") ||
    runtimeAssets.length < 4 ||
    new Set(runtimeAssets).size !== runtimeAssets.length ||
    !runtimeAssets.includes("manifest.json") ||
    !runtimeAssets.includes("runtime.tar.gz") ||
    runtimeAssets.some(
      (asset) =>
        !/^(?:manifest\.json|runtime\.tar\.gz|testmaster-runner(?:-python)?\.tar\.gz\.part-[0-9]{4})$/u.test(
          asset,
        ),
    ) ||
    !["testmaster-runner", "testmaster-runner-python"].every((image) =>
      runtimeAssets.includes(`${image}.tar.gz.part-0000`),
    )
  )
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Immutable Action, public release assets, pinned manifest and repository-relative setup script are required",
    );
  const [actionRepo, actionSha] = actionRef.split("@");
  const guard =
    "github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)";
  const assessed = expression("github.event.pull_request.head.sha || github.sha");
  const checkout = expression("github.sha");
  // Job-level `env` cannot read the `runner` context, so runner-temp paths are exported by
  // the first step of each job instead.
  const env = {
    TESTMASTER_OFFLINE: "true",
    TESTMASTER_MANIFEST_SHA256: manifestSha256,
  };
  const paths = (data: string) => ({
    name: "Configure TestMaster paths",
    run: `set -euo pipefail\n{\n  printf 'TESTMASTER_DATA_DIR=%s\\n' "$RUNNER_TEMP/${data}"\n  printf 'TESTMASTER_RUNTIME_DIR=%s\\n' "$RUNNER_TEMP/testmaster-runtime"\n  printf 'TESTMASTER_CLI=%s\\n' "$RUNNER_TEMP/testmaster-runtime/apps/cli/dist/main.js"\n  printf 'TESTMASTER_RELEASE_DIR=%s\\n' "$RUNNER_TEMP/testmaster-release"\n} >> "$GITHUB_ENV"`,
  });
  const node = {
    uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    with: { "node-version": "24" },
  };
  const store = {
    name: "Configure locked image store",
    run: `set -euo pipefail\nconfig=/etc/docker/daemon.json\ncurrent=$(sudo cat "$config" 2>/dev/null || echo '{}')\necho "$current" | jq '.features = ((.features // {}) + {"containerd-snapshotter": true})' | sudo tee "$config" >/dev/null\nsudo systemctl restart docker`,
  };
  const download = {
    name: "Download anonymous pinned public runtime",
    run: `set -euo pipefail\nmkdir -m 700 "$TESTMASTER_RELEASE_DIR" "$TESTMASTER_RELEASE_DIR/images"\n${runtimeAssets.map((asset) => `curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' 'https://github.com/${runtimeRepo}/releases/download/${runtimeTag}/${asset}' --output "$TESTMASTER_RELEASE_DIR/${asset.endsWith(".json") || asset === "runtime.tar.gz" ? asset : "images/" + asset}"`).join("\n")}\nprintf '%s  %s\\n' "$TESTMASTER_MANIFEST_SHA256" "$TESTMASTER_RELEASE_DIR/manifest.json" | sha256sum --check --status`,
  };
  const trusted = {
    name: "Checkout trusted distribution only",
    uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    with: {
      repository: actionRepo,
      ref: actionSha,
      path: ".testmaster-trusted",
      "persist-credentials": false,
    },
  };
  const manifest =
    expression("runner.temp") + `/testmaster-release/manifest.json#${manifestSha256}`;
  const workflow = {
    name: "TestMaster",
    on: { workflow_dispatch: {}, pull_request: {} },
    permissions: { contents: "read" },
    jobs: {
      execute: {
        if: expression(guard),
        "runs-on": "ubuntu-24.04",
        "timeout-minutes": 30,
        permissions: { contents: "read", actions: "read" },
        env,
        outputs: {
          "artifact-id": expression("steps.upload.outputs.artifact-id"),
          "artifact-sha256": expression("steps.upload.outputs.artifact-digest"),
          "report-hash": expression("steps.testmaster.outputs.report-hash"),
          "job-id": expression("steps.identity.outputs.job-id"),
          "assessed-sha": assessed,
          "checkout-sha": checkout,
        },
        steps: [
          paths("testmaster-execution-data"),
          {
            uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            // A pull request checks out the synthetic merge commit; depth 2 keeps the assessed PR
            // head (its second parent) available for the ancestry binding.
            with: { "persist-credentials": false, "fetch-depth": 2 },
          },
          trusted,
          {
            // The trusted distribution and the project config written by `init` in the setup
            // script are runner state, not application source; untracked they would make every
            // assessed tree dirty and unbound. Exclusion never hides changes to tracked files.
            name: "Exclude runner state from the assessed tree",
            run: `set -euo pipefail\nexclude=$(git rev-parse --git-path info/exclude)\nmkdir -p "$(dirname "$exclude")"\nprintf '/.testmaster-trusted/\\n/testmaster.config.json\\n' >> "$exclude"`,
          },
          node,
          store,
          download,
          {
            name: "Install verified runtime",
            run: `node .testmaster-trusted/tools/dist/distribution/install.js --manifest "$TESTMASTER_RELEASE_DIR/manifest.json" --manifest-sha256 "$TESTMASTER_MANIFEST_SHA256" --dest "$TESTMASTER_RUNTIME_DIR"`,
          },
          {
            id: "identity",
            name: "Bind execution job identity",
            env: { GH_TOKEN: expression("github.token") },
            run: `set -euo pipefail\nid=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/jobs" --jq '.jobs[] | select(.name == "execute" and .status == "in_progress") | .id')\n[[ "$id" =~ ^[0-9]+$ ]]\nprintf 'job-id=%s\\n' "$id" >> "$GITHUB_OUTPUT"`,
          },
          {
            name: "Prepare application and TestMaster workspace",
            run: `set -euo pipefail\ntest "$(id -u)" != 0\nenv -u GITHUB_TOKEN -u GH_TOKEN bash -- ${JSON.stringify(setupScript)}`,
          },
          {
            id: "testmaster",
            uses: actionRef,
            with: {
              "runtime-manifest": manifest,
              all: "true",
              environment: "ci",
              "target-url": targetUrl,
              "commit-sha": assessed,
              "checkout-sha": checkout,
              "quarantine-policy": "strict",
              "publish-check": "false",
            },
          },
          {
            id: "envelope",
            if: expression("always() && steps.testmaster.outputs.report-path != ''"),
            env: { REPORT: expression("steps.testmaster.outputs.report-path") },
            run: `set -euo pipefail\nmkdir -m 700 "$RUNNER_TEMP/testmaster-envelope"\nsource=$(dirname "$REPORT")\nfor file in report.json junit.xml summary.md bundle-index.json completion.json; do\n  test -f "$source/$file" && test ! -L "$source/$file"\n  cp -- "$source/$file" "$RUNNER_TEMP/testmaster-envelope/$file"\ndone`,
          },
          {
            id: "upload",
            if: expression("always() && steps.envelope.outcome == 'success'"),
            uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
            with: {
              name: "testmaster-ci-" + expression("steps.identity.outputs.job-id"),
              path: expression("runner.temp") + "/testmaster-envelope/*",
              "if-no-files-found": "error",
              "retention-days": 3,
            },
          },
        ],
      },
      publish: {
        needs: "execute",
        if: expression(`always() && (${guard}) && needs.execute.outputs.artifact-id != ''`),
        "runs-on": "ubuntu-24.04",
        "timeout-minutes": 30,
        permissions: { contents: "read", actions: "read", checks: "write" },
        env,
        steps: [
          paths("testmaster-publisher-data"),
          trusted,
          node,
          store,
          download,
          {
            name: "Publish frozen sanitized envelope",
            env: {
              GITHUB_TOKEN: expression("github.token"),
              TESTMASTER_RUNTIME_MANIFEST: manifest,
              TESTMASTER_ARTIFACT_ID: expression("needs.execute.outputs.artifact-id"),
              TESTMASTER_ARTIFACT_SHA256: expression("needs.execute.outputs.artifact-sha256"),
              TESTMASTER_REPORT_HASH: expression("needs.execute.outputs.report-hash"),
              TESTMASTER_WORKFLOW_RUN_ID: expression("github.run_id"),
              TESTMASTER_EXECUTION_JOB_ID: expression("needs.execute.outputs.job-id"),
              TESTMASTER_ASSESSED_SHA: expression("needs.execute.outputs.assessed-sha"),
              TESTMASTER_CHECKOUT_SHA: expression("needs.execute.outputs.checkout-sha"),
            },
            run: "node .testmaster-trusted/tools/dist/github-action/publish.js",
          },
        ],
      },
    },
  };
  // JSON is YAML 1.2: scalar quoting prevents user input from injecting workflow structure.
  return JSON.stringify(workflow, null, 2) + "\n";
}
