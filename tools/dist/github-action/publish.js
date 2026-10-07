import { mkdtemp, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installRuntime } from "../distribution/install.js";
import { downloadEnvelope } from "./download.js";
import { ActionInputError } from "./inputs.js";
import { publishEnvelope } from "./publisher.js";
export async function runPublisher(env = process.env) {
    const keys = [
        "TESTMASTER_RUNTIME_MANIFEST",
        "TESTMASTER_ARTIFACT_ID",
        "TESTMASTER_ARTIFACT_SHA256",
        "TESTMASTER_REPORT_HASH",
        "TESTMASTER_WORKFLOW_RUN_ID",
        "TESTMASTER_EXECUTION_JOB_ID",
        "TESTMASTER_ASSESSED_SHA",
        "TESTMASTER_CHECKOUT_SHA",
        "GITHUB_TOKEN",
        "GITHUB_REPOSITORY",
        "RUNNER_TEMP",
    ];
    for (const key of keys)
        if (!env[key])
            throw new ActionInputError("INVALID_ARGUMENT", `Missing ${key}`);
    if ((await realpath(env.RUNNER_TEMP)) !== resolve(env.RUNNER_TEMP))
        throw new ActionInputError("POLICY_DENIED", "Runner temp uses symlinks");
    const manifest = env.TESTMASTER_RUNTIME_MANIFEST;
    const split = manifest.lastIndexOf("#");
    if (split < 1 || !/^[0-9a-f]{64}$/.test(manifest.slice(split + 1)))
        throw new ActionInputError("INVALID_ARGUMENT", "Pinned runtime manifest required");
    const cwd = await mkdtemp(join(env.RUNNER_TEMP, "testmaster-trusted-publish-"));
    const envelopePath = await downloadEnvelope({
        repository: env.GITHUB_REPOSITORY,
        workflowRunId: env.TESTMASTER_WORKFLOW_RUN_ID,
        executionJobId: env.TESTMASTER_EXECUTION_JOB_ID,
        artifactId: env.TESTMASTER_ARTIFACT_ID,
        archiveSha256: env.TESTMASTER_ARTIFACT_SHA256,
        assessedSha: env.TESTMASTER_ASSESSED_SHA,
        checkoutSha: env.TESTMASTER_CHECKOUT_SHA,
        token: env.GITHUB_TOKEN,
        runnerTemp: cwd,
    });
    const runtime = await installRuntime({
        manifestPath: manifest.slice(0, split),
        manifestSha256: manifest.slice(split + 1),
        destination: join(cwd, "runtime"),
    });
    const deliveries = await publishEnvelope({
        runtimeDir: runtime.runtimeDir,
        envelopePath,
        repository: env.GITHUB_REPOSITORY,
        sha: env.TESTMASTER_ASSESSED_SHA,
        checkoutSha: env.TESTMASTER_CHECKOUT_SHA,
        token: env.GITHUB_TOKEN,
        runnerTemp: cwd,
        expectedReportHash: env.TESTMASTER_REPORT_HASH,
        workflowRunId: env.TESTMASTER_WORKFLOW_RUN_ID,
        executionJobId: env.TESTMASTER_EXECUTION_JOB_ID,
    });
    return deliveries.every((row) => row.state === "delivered") ? 0 : 7;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    runPublisher().then((code) => {
        process.exitCode = code;
    }, (error) => {
        // ActionInputError messages are fixed code-owned strings; anything else stays generic.
        console.error(error instanceof ActionInputError
            ? `Trusted check publication failed: ${error.code}: ${error.message}`
            : "Trusted check publication failed");
        process.exitCode = 7;
    });
//# sourceMappingURL=publish.js.map