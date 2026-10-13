import { type Application, scaffoldPlan } from "@testmaster/application";
import {
  type SeedAttempt,
  type SeededRun,
  type SeedRunOptions,
  seedRun,
} from "../../packages/application/src/run-seed.testing.js";

/**
 * Real Runs for the Run history and detail pages (UX-026..UX-034, M4-05). They go through the
 * same admission and persistence path the worker uses; only the sandbox is absent. Shared by the
 * portal-runs-detail journey and the accessibility sweep seed so both look at the same data.
 */
export interface RunsScope {
  readonly system: Application;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

export async function createRunsScope(
  system: Application,
  workspaceId: string,
  label: string,
): Promise<RunsScope> {
  const project = system.projects.create({ name: `${label} project` });
  const environment = system.environments.create({
    projectId: String(project.id),
    name: "staging",
    baseUrl: "http://127.0.0.1:9",
  });
  return {
    system,
    workspaceId,
    projectId: String(project.id),
    environmentId: String(environment.id),
  };
}

export function createTest(scope: RunsScope, kind: "frontend" | "backend" = "backend") {
  return scope.system.tests.create({ projectId: scope.projectId, plan: scaffoldPlan(kind) });
}

export function seed(
  scope: RunsScope,
  testId: string,
  attempts: readonly SeedAttempt[],
  extra: Partial<SeedRunOptions> = {},
): Promise<SeededRun> {
  return seedRun(scope.system, {
    testId,
    environmentId: scope.environmentId,
    attempts,
    ...extra,
  });
}

/** A 1x1 PNG: small, valid, decodes in every browser. */
export const pngBytes = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** Hostile bodies: if any of them ever ran, `window.__pwned` would be set. */
export const hostileJson = `{"note":"<script>window.__pwned='http'</script>","status":200}`;
export const hostileHtml =
  "<!doctype html><html><body><script>window.__pwned='dom'</script><p>Rendered DOM snapshot</p></body></html>";
export const longLogLine = "log line that is long enough to push the artifact beyond the preview\n";
export const longLog = longLogLine.repeat(1200);

export const artifactPaths = {
  screenshot: "screenshots/final.png",
  http: "http/response.json",
  console: "console/console.json",
  dom: "dom/page.html",
  log: "logs/runner.log",
  download: "downloads/export.zip",
  restricted: "raw/trace.zip",
} as const;

/**
 * One passed Attempt that carries every artifact family: an image, hostile JSON and HTML, a log
 * larger than the text preview, a binary download and a restricted raw trace.
 */
export function seedArtifactRun(scope: RunsScope, testId: string): Promise<SeededRun> {
  return seed(scope, testId, [
    {
      outcome: "passed",
      steps: [
        {
          stepId: "get-health",
          status: "passed",
          durationMs: 40,
          evidence: [artifactPaths.screenshot, artifactPaths.dom],
        },
        {
          stepId: "check-status",
          status: "passed",
          durationMs: 25,
          evidence: [artifactPaths.http, artifactPaths.console, artifactPaths.restricted],
        },
      ],
      artifacts: [
        {
          relativePath: artifactPaths.screenshot,
          kind: "screenshot",
          mimeType: "image/png",
          body: pngBytes,
        },
        {
          relativePath: artifactPaths.http,
          kind: "http",
          mimeType: "application/json",
          body: hostileJson,
        },
        {
          relativePath: artifactPaths.console,
          kind: "console",
          mimeType: "application/json",
          body: JSON.stringify([{ level: "info", text: "page ready" }]),
        },
        {
          relativePath: artifactPaths.dom,
          kind: "dom",
          mimeType: "text/html",
          body: hostileHtml,
        },
        {
          relativePath: artifactPaths.log,
          kind: "log",
          mimeType: "text/plain",
          body: longLog,
        },
        {
          relativePath: artifactPaths.download,
          kind: "download",
          mimeType: "application/zip",
          body: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]),
        },
        {
          relativePath: artifactPaths.restricted,
          kind: "restrictedRaw.trace",
          mimeType: "application/zip",
          body: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x09, 0x09]),
          restricted: true,
        },
      ],
    },
  ]);
}

/**
 * A failed first Attempt and a passed retry whose step cites a path that only the first
 * Attempt's bundle holds, with a failed gate: the retry never erases the first result.
 */
export function seedRetryRun(scope: RunsScope, testId: string): Promise<SeededRun> {
  return seed(
    scope,
    testId,
    [
      {
        outcome: "failed",
        steps: [
          {
            stepId: "get-health",
            status: "failed",
            reasonCode: "assertion_mismatch",
            expected: { title: "Welcome" },
            observed: { title: "Sign in" },
            evidence: ["screenshots/first.png"],
          },
        ],
        artifacts: [
          {
            relativePath: "screenshots/first.png",
            kind: "screenshot",
            mimeType: "image/png",
            body: pngBytes,
          },
        ],
      },
      {
        outcome: "passed",
        steps: [
          {
            stepId: "get-health",
            status: "passed",
            expected: { title: "Welcome" },
            observed: { title: "Welcome" },
            evidence: ["screenshots/first.png"],
          },
        ],
        artifacts: [
          {
            relativePath: "screenshots/second.png",
            kind: "screenshot",
            mimeType: "image/png",
            body: pngBytes,
          },
        ],
      },
    ],
    { gate: "failed" },
  );
}

export function seedCleanupFailedRun(scope: RunsScope, testId: string): Promise<SeededRun> {
  return seed(
    scope,
    testId,
    [{ outcome: "passed", steps: [{ stepId: "get-health", status: "passed" }] }],
    { cleanupOutcome: "failed" },
  );
}

export function seedPassedRun(scope: RunsScope, testId: string): Promise<SeededRun> {
  return seed(scope, testId, [
    { outcome: "passed", steps: [{ stepId: "get-health", status: "passed" }] },
  ]);
}

export function seedFailedRun(scope: RunsScope, testId: string): Promise<SeededRun> {
  return seed(scope, testId, [
    {
      outcome: "failed",
      steps: [{ stepId: "get-health", status: "failed", reasonCode: "assertion_mismatch" }],
    },
  ]);
}

/** Admitted, claimed, mid-execution: never completed. */
export function seedLiveRun(scope: RunsScope, testId: string): Promise<SeededRun> {
  return seed(
    scope,
    testId,
    [{ outcome: "passed", steps: [{ stepId: "get-health", status: "passed" }] }],
    { complete: false },
  );
}

export const secretToken = "tok_live_9f2c7e41d0b84a6c";

/** A Run whose first step observed a secret and whose second observed ordinary data. */
export function seedObservedRun(scope: RunsScope, testId: string): Promise<SeededRun> {
  return seed(scope, testId, [
    {
      outcome: "passed",
      steps: [
        { stepId: "get-health", status: "passed", observed: { token: secretToken } },
        { stepId: "check-status", status: "passed", observed: { status: 200 } },
      ],
    },
  ]);
}
