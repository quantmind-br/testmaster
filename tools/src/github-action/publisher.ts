import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as ApplicationRuntime from "@testmaster/application";
import { ActionInputError as ContractError } from "./inputs.js";
export interface PublishEnvelopeInput {
  runtimeDir: string;
  envelopePath: string;
  repository: string;
  sha: string;
  checkoutSha: string;
  token: string;
  runnerTemp: string;
  expectedReportHash: string;
  workflowRunId?: string;
  executionJobId?: string;
}
export async function publishEnvelope(input: PublishEnvelopeInput) {
  if (
    (input.workflowRunId !== undefined && !/^[0-9]+$/.test(input.workflowRunId)) ||
    (input.executionJobId !== undefined && !/^[0-9]+$/.test(input.executionJobId)) ||
    !/^[0-9a-f]{64}$/.test(input.expectedReportHash)
  )
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Trusted artifact identity and expected report hash are required",
    );
  // Import only from the already verified runtime, never from the evaluated checkout.
  const { Application, validateCiEnvelope }: typeof ApplicationRuntime = await import(
    pathToFileURL(join(input.runtimeDir, "packages/application/dist/index.js")).href
  );
  const envelope = await validateCiEnvelope(input.envelopePath);
  if (
    envelope.result.reportHash !== input.expectedReportHash ||
    envelope.result.provenance.assessedSha !== input.sha ||
    envelope.result.provenance.checkoutSha !== input.checkoutSha
  )
    throw new ContractError(
      "POLICY_DENIED",
      "Downloaded CI artifact differs from trusted publication identity",
    );
  // Never load the execution database or auth state. The publisher starts a clean workspace.
  const cwd = await mkdtemp(join(input.runnerTemp, "testmaster-publisher-"));
  let app = await Application.open({
    cwd,
    home: cwd,
    env: { TESTMASTER_DATA_DIR: join(cwd, "data"), TESTMASTER_OFFLINE: "true", CI: "true" },
  });
  try {
    await app.init({ name: "Trusted check publisher" });
    app.close();
    app = await Application.open({
      cwd,
      home: cwd,
      env: { TESTMASTER_DATA_DIR: join(cwd, "data"), TESTMASTER_OFFLINE: "true", CI: "true" },
    });
    return await app.delivery.publish(envelope.result, input.repository, input.sha, input.token);
  } finally {
    app.close();
  }
}
