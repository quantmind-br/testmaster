import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  Application,
  ChecksClient,
  type CiResult,
  validateCiEnvelope,
} from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import { type Command, Option } from "commander";
import { githubWorkflow } from "./ci-workflow.js";
import { environmentId } from "./execution.js";
import { type Runtime, required, string } from "./runtime.js";

const exec = promisify(execFile);
async function githubToken(): Promise<string> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return (await exec("gh", ["auth", "token"], { timeout: 10000 })).stdout.trim();
  } catch {
    throw new ContractError("UNAUTHENTICATED", "GitHub token is unavailable");
  }
}
function repo(value: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))
    throw new ContractError("INVALID_ARGUMENT", "Invalid repository");
  return value;
}
export function ciCommands(program: Command, runtime: Runtime): void {
  const ci = program.command("ci");
  runtime.bind(
    ci
      .command("run [ids...]")
      .option("--all")
      .requiredOption("--env <name>")
      .requiredOption("--output-dir <path>")
      .option("--allow-empty")
      .option("--empty-reason <text>")
      .addOption(
        new Option("--quarantine-policy <policy>")
          .choices(["exclude", "strict"])
          .default("exclude"),
      )
      .option("--commit-sha <sha>")
      .option("--checkout-sha <sha>")
      .option("--target-url <url>")
      .option("--mode <mode>")
      .option("--heal <policy>")
      .option("--max-attempts <count>"),
    async (rt, args, options) => {
      const app = await rt.app();
      const projectId = await rt.project(options);
      const ids = Array.isArray(args[0]) ? args[0].map(String) : [];
      const testIds = ids.filter((id) => id.startsWith("tst_"));
      const runIds = ids.filter((id) => id.startsWith("run_"));
      if (testIds.length + runIds.length !== ids.length || (testIds.length && runIds.length))
        throw new ContractError("INVALID_ARGUMENT", "Select test IDs or Run IDs, not both");
      const commitSha = string(options, "commitSha");
      const checkoutSha = string(options, "checkoutSha");
      if ([commitSha, checkoutSha].some((sha) => sha !== undefined && !/^[0-9a-f]{40}$/.test(sha)))
        throw new ContractError(
          "INVALID_ARGUMENT",
          "SHA claims require 40 lowercase hexadecimal characters",
        );
      const result = await app.ci.run({
        projectId,
        environmentId: await environmentId(rt, options, projectId),
        outputDir: rt.path(required(options, "outputDir")),
        ...(ids.length
          ? testIds.length
            ? { testIds }
            : { runIds }
          : options.allowEmpty === true && options.all !== true
            ? { testIds: [] }
            : {}),
        ...(options.all === true ? { all: true } : {}),
        ...(options.allowEmpty === true ? { allowEmpty: true } : {}),
        ...(string(options, "emptyReason")
          ? { emptyReason: required(options, "emptyReason") }
          : {}),
        quarantinePolicy: options.quarantinePolicy === "strict" ? "strict" : "exclude",
        ...(commitSha || checkoutSha
          ? {
              provenance: {
                ...(commitSha ? { commitSha } : {}),
                ...(checkoutSha ? { checkoutSha } : {}),
              },
            }
          : {}),
        ...(string(options, "targetUrl") ? { targetUrl: required(options, "targetUrl") } : {}),
        ...(string(options, "mode") ? { mode: required(options, "mode") } : {}),
        ...(string(options, "heal") ? { healingPolicy: required(options, "heal") } : {}),
        ...(string(options, "maxAttempts")
          ? { maxAttempts: Number(required(options, "maxAttempts")) }
          : {}),
        signal: rt.controller.signal,
      });
      rt.receipts.push(result);
      return { data: result, exit: result.exitCode };
    },
  );
  const init = ci.command("init");
  runtime.bind(
    init
      .command("github")
      .requiredOption("--action-ref <ref>")
      .requiredOption("--setup-script <path>")
      .requiredOption("--runtime-repo <owner/repo>")
      .requiredOption("--runtime-tag <tag>")
      .requiredOption("--runtime-assets <json-array>")
      .requiredOption("--runtime-manifest-sha256 <hash>")
      .option("--output <path>")
      .option("--overwrite"),
    async (rt, _args, options) => {
      const reference = required(options, "actionRef");
      let assets: unknown;
      try {
        assets = JSON.parse(required(options, "runtimeAssets"));
      } catch {
        throw new ContractError("INVALID_ARGUMENT", "Runtime assets require a JSON array");
      }
      if (!Array.isArray(assets) || assets.some((asset) => typeof asset !== "string"))
        throw new ContractError("INVALID_ARGUMENT", "Runtime assets require a string array");
      const content = githubWorkflow({
        actionRef: reference,
        setupScript: required(options, "setupScript"),
        runtimeRepo: required(options, "runtimeRepo"),
        runtimeTag: required(options, "runtimeTag"),
        runtimeAssets: assets as string[],
        manifestSha256: required(options, "runtimeManifestSha256"),
      });
      const path = rt.path(string(options, "output") ?? ".github/workflows/testmaster.yml");
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, content, {
        mode: 0o600,
        flag: options.overwrite === true ? "w" : "wx",
      });
      return {
        data: {
          path,
          actionRef: reference,
          prerequisites: [
            "The declared setup script must initialize the application target and TestMaster ci environment with active tests",
            "Configure TestMaster / required-gate as the required check with admin enforcement; TestMaster / result is informational",
          ],
        },
      };
    },
  );
  runtime.bind(
    ci.command("doctor").requiredOption("--repo <owner/repo>"),
    async (_rt, _args, options) => {
      const repository = repo(required(options, "repo"));
      const client = new ChecksClient(await githubToken());
      const details = await client.request(`/repos/${repository}`);
      const actions = await client.request(`/repos/${repository}/actions/permissions`);
      return {
        data: {
          repository,
          details,
          actions,
          limitations: [
            "Read-only inspection does not establish token checks:write or assessed/checkout binding",
            "Public immutable release and license remain required for general distribution",
          ],
        },
      };
    },
  );
  runtime.bind(
    ci
      .command("publish [batchId]")
      .option("--envelope <path>")
      .requiredOption("--repo <owner/repo>")
      .requiredOption("--sha <sha>"),
    async (rt, args, options) => {
      let app: Application;
      let isolated = false;
      const repository = repo(required(options, "repo"));
      const sha = required(options, "sha");
      let result: CiResult;
      const path = string(options, "envelope");
      if (path) {
        if (args[0])
          throw new ContractError(
            "INVALID_ARGUMENT",
            "Batch ID and envelope are mutually exclusive",
          );
        result = (await validateCiEnvelope(rt.path(path))).result;
        const cwd = await mkdtemp(join(tmpdir(), "testmaster-check-publisher-"));
        const publisherOptions = {
          cwd,
          home: cwd,
          env: { TESTMASTER_DATA_DIR: join(cwd, "data"), TESTMASTER_OFFLINE: "true", CI: "true" },
        };
        const setup = await Application.open(publisherOptions);
        try {
          await setup.init({ name: "Trusted CI publisher" });
        } finally {
          setup.close();
        }
        app = await Application.open(publisherOptions);
        isolated = true;
      } else {
        app = await rt.app();
        if (typeof args[0] !== "string")
          throw new ContractError("INVALID_ARGUMENT", "Batch ID or envelope is required");
        const stored = app.context.database.get(
          "SELECT value FROM operational_state WHERE key=?",
          `ci:result:${app.context.workspaceId}:${args[0]}`,
        );
        if (!stored)
          throw new ContractError("NOT_FOUND", "No frozen CI result exists for this batch");
        result = JSON.parse(String(stored.value));
      }
      try {
        const deliveries = await app.delivery.publish(result, repository, sha, await githubToken());
        return {
          data: { result, deliveries },
          exit: deliveries.some((item) => item.state !== "delivered") ? 7 : 0,
        };
      } finally {
        if (isolated) app.close();
      }
    },
  );
}
