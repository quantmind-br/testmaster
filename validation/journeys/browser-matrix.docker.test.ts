import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Application } from "@testmaster/application";
import { type ExecutablePlan, type PlanStep, validate } from "@testmaster/contracts";
import { semanticHash, uuidV7IdGenerator } from "@testmaster/domain";
import { startShop } from "@testmaster/reference-shop";
import { expect, it } from "vitest";
import { FileEvidenceStore } from "../../packages/evidence/src/index.js";
import type { AttemptResult } from "../../packages/sandbox/src/index.js";
import { AttemptExecutor } from "../../packages/sandbox/src/index.js";
import {
  action,
  assertion,
  controlledShop,
  eventually,
  executable,
  files,
  journey,
  literal,
  locator,
  text,
} from "./harness.js";

const command = promisify(execFile);
interface AttemptFixture {
  root: string;
  result: AttemptResult;
  ids: {
    workspaceId: string;
    runId: string;
    attemptId: string;
    revisionId: string;
    snapshotId: string;
  };
  read(path: string): Promise<Buffer>;
  dispose(): Promise<void>;
}
async function attempt(
  url: string,
  plan: ExecutablePlan,
  options: {
    policy?: Record<string, unknown>;
    cancel?: boolean;
    secret?: string;
    artifactRef?: string;
    upload?: Buffer;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "tm-matrix-"));
  const inputDir = join(root, "input");
  await mkdir(inputDir);
  await mkdir(join(root, "runtime"));
  const ids = {
    workspaceId: uuidV7IdGenerator.next("ws"),
    runId: uuidV7IdGenerator.next("run"),
    attemptId: uuidV7IdGenerator.next("att"),
    revisionId: uuidV7IdGenerator.next("rev"),
    snapshotId: uuidV7IdGenerator.next("snp"),
  };
  const secretRef = uuidV7IdGenerator.next("sec");
  const prepared = JSON.parse(JSON.stringify(plan).replaceAll("SECRET_REFERENCE", secretRef));
  validate("ExecutablePlan", prepared);
  const lock = JSON.parse(await readFile("containers/images.lock.json", "utf8"));
  const signal = new AbortController();
  if (options.upload) await writeFile(join(inputDir, "upload.bin"), options.upload);
  const result = await new AttemptExecutor(
    new FileEvidenceStore({ rootDir: join(root, "evidence") }),
    undefined,
    join(root, "runtime"),
  ).execute(
    {
      ...ids,
      inputDir,
      kind: plan.runner === "http" ? "http" : "browser",
      imageId: lock["testmaster-runner"].imageId,
      plan: prepared,
      networkPolicy: { allowedOrigins: [url], networkProfile: "local-loopback", baseUrl: url },
      runnerInput: {
        baseUrl: url,
        stepTimeoutMs: 5000,
        policy: options.policy ?? {},
        ...(options.upload && options.artifactRef
          ? {
              artifacts: {
                [options.artifactRef]: {
                  path: "upload.bin",
                  mimeType: "application/octet-stream",
                  sizeBytes: options.upload.length,
                },
              },
            }
          : {}),
      },
      secretRefs: options.secret
        ? [{ secretRef, secretVersion: 1, resolve: async () => options.secret as string }]
        : [],
      seccompPath: join(process.cwd(), "containers/seccomp_profile.json"),
      attemptTimeoutMs: 60000,
      cancellationGraceMs: 1000,
      onEvent: async (event) => {
        if (options.cancel && event.type === "step.started" && event.payload.stepId === "wait")
          signal.abort();
      },
    },
    signal.signal,
  );
  return {
    root,
    result,
    ids,
    read: async (path: string) => readFile(join(result.bundle?.bundleDir ?? "", path)),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
const login = (): PlanStep[] => [
  action("open", "navigate", { path: "/login" }),
  action("password", "fill", {
    locator: locator("password"),
    value: { secretRef: "SECRET_REFERENCE" },
  }),
  action("login", "click", {
    locator: { by: "role", role: "button", name: "Sign in", exact: true },
  }),
  action("ready", "waitFor", {
    locator: locator("catalog-ready"),
    state: "visible",
    deadlineMs: 5000,
  }),
];
it("captures real frame, popup, upload/download, hook/wait and opt-in evidence channels", async () => {
  await journey("browser-channel-matrix", async (session) => {
    const shop = await startShop({ port: 0 });
    const upload = Buffer.from("independent-profile-roundtrip-012345");
    const artifactRef = uuidV7IdGenerator.next("art");
    const steps = [
      ...login(),
      action("add", "click", { locator: locator("add-p1") }),
      assertion("added", { locator: locator("toast") }, "textEquals", "Added to cart"),
      action("cart", "navigate", { path: "/cart" }),
      action("frame", "frame", {
        locator: { by: "css", value: "iframe[title='Delivery options']" },
        childSteps: [
          action("select-delivery", "select", {
            locator: locator("delivery-option"),
            values: [{ label: literal("Express") }],
          }),
          action("confirm-delivery", "click", {
            locator: { by: "role", role: "button", name: "Confirm delivery", exact: true },
          }),
          assertion(
            "delivery-confirmed",
            { locator: { by: "css", value: "output" } },
            "textEquals",
            "Confirmed",
          ),
        ],
      }),
      action("terms", "click", {
        locator: { by: "role", role: "link", name: "Terms", exact: true },
      }),
      assertion(
        "popup",
        { locator: { ...locator("terms"), pageAlias: "terms" } },
        "textEquals",
        "Synthetic products only.",
      ),
      action("profile", "navigate", { path: "/profile" }),
      action("upload", "upload", {
        locator: locator("profile-upload"),
        artifactRefs: [artifactRef],
      }),
      assertion(
        "uploaded",
        { locator: locator("upload-size") },
        "textEquals",
        String(upload.length),
      ),
      action("download", "download", {
        trigger: { operation: "click", input: { locator: locator("profile-download") } },
        outputName: "profile.bin",
      }),
      {
        id: "roundtrip",
        kind: "assertion",
        operation: "assert",
        description: "Independent byte hash",
        input: { outputName: "profile.bin" },
        expectation: {
          predicate: "downloadMatches",
          outputName: "profile.bin",
          sha256: createHash("sha256").update(upload).digest("hex"),
          sizeBytes: upload.length,
        },
      } as PlanStep,
    ];
    let run: AttemptFixture | undefined;
    try {
      run = await attempt(
        shop.url,
        executable("Full browser channel matrix", "playwright", steps),
        {
          secret: "correct-password",
          upload,
          artifactRef,
          policy: {
            allowFrames: true,
            popupAliases: ["terms"],
            allowUploads: true,
            allowDownloads: true,
            trace: true,
            video: true,
            restrictedRaw: true,
          },
        },
      );
      const finished = run.result.events.filter(
        (event) => event.type === "step.finished" || event.type === "runner.finished",
      );
      expect(run.result.outcome, JSON.stringify(finished)).toBe("passed");
      expect(await run.read("browser/downloads/profile.bin")).toEqual(upload);
      const manifest = JSON.parse((await run.read("manifest.json")).toString());
      for (const kind of [
        "dom",
        "screenshot",
        "console",
        "locator-evidence",
        "network",
        "download",
        "restrictedRaw.trace",
        "restrictedRaw.video",
      ])
        expect(
          manifest.entries.some(
            (e: { kind: string; state: string; sizeBytes: number }) =>
              e.kind === kind && e.state === "available" && e.sizeBytes > 0,
          ),
          kind,
        ).toBe(true);
      for (const step of steps) {
        const locatorCount =
          step.operation === "drag"
            ? 2
            : step.operation === "download" || "locator" in step.input
              ? 1
              : 0;
        for (let index = 0; index < locatorCount; index++)
          for (const phase of ["before", "after"]) {
            const path = `browser/steps/${step.id}-locator-${index}-${phase}.json`;
            const bytes = await run.read(path);
            const record = JSON.parse(bytes.toString());
            const { evidenceHash, ...payload } = record;
            expect(record).toMatchObject({ schemaVersion: "1.0.0", stepId: step.id, phase });
            expect(evidenceHash).toBe(semanticHash(payload));
            expect(record.candidates.length).toBeLessThanOrEqual(100);
            expect(bytes.toString()).not.toContain("correct-password");
            for (const candidate of record.candidates) {
              expect(candidate.attributes).not.toHaveProperty("value");
              expect(
                Object.keys(candidate.attributes).some((key) =>
                  /token|secret|password|authorization|cookie|^on/iu.test(key),
                ),
              ).toBe(false);
              if (candidate.type === "password") {
                expect(candidate.attributes).toEqual({});
                expect(candidate.name).toBe("");
              }
            }
          }
      }
      const nestedLocator = JSON.parse(
        (await run.read("browser/steps/confirm-delivery-locator-0-before.json")).toString(),
      );
      expect(nestedLocator.cardinality).toBe(1);
      const waitLocator = JSON.parse(
        (await run.read("browser/steps/ready-locator-0-after.json")).toString(),
      );
      expect(waitLocator.state.requested).toBe("visible");
      expect(
        waitLocator.state.transitions.some((state: { visible: boolean }) => state.visible),
      ).toBe(true);
      expect(
        manifest.entries.some(
          (entry: { kind: string; state: string }) =>
            entry.kind === "log" && entry.state === "available",
        ),
      ).toBe(true);
      expect((await run.read("browser/console.json")).toString()).toContain("profile-ready");
      expect((await run.read("browser/network.json")).toString()).toContain("/api/profile/file");
      const token = (await fetch(`${shop.url}/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "correct-password" }),
      }).then((r) => r.json())) as { token: string };
      const independent = await fetch(`${shop.url}/profile/file`, {
        headers: { authorization: `Bearer ${token.token}` },
      });
      expect(Buffer.from(await independent.arrayBuffer())).toEqual(upload);
      session.oracles.push({
        check: "independent raw HTTP uploaded bytes",
        passed: true,
        size: upload.length,
        sha256: createHash("sha256").update(upload).digest("hex"),
      });
      session.runIds.push(run.ids.runId);
    } finally {
      await run?.dispose();
      await shop.close();
    }
  });
}, 120000);

it("fails real ambiguous hooks and denies unauthorized frames without raw collection", async () => {
  const shop = await startShop({ port: 0 });
  try {
    for (const [operation, expected] of [
      ["ambiguous", "failed"],
      ["frame", "blocked"],
    ] as const) {
      const steps =
        operation === "ambiguous"
          ? [
              action("open", "navigate", { path: "/login" }),
              action("ambiguous", "click", { locator: { by: "css", value: "nav a" } }),
              assertion("never", { locator: locator("password") }, "visible"),
            ]
          : [
              action("open", "navigate", { path: "/widget" }),
              action("frame", "frame", {
                locator: { by: "css", value: "body" },
                childSteps: [
                  assertion("nested", { locator: locator("delivery-option") }, "visible"),
                ],
              }),
              assertion("never", { locator: locator("delivery-option") }, "visible"),
            ];
      const run = await attempt(shop.url, executable(operation, "playwright", steps));
      try {
        expect(run.result.outcome).toBe(expected);
        const manifest = JSON.parse((await run.read("manifest.json")).toString());
        expect(
          manifest.entries.some((e: { kind: string }) => e.kind.startsWith("restrictedRaw.")),
        ).toBe(false);
      } finally {
        await run.dispose();
      }
    }
  } finally {
    await shop.close();
  }
}, 120000);

it("closes the real browser container when cancelled during a deterministic wait", async () => {
  const shop = await startShop({ port: 0 });
  const run = await attempt(
    shop.url,
    executable("Cancel mid wait", "playwright", [
      action("open", "navigate", { path: "/login" }),
      action("wait", "waitFor", {
        locator: locator("never-appears"),
        state: "visible",
        deadlineMs: 30000,
      }),
      assertion("never", { locator: locator("password") }, "visible"),
    ]),
    { cancel: true },
  );
  try {
    expect(["cancelled", "inconclusive"]).toContain(run.result.outcome);
    expect(
      run.result.events.some(
        (e) =>
          e.type === "step.finished" &&
          e.payload.stepId === "never" &&
          e.payload.status === "passed",
      ),
    ).toBe(false);
    const containers = await command("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=io.testmaster.attempt=${run.ids.attemptId}`,
    ]);
    expect(containers.stdout.trim()).toBe("");
  } finally {
    await run.dispose();
    await shop.close();
  }
}, 90000);

const staticCredentials = {
  none: undefined,
  basic: ["authorization", `Basic ${Buffer.from("synthetic:password").toString("base64")}`],
  bearer: ["authorization", "Bearer synthetic-bearer"],
  "api-key": ["x-api-key", "synthetic-api-key"],
  header: ["x-shop-auth", "synthetic-header"],
  cookie: ["cookie", "shop-session=synthetic-cookie"],
} as const;
function httpPlan(path: string, status: number, header?: string): ExecutablePlan {
  return executable(path, "http", [
    action("request", "request", {
      method: "GET",
      pathSegments: path.split("/").filter(Boolean).map(literal),
      ...(header ? { headers: { [header]: { secretRef: "SECRET_REFERENCE" } } } : {}),
    }),
    {
      id: "status",
      description: "Assert response status",
      kind: "assertion",
      operation: "assert",
      input: { responseStepId: "request" },
      expectation: { predicate: "statusIn", values: [status] },
    },
  ]);
}
it("executes all six static authentication bindings against independent HTTP oracles", async () => {
  const shop = await startShop({ port: 0 });
  try {
    for (const [kind, credential] of Object.entries(staticCredentials)) {
      const path = `/acceptance/auth/${kind}`;
      const control = await fetch(`${shop.url}${path}`, {
        headers: credential ? { [credential[0]]: credential[1] } : {},
      });
      expect(control.status).toBe(200);
      if (credential) expect((await fetch(`${shop.url}${path}`)).status).toBe(401);
      const run = await attempt(
        shop.url,
        httpPlan(path, 200, credential?.[0]),
        credential ? { secret: credential[1] } : {},
      );
      try {
        expect(run.result.outcome, kind).toBe("passed");
        if (credential)
          expect((await run.read("http/request.json")).toString()).not.toContain(credential[1]);
      } finally {
        await run.dispose();
      }
    }
  } finally {
    await shop.close();
  }
}, 180000);
it("distinguishes expected401, missing-auth oracle mismatch, expired-token auth, HTTP500 and transport loss", async () => {
  const shop = await startShop({ port: 0 });
  try {
    for (const [path, status, secret, outcome, reason] of [
      ["/acceptance/auth/bearer", 401, undefined, "passed", "assertions_satisfied"],
      ["/acceptance/auth/bearer", 200, undefined, "failed", "assertion_mismatch"],
      [
        "/acceptance/auth/bearer",
        200,
        "Bearer expired-synthetic-token",
        "blocked",
        "manual_auth_required",
      ],
      [
        "/acceptance/auth/bearer",
        401,
        "Bearer expired-synthetic-token",
        "passed",
        "assertions_satisfied",
      ],
      ["/acceptance/server-error", 200, undefined, "failed", "assertion_mismatch"],
      ["/acceptance/transport", 200, undefined, "inconclusive", "insufficient_evidence"],
    ] as const) {
      const run = await attempt(
        shop.url,
        httpPlan(path, status, secret ? "authorization" : undefined),
        secret ? { secret } : {},
      );
      try {
        expect(run.result.outcome, path).toBe(outcome);
        expect(run.result.reasonCode).toBe(reason);
        if (path.endsWith("server-error")) {
          const response = JSON.parse((await run.read("http/request.json")).toString());
          expect(response.response.status).toBe(500);
          expect(response.response.bodyMetadata).toEqual({
            sha256: createHash("sha256")
              .update(
                JSON.stringify({ error: "deliberate_server_error", retained: "response-body" }),
              )
              .digest("hex"),
            sizeBytes: Buffer.byteLength(
              JSON.stringify({ error: "deliberate_server_error", retained: "response-body" }),
            ),
            contentType: "application/json",
          });
          expect(response.response.failureExcerpt).toContain("deliberate_server_error");
          expect(response.response).not.toHaveProperty("body");
          expect(JSON.stringify(response)).not.toContain("response-body");
        }
      } finally {
        await run.dispose();
      }
    }
  } finally {
    await shop.close();
  }
}, 180000);

it("never reuses cookie/profile state between attempts or staging and production targets", async () => {
  const staging = await startShop({ port: 0 });
  const production = await startShop({ port: 0 });
  try {
    for (const url of [staging.url, staging.url, production.url]) {
      const run = await attempt(
        url,
        executable("Fresh session", "playwright", [
          action("open", "navigate", { path: "/acceptance/browser-session" }),
          assertion("fresh", { locator: locator("session-state") }, "textEquals", "fresh"),
          action("reload", "navigate", { path: "/acceptance/browser-session" }),
          assertion("same-attempt", { locator: locator("session-state") }, "textEquals", "reused"),
        ]),
      );
      try {
        expect(run.result.outcome).toBe("passed");
        for (const file of await files(run.root)) {
          expect(file).not.toMatch(/(?:storageState|profile|cookies)\.(?:json|sqlite)$/);
          expect(
            (await readFile(file)).includes(Buffer.from("synthetic-ephemeral-cookie")),
            file,
          ).toBe(false);
        }
      } finally {
        await run.dispose();
      }
    }
  } finally {
    await staging.close();
    await production.close();
  }
}, 120000);

it("expires ownership during a real browser navigation and reaps the stale browser without running the next assertion", async () => {
  await journey("browser-lease-expiry", async (session) => {
    const target = await controlledShop();
    let app: Application | undefined;
    let worker: Promise<unknown> | undefined;
    try {
      const init = await session.init(target.url);
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const test = app.tests.create({
        projectId: text(init.projectId),
        plan: executable("Lease loss", "playwright", [
          action("open", "navigate", { path: "/login" }),
          assertion("never-after-loss", { locator: locator("password") }, "visible"),
        ]),
      });
      target.hold();
      worker = app.worker.run();
      await eventually(async () => app?.worker.live(), Boolean);
      const receipt = await app.runs.admit(
        { testId: test.id, environmentId: text(init.environmentId) },
        { wait: false },
      );
      session.runIds.push(receipt.runId);
      await eventually(
        async () => target.hits(),
        (hits) => hits > 0,
      );
      const attemptRow = app.database.get("SELECT id FROM attempts WHERE run_id=?", receipt.runId);
      if (!attemptRow) throw new Error("Running attempt was not persisted");
      const name = `tm-att-${attemptRow.id}`;
      expect((await command("docker", ["top", name, "-eo", "pid,comm"])).stdout).toMatch(
        /chrome|chromium/,
      );
      app.database.run(
        "UPDATE job_leases SET lease_expires_at=? WHERE resource_id=? AND state='leased'",
        "2000-01-01T00:00:00.000Z",
        receipt.runId,
      );
      await app.worker.reconcile();
      // The real heartbeat/reconciler clock drives ownership loss; never fake a running browser's time.
      await eventually(
        async () =>
          (await command("docker", ["ps", "-aq", "--filter", `name=^${name}$`])).stdout.trim(),
        (remaining) => remaining === "",
        30000,
      );
      expect(
        app.runs
          .steps(receipt.runId)
          .some((step) => step.stepId === "never-after-loss" && step.status === "passed"),
      ).toBe(false);
      expect(app.runs.get(receipt.runId).outcome).not.toBe("passed");
      session.oracles.push({
        check: "lease loss reaps Chromium and fences next assertion",
        passed: true,
      });
    } finally {
      target.release();
      await app?.worker.drain(0);
      await worker;
      app?.close();
      await target.close();
    }
  });
}, 120000);

it("keeps browser and HTTP bodies private by default while separately authorizing explicit full-body evidence", async () => {
  const shop = await startShop({ port: 0 });
  try {
    const browser = await attempt(
      shop.url,
      executable("Browser body minimization", "playwright", [
        action("open", "navigate", { path: "/acceptance/browser-bodies" }),
        action("wait", "waitFor", {
          locator: locator("body-ready"),
          state: "visible",
          deadlineMs: 5000,
        }),
        assertion("ready", { locator: locator("body-ready") }, "textEquals", "ready"),
      ]),
    );
    try {
      expect(browser.result.outcome).toBe("passed");
      for (const file of await files(browser.result.bundle?.bundleDir ?? "")) {
        const text = (await readFile(file)).toString();
        expect(text, file).not.toMatch(
          /request-body-private-sentinel|response-body-private-sentinel|response-header-private-sentinel|header-cookie-sentinel/,
        );
      }
    } finally {
      await browser.dispose();
    }
    const plan = executable("HTTP body minimization", "http", [
      action("request", "request", {
        method: "POST",
        pathSegments: [literal("acceptance"), literal("body")],
        body: { kind: "json", value: literal({ private: "request-body-private-sentinel" }) },
      }),
      assertion(
        "business",
        { responseStepId: "request", jsonPointer: "/business" },
        "jsonEquals",
        "response-body-private-sentinel",
      ),
    ]);
    for (const optin of [false, true]) {
      const run = await attempt(shop.url, plan, {
        policy: optin ? { httpBodies: true, restrictedRaw: true } : {},
      });
      try {
        expect(run.result.outcome).toBe("passed");
        const trace = JSON.parse((await run.read("http/request.json")).toString());
        expect(trace.request).not.toHaveProperty("body");
        expect(trace.response).not.toHaveProperty("body");
        expect(trace.request.bodyMetadata.sizeBytes).toBe(
          Buffer.byteLength(JSON.stringify({ private: "request-body-private-sentinel" })),
        );
        expect(trace.response.bodyMetadata.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(trace.response.headers).not.toHaveProperty("x-private");
        const manifest = JSON.parse((await run.read("manifest.json")).toString());
        const raw = manifest.entries.find(
          (entry: { kind: string }) => entry.kind === "restrictedRaw.http",
        );
        expect(Boolean(raw)).toBe(optin);
        if (optin) {
          expect(raw.redactionStatus).toBe("restrictedRaw");
          const body = (await run.read("http/request-bodies.json")).toString();
          expect(body).toContain("request-body-private-sentinel");
          expect(body).toContain("response-body-private-sentinel");
        } else {
          for (const file of await files(run.result.bundle?.bundleDir ?? ""))
            expect((await readFile(file)).toString(), file).not.toMatch(
              /request-body-private-sentinel|response-body-private-sentinel|response-header-private-sentinel|header-cookie-sentinel/,
            );
        }
      } finally {
        await run.dispose();
      }
    }
  } finally {
    await shop.close();
  }
}, 120000);
