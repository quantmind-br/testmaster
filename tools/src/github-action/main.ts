import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type * as ApplicationRuntime from "@testmaster/application";
import { installRuntime } from "../distribution/install.js";
import {
  ActionInputError as ContractError,
  executionEnvironment,
  parseActionInputs,
} from "./inputs.js";
import { publishEnvelope } from "./publisher.js";
export async function runAction(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const inputs = parseActionInputs(env);
  if (!env.RUNNER_TEMP || !env.GITHUB_WORKSPACE)
    throw new ContractError("INVALID_ARGUMENT", "Runner directories are required");
  if ((await realpath(env.RUNNER_TEMP)) !== resolve(env.RUNNER_TEMP))
    throw new ContractError("POLICY_DENIED", "Runner temp directory cannot use symlinks");
  if (env.GITHUB_EVENT_NAME === "pull_request") {
    if (!env.GITHUB_EVENT_PATH)
      throw new ContractError("POLICY_DENIED", "Pull request identity is unavailable");
    const event: unknown = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
    if (
      !event ||
      typeof event !== "object" ||
      !("pull_request" in event) ||
      !event.pull_request ||
      typeof event.pull_request !== "object" ||
      !("head" in event.pull_request) ||
      !event.pull_request.head ||
      typeof event.pull_request.head !== "object" ||
      !("repo" in event.pull_request.head) ||
      !event.pull_request.head.repo ||
      typeof event.pull_request.head.repo !== "object" ||
      !("full_name" in event.pull_request.head.repo) ||
      event.pull_request.head.repo.full_name !== env.GITHUB_REPOSITORY
    )
      throw new ContractError(
        "POLICY_DENIED",
        "Fork execution is denied before runtime installation",
      );
  } else if (env.GITHUB_EVENT_NAME !== "workflow_dispatch")
    throw new ContractError(
      "POLICY_DENIED",
      "Action requires workflow_dispatch or a same-repository pull request",
    );
  const invocation = await mkdtemp(join(env.RUNNER_TEMP, "testmaster-action-"));
  const install = await installRuntime({
    manifestPath: resolve(inputs.runtimeManifest),
    manifestSha256: inputs.manifestSha256,
    destination: join(invocation, "runtime"),
  });
  // Runtime-selected module comes only from the hash-verified installed archive.
  const runtime: typeof ApplicationRuntime = await import(
    pathToFileURL(join(install.runtimeDir, "packages/application/dist/index.js")).href
  );
  const relativeCli = relative(install.runtimeDir, install.cliPath);
  if (!relativeCli || relativeCli.startsWith(`..${sep}`) || relativeCli === "..")
    throw new ContractError("POLICY_DENIED", "CLI is outside verified runtime");
  const output = join(invocation, "output");
  const argv = [
    install.cliPath,
    "--json",
    "ci",
    "run",
    ...inputs.testIds,
    ...(inputs.all ? ["--all"] : []),
    "--env",
    inputs.environment,
    "--output-dir",
    output,
    "--commit-sha",
    inputs.commitSha,
    "--checkout-sha",
    inputs.checkoutSha,
    "--quarantine-policy",
    inputs.quarantinePolicy,
    ...(inputs.targetUrl ? ["--target-url", inputs.targetUrl] : []),
    ...(inputs.allowEmpty ? ["--allow-empty", "--empty-reason", inputs.emptyReason!] : []),
  ];
  const completion = Promise.withResolvers<number>();
  const child = spawn(process.execPath, argv, {
    shell: false,
    cwd: env.GITHUB_WORKSPACE,
    env: executionEnvironment(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  // CLI output is data, not workflow commands. Do not forward untrusted stdout to Actions.
  child.stdout.resume();
  child.stderr.resume();
  const cancel = () => child.kill("SIGTERM");
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  child.once("error", completion.reject);
  child.once("close", (code, signal) =>
    completion.resolve(signal ? (signal === "SIGTERM" ? 143 : 130) : (code ?? 7)),
  );
  let exit: number;
  try {
    exit = await completion.promise;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
  const envelope = await runtime.validateCiEnvelope(join(output, "report.json"));
  const result = envelope.result;
  if (result.exitCode !== exit)
    throw new ContractError("POLICY_DENIED", "CLI exit and CI envelope disagree");
  if (result.provenance.assessedSha && result.provenance.assessedSha !== inputs.commitSha)
    throw new ContractError("POLICY_DENIED", "Assessed SHA changed during execution");
  if (result.provenance.checkoutSha && result.provenance.checkoutSha !== inputs.checkoutSha)
    throw new ContractError("POLICY_DENIED", "Checkout SHA changed during execution");
  for (const path of Object.values(result.outputs)) {
    if (path && !resolve(path).startsWith(`${resolve(output)}${sep}`))
      throw new ContractError("POLICY_DENIED", "CI output path escaped invocation");
  }
  if (env.GITHUB_OUTPUT) {
    const outputs = {
      gate: result.gate,
      "exit-code": String(result.exitCode),
      "batch-id": result.batchId ?? "",
      "assessed-sha": result.provenance.assessedSha ?? "",
      "checkout-sha": result.provenance.checkoutSha ?? "",
      "report-path": result.outputs.report ?? "",
      "junit-path": result.outputs.junit ?? "",
      "summary-path": result.outputs.summary ?? "",
      "bundle-index-path": result.outputs.bundleIndex ?? "",
      "report-hash": result.reportHash ?? "",
    };
    for (const [key, value] of Object.entries(outputs)) {
      if (/[\r\n\0]/.test(value)) throw new ContractError("POLICY_DENIED", "Unsafe Action output");
      await appendFile(env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
  }
  if (inputs.publishCheck) {
    const deliveries = await publishEnvelope({
      runtimeDir: install.runtimeDir,
      envelopePath: join(output, "report.json"),
      repository: env.GITHUB_REPOSITORY!,
      sha: inputs.commitSha,
      checkoutSha: inputs.checkoutSha,
      token: inputs.githubToken!,
      runnerTemp: env.RUNNER_TEMP,
      expectedReportHash: result.reportHash!,
    });
    if (deliveries.some((delivery) => delivery.state !== "delivered")) return 7;
  }
  return exit;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAction().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(
        error instanceof ContractError ? `${error.code}: ${error.message}` : "Action failed",
      );
      process.exitCode = 7;
    },
  );
}
