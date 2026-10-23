import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type ExecutablePlan, validate } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { FileEvidenceStore, type ObjectStore } from "@testmaster/evidence";
import {
  AttemptExecutor,
  type AttemptRuntimeExecutor,
  DockerExecutor,
  type ImageLock,
} from "@testmaster/sandbox";
import type { ResolvedConfig } from "../config.js";
import type { ServiceContext } from "../context.js";
import type { SecretsService } from "../secrets.js";
import type { BrowserLoginProbe } from "./profiles.js";

export interface BrowserLoginHost {
  config: ResolvedConfig;
  objectStore: ObjectStore;
  secrets: SecretsService;
  seccompPath: string;
  images(): Promise<ImageLock>;
  dockerCommand?: ConstructorParameters<typeof DockerExecutor>[0];
  docker?: AttemptRuntimeExecutor;
}

const probePlan = validate<ExecutablePlan>("ExecutablePlan", {
  schemaVersion: "1.0.0",
  kind: "executable",
  name: "Authentication login probe",
  type: "frontend",
  runner: "playwright",
  requirementRefs: [],
  steps: [
    {
      id: "probe",
      description: "Open the target after the login phase",
      kind: "action",
      operation: "navigate",
      required: true,
      input: { path: "/" },
    },
    {
      id: "probe-loaded",
      description: "Require the page to render",
      kind: "assertion",
      operation: "assert",
      required: true,
      input: { locator: { by: "css", value: "body" } },
      expectation: { predicate: "visible" },
    },
  ],
});

/**
 * A login-only Attempt in the isolated browser: it runs the profile's login steps, hands the captured
 * storage state to the vault and never creates a Run, a revision or a draft.
 */
export function createBrowserLoginProbe(
  ctx: ServiceContext,
  host: BrowserLoginHost,
): BrowserLoginProbe {
  return async ({ environment, login, secretIds, onAuthState }) => {
    const lock = await host.images();
    const runtimeRoot = `/tmp/testmaster-runtime-${process.getuid?.() ?? "unknown"}`;
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const probeId = uuidV7IdGenerator.next("att");
    const inputDir = join(host.config.dataDir, "cache", "auth-login", probeId);
    await mkdir(inputDir, { recursive: true, mode: 0o755 });
    const baseUrl = environment.targetOrigins[0] ?? "";
    const releases = await Promise.all(secretIds.map((id) => host.secrets.release(id)));
    const result = await new AttemptExecutor(
      new FileEvidenceStore({ rootDir: host.config.dataDir, objectStore: host.objectStore }),
      host.docker ?? new DockerExecutor(host.dockerCommand),
      runtimeRoot,
    ).execute({
      workspaceId: ctx.workspaceId,
      runId: uuidV7IdGenerator.next("run"),
      attemptId: probeId,
      revisionId: uuidV7IdGenerator.next("rev"),
      snapshotId: uuidV7IdGenerator.next("snp"),
      kind: "browser",
      imageId: lock["testmaster-runner"].imageId,
      inputDir,
      plan: probePlan,
      networkPolicy: {
        allowedOrigins: [...environment.targetOrigins],
        baseUrl,
        networkProfile: environment.networkProfile,
      },
      secretRefs: releases,
      runnerInput: {
        baseUrl,
        timeoutMs: 60_000,
        stepTimeoutMs: 30_000,
        auth: { login },
      },
      attemptTimeoutMs: 90_000,
      seccompPath: host.seccompPath,
      onAuthState,
    });
    return { ok: result.outcome === "passed", reasonCode: result.reasonCode };
  };
}
