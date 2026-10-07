import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { expect, it } from "vitest";

interface Target {
  file: string;
  name: string;
}
interface Mutation {
  id: string;
  invariant: string;
  file: string;
  original: string;
  replacement: string;
  target: Target;
  rationale: string;
  expectedFailure: RegExp;
  preexistingTarget?: Target;
  equivalent?: boolean;
}
interface Observation {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  passedTests: number;
  failures: { name: string; messages: string[] }[];
  setupFailure: boolean;
}
const recursive = {
  file: "packages/application/src/ai/healing.test.ts",
  name: "healing seals nested assertions, response status predicates and enclosing frame identity",
};
const patch = {
  file: "packages/application/src/ai/healing.test.ts",
  name: "healing rejects forbidden paths, overlapping replacements, duplicate recursive IDs and absent fields",
};
const actionInputs = {
  file: "tools/src/github-action/inputs.test.ts",
  name: "rejects shell injection IDs, credential URLs, wrong SHA, unknown inputs and floating manifests",
};
const mutations: Mutation[] = [
  {
    id: "m3-frame-assertion",
    invariant: "Recursive assertion protection: frame children",
    file: "packages/planner/src/agent/index.ts",
    original:
      'else if (step.operation === "frame") visit(step.input.childSteps, [...frames, step.id]);',
    replacement: 'else if (step.operation === "frame") continue;',
    target: recursive,
    expectedFailure: /did not throw|to throw/i,
    rationale:
      "Omitting frame traversal permits removal of the nested required business assertion.",
  },
  {
    id: "m3-response-predicate",
    invariant: "Recursive assertion protection: response-wait status",
    file: "packages/planner/src/agent/index.ts",
    original: "protectedFields.push({ frames, responseWait: step });",
    replacement: "continue;",
    target: recursive,
    expectedFailure: /did not throw|to throw/i,
    rationale: "Omitting response-wait protection permits changing the required readiness status.",
  },
  {
    id: "m3-patch-allowlist",
    invariant: "Healing patch path allowlist",
    file: "packages/application/src/ai/healing-patch.ts",
    original:
      "const replacement = healingReplacements(step).find((entry) => entry.path === change.path);",
    replacement:
      "const replacement = healingReplacements(step).find((entry) => entry.path === change.path) ?? { path: change.path, valueShape: null, manualOnly: false };",
    target: {
      file: "packages/application/src/ai/healing-mask.test.ts",
      name: "refuses an otherwise schema-valid request method change outside the healing path allowlist",
    },
    preexistingTarget: patch,
    expectedFailure: /did not throw|to throw/i,
    rationale:
      "A schema-valid GET-to-POST setup change is not an authorized patch; schema validation and assertion sealing alone do not reject it.",
  },
  {
    id: "m3-masked-comparison",
    invariant: "Healing whole-plan masked comparison",
    file: "packages/application/src/ai/healing-patch.ts",
    original:
      'if (semanticHash(maskedBase) !== semanticHash(maskedCandidate))\n    throw new ContractError("POLICY_DENIED", "Healing changed protected plan content");',
    replacement: "void maskedCandidate;",
    target: {
      file: "packages/application/src/ai/healing.test.ts",
      name: "business input replacements require manual review and retain all protected plan content",
    },
    equivalent: true,
    expectedFailure: /never-match/,
    rationale:
      "Equivalent for this single-site mutation: candidate is a structuredClone(base); the only writes are replace(candidateSteps.get(step.id), change.path, change.value) after unique-ID, overlap, existing-field and path-allowlist checks. validate returns the same candidate without coercion/defaults. Masking those exact replacement paths on both clones therefore necessarily restores equal plans. There is no external candidate input or other unmasked write. This does not classify the comparison as unnecessary under future implementation changes.",
  },
  {
    id: "m3-terminal-run",
    invariant: "Terminal Run immutability",
    file: "packages/persistence/migrations/sqlite/0001_initial.sql",
    original:
      "CREATE TRIGGER runs_terminal BEFORE UPDATE ON runs WHEN OLD.phase='completed' AND (NEW.phase<>OLD.phase OR NEW.outcome<>OLD.outcome OR NEW.status<>OLD.status OR NEW.data_json<>OLD.data_json) BEGIN SELECT RAISE(ABORT,'terminal_immutable'); END;",
    replacement: "-- Mutation: terminal Run updates are permitted.",
    target: {
      file: "packages/persistence/src/persistence.test.ts",
      name: "constraint fixture: valid terminal and immutable verdict",
    },
    expectedFailure: /expected 'accept' to be 'check'/,
    rationale:
      "The direct-SQL fixture first finalizes a failed Run then attempts to rewrite its verdict. Fresh disposable databases compute migration checksums from their copied bytes; any checksum/setup refusal is invalid, not killed.",
  },
  {
    id: "m3-download-sha",
    invariant: "CI publication SHA binding: workflow assessed head",
    file: "tools/src/github-action/download.ts",
    original: "run.head_sha !== input.assessedSha ||",
    replacement: "false ||",
    target: {
      file: "tools/src/github-action/download.test.ts",
      name: "refuses a workflow head SHA mismatch or unsupported event before artifact access",
    },
    preexistingTarget: actionInputs,
    expectedFailure: /POLICY_DENIED|Workflow SHA\/event differs/,
    rationale:
      "A workflow bound to the merge checkout instead of the assessed head must refuse before further artifact access. Pre-existing input tests do not import the downloader.",
  },
  {
    id: "m3-publisher-sha",
    invariant: "CI publication SHA binding: envelope assessed and checkout identity",
    file: "tools/src/github-action/publisher.ts",
    original:
      "envelope.result.provenance.assessedSha !== input.sha ||\n    envelope.result.provenance.checkoutSha !== input.checkoutSha",
    replacement: "false",
    target: {
      file: "tools/src/github-action/publisher.test.ts",
      name: "refuses assessed SHA, checkout SHA and report hash mismatch before opening a publisher workspace",
    },
    preexistingTarget: actionInputs,
    expectedFailure: /POLICY_DENIED|Downloaded CI artifact differs|not.*called/s,
    rationale:
      "Removing both envelope SHA comparisons allows an immutable result to be published under a different identity. The new killer invokes the real source-backed validator and publisher, without rebuilding the paid-evaluation runtime.",
  },
  {
    id: "m3-comparison-redaction",
    invariant: "Secret-derived comparisons are omitted",
    file: "packages/runner/src/runtime.ts",
    original:
      "value === undefined || Buffer.byteLength(value) > 8192 || this.scrub(value) !== value,",
    replacement: "value === undefined || Buffer.byteLength(value) > 8192,",
    target: {
      file: "packages/runner/src/browser.test.ts",
      name: "retains business assertion values for diagnosis but omits secret-derived and oversized comparisons",
    },
    expectedFailure: /observed|private-business-value/,
    rationale:
      "Ordinary comparisons remain available, but a secret-derived observed value must never enter step.finished diagnostic evidence.",
  },
  {
    id: "m3-fixture-context",
    invariant: "Evaluation fixture exact patch validity",
    file: "tools/src/evals/m3.ts",
    original: "if (!patch.before || source.split(patch.before).length !== 2)",
    replacement: "if (!patch.before)",
    target: {
      file: "tools/src/evals/m3.test.ts",
      name: "rejects an absent exact context rather than substituting another patch",
    },
    expectedFailure: /did not throw|to throw/i,
    rationale:
      "Removing exact-occurrence validation silently accepts an absent patch context; the killer exercises the validator directly, independent of any registration's frozen-file integrity.",
  },
  {
    id: "m3-absent-json",
    invariant: "Absent asserted JSON target fails",
    file: "packages/runner/src/http.ts",
    original: "matches = target.present && isDeepStrictEqual(observed, expected);",
    replacement: "matches = isDeepStrictEqual(observed, expected);",
    target: {
      file: "packages/runner/src/http.test.ts",
      name: "fails assertions whose JSON target is absent from a complete response",
    },
    expectedFailure: /promise resolved|rejects/i,
    rationale:
      "An absent JSON pointer yields null as its diagnostic value, but must not satisfy an expected-null business assertion.",
  },
  {
    id: "m3-unsafe-upstream-effect",
    invariant: "Sent owned-resource mutation remains retry-unsafe on upstream failure",
    file: "packages/runner/src/http.ts",
    original: 'resource && sent ? "retry_unsafe_external_effect" : "insufficient_evidence",',
    replacement: '"insufficient_evidence",',
    target: {
      file: "packages/runner/src/http.test.ts",
      name: "keeps a target the egress proxy could not reach inconclusive with its socket error code",
    },
    expectedFailure:
      /retry_unsafe_external_effect.*insufficient_evidence|insufficient_evidence.*retry_unsafe_external_effect/s,
    rationale:
      "After the mutating owned-resource request was sent, a proxy ECONNRESET cannot establish that the effect never occurred; the existing real HTTP proxy fixture distinguishes read and write reasons.",
  },
  {
    id: "m3-analysis-source-target",
    invariant: "Fix targets resolve only to authorized source evidence",
    file: "packages/application/src/ai/analysis.ts",
    original: "if (output.fixTargetHandle !== null && !fixTarget?.codeSnapshotId)",
    replacement: "if (output.fixTargetHandle !== null && !fixTarget)",
    target: {
      file: "packages/application/src/ai/analysis.test.ts",
      name: "execution handles cannot be promoted to source fix targets",
    },
    expectedFailure: /expected false to be true/,
    rationale:
      "Accepting any supplied handle lets an execution artifact become a persisted source fix target without a code snapshot binding.",
  },
  {
    id: "m3-license-asset",
    invariant: "Runtime installation requires the shipped license assets",
    file: "tools/src/distribution/install.ts",
    original: "if (!value.files.some((file) => file.path === asset && file.size > 0))",
    replacement: "if (false)",
    target: {
      file: "tools/src/distribution/distribution.test.ts",
      name: "refuses a hash-pinned manifest that omits the original LICENSE",
    },
    expectedFailure: /to throw/i,
    rationale:
      "A hash-pinned manifest is otherwise self-consistent; only the explicit asset check refuses a runtime stripped of its Apache-2.0 license.",
  },
];
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

it("kills M3 critical mutations in source-isolated copies and retains equivalent and pre-killer observations", async () => {
  const started = Date.now();
  const root = resolve(".");
  const temporary = await mkdtemp(join(tmpdir(), "tm-m3-mutations-"));
  const observations: Record<string, unknown>[] = [];
  let sequence = 0;
  let healthy: Observation | undefined;
  const targets = [
    ...mutations.flatMap((mutation) => [
      mutation.target,
      ...(mutation.preexistingTarget ? [mutation.preexistingTarget] : []),
    ]),
    {
      file: "tools/src/github-action/download.test.ts",
      name: "accepts matching assessed head for dispatch and same-repository pull request before job lookup",
    },
  ];
  const testFiles = new Set(targets.map((target) => target.file));
  const healthyTestCount = new Set(targets.map((target) => `${target.file}:${target.name}`)).size;

  async function run(selected: Target[]): Promise<Observation> {
    const begin = Date.now();
    const report = join(temporary, `mutation-report-${++sequence}.json`);
    const completed = Promise.withResolvers<{ code: number | null; signal: string | null }>();
    const child = spawn(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "--project",
        "unit",
        "--maxWorkers",
        "1",
        "--no-file-parallelism",
        "--reporter",
        "default",
        "--reporter",
        "json",
        "--outputFile",
        report,
        ...new Set(selected.map((target) => target.file)),
        "-t",
        selected.map((target) => escapeRegex(target.name)).join("|"),
      ],
      {
        cwd: temporary,
        env: {
          ...process.env,
          QUANTFORGE_API_KEY: "",
          TESTMASTER_MODEL_API_KEY: "",
          TESTMASTER_OFFLINE: "true",
          CI: "true",
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let timedOut = false;
    // Real subprocess watchdog: fake time cannot terminate a hung external Vitest process.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 120_000);
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (bytes) => {
        output = (output + String(bytes)).slice(-131072);
      });
    child.once("error", completed.reject);
    child.once("close", (code, signal) => completed.resolve({ code, signal }));
    try {
      const exit = await completed.promise;
      const result = JSON.parse(await readFile(report, "utf8").catch(() => "{}")) as {
        numPassedTests?: number;
        testResults?: {
          message?: string;
          assertionResults?: { fullName: string; status: string; failureMessages: string[] }[];
        }[];
      };
      const failures = (result.testResults ?? []).flatMap((file) =>
        (file.assertionResults ?? [])
          .filter((assertion) => assertion.status === "failed")
          .map((assertion) => ({ name: assertion.fullName, messages: assertion.failureMessages })),
      );
      const setupFailure =
        timedOut ||
        !result.testResults?.length ||
        /Failed Suites|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|Transform failed|Migration.*checksum|SyntaxError|Parse failure/.test(
          output,
        ) ||
        (exit.code !== 0 && failures.length === 0);
      return {
        ...exit,
        timedOut,
        durationMs: Date.now() - begin,
        output,
        passedTests: result.numPassedTests ?? 0,
        failures,
        setupFailure,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  function classify(mutation: Mutation, observation: Observation) {
    if (observation.setupFailure) return "invalid";
    if (observation.code === 0 && observation.passedTests > 0)
      return mutation.equivalent ? "equivalent" : "survived";
    const killing = observation.failures.filter(
      (failure) =>
        failure.name.includes(mutation.target.name) &&
        mutation.expectedFailure.test(`${failure.messages.join("\n")}\n${observation.output}`),
    );
    return observation.code === 1 && killing.length > 0 ? "killed" : "invalid";
  }

  try {
    // Copy the package source closure, never any built runtime or dependency installation.
    const packages = await readdir(join(root, "packages"));
    for (const name of packages) {
      for (const path of [
        "src",
        "package.json",
        "tsconfig.json",
        "migrations",
        "schemas",
        "skill-content",
      ])
        await cp(join(root, "packages", name, path), join(temporary, "packages", name, path), {
          recursive: true,
          filter: (source) =>
            !source.endsWith(".test.ts") || testFiles.has(source.slice(root.length + 1)),
        }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
    }
    for (const path of [
      "vitest.config.ts",
      "tsconfig.base.json",
      "tsconfig.json",
      "package.json",
      "tools/package.json",
      "tools/tsconfig.json",
    ])
      await cp(join(root, path), join(temporary, path));
    for (const path of [
      "tools/src/github-action/inputs.ts",
      "tools/src/github-action/download.ts",
      "tools/src/github-action/publisher.ts",
      "tools/src/distribution/archive.ts",
      "tools/src/distribution/install.ts",
      "tools/src/distribution/package.ts",
      "tools/src/distribution/licenses.ts",
      "tools/src/distribution/sources.ts",
      "tools/src/distribution/browser-sources.ts",
      "tools/src/distribution/python-sources.ts",
      "tools/src/evals/freeze.ts",
      "tools/src/evals/m3.ts",
      "tools/src/evals/m3-scoring.ts",
      // m3.ts imports the fixture driver, which imports the reference-shop oracle.
      "evals/m3/fixture.mjs",
      "fixtures/reference-shop/oracle/index.js",
      ...testFiles,
    ]) {
      await mkdir(dirname(join(temporary, path)), { recursive: true });
      await cp(join(root, path), join(temporary, path));
    }
    for (const name of ["mcp", "server", "cli"]) {
      await mkdir(join(temporary, "apps", name), { recursive: true });
      await cp(
        join(root, "apps", name, "tsconfig.json"),
        join(temporary, "apps", name, "tsconfig.json"),
      );
    }
    await symlink(join(root, "node_modules"), join(temporary, "node_modules"), "dir");
    // Workspace package links MUST point into the disposable tree, not the main checkout.
    // External dependencies remain read-only links to the installed package store.
    for (const directory of ["tools", ...packages.map((name) => `packages/${name}`)]) {
      const dependencies = join(root, directory, "node_modules");
      for (const entry of await readdir(dependencies).catch(() => [] as string[])) {
        if (entry.startsWith(".")) continue;
        const names = entry.startsWith("@")
          ? (await readdir(join(dependencies, entry))).map((name) => `${entry}/${name}`)
          : [entry];
        for (const name of names) {
          const destination = join(temporary, directory, "node_modules", name);
          const original = await realpath(join(dependencies, name));
          const workspace = original.startsWith(`${root}${sep}packages${sep}`);
          await mkdir(dirname(destination), { recursive: true });
          await symlink(
            workspace ? join(temporary, "packages", basename(original)) : original,
            destination,
            "dir",
          );
        }
      }
    }
    healthy = await run(targets);
    if (healthy.code === 0 && !healthy.setupFailure && healthy.passedTests > 0) {
      for (const mutation of mutations) {
        const path = join(temporary, mutation.file);
        const original = await readFile(path, "utf8");
        const occurrences = original.split(mutation.original).length - 1;
        const row: Record<string, unknown> = {
          id: mutation.id,
          invariant: mutation.invariant,
          file: mutation.file,
          original: mutation.original,
          replacement: mutation.replacement,
          targetedTestFiles: [mutation.target.file],
          targetedTestNames: [mutation.target.name],
          occurrences,
          rationale: mutation.rationale,
        };
        if (occurrences !== 1) {
          observations.push({
            ...row,
            outcome: "invalid",
            failureExcerpt: `Source drift: expected exactly one original snippet, found ${occurrences}`,
          });
          continue;
        }
        await writeFile(path, original.replace(mutation.original, mutation.replacement));
        try {
          if (mutation.preexistingTarget) {
            const beforeKiller = await run([mutation.preexistingTarget]);
            row.preexistingObservation = beforeKiller;
            row.survivedBeforeKiller =
              beforeKiller.code === 0 && !beforeKiller.setupFailure && beforeKiller.passedTests > 0;
          }
          const observation = await run([mutation.target]);
          const outcome = classify(mutation, observation);
          observations.push({
            ...row,
            outcome,
            observation,
            killingTestNames:
              outcome === "killed" ? observation.failures.map((failure) => failure.name) : [],
            failureExcerpt: observation.failures
              .map((failure) => failure.messages.join("\n"))
              .join("\n")
              .slice(-16384),
            ...(outcome === "invalid"
              ? {
                  invalidReason:
                    "Subprocess setup/import failure, deadline, or failure did not match the intended protected assertion",
                }
              : {}),
          });
        } finally {
          await writeFile(path, original);
        }
      }
    }
    const passed =
      healthy.code === 0 &&
      !healthy.setupFailure &&
      healthy.passedTests > 0 &&
      observations.length === mutations.length &&
      observations.every((row) => row.outcome === "killed" || row.outcome === "equivalent");
    await mkdir(join(root, "validation/results"), { recursive: true });
    await writeFile(
      join(root, "validation/results/m3-critical-mutations.json"),
      JSON.stringify(
        {
          schemaVersion: "1.0.0",
          method: "automatic-source-isolated-subprocess",
          observedAt: new Date().toISOString(),
          passed,
          durationMs: Date.now() - started,
          healthy,
          n: mutations.length,
          killed: observations.filter((row) => row.outcome === "killed").length,
          survivors: observations.filter((row) => row.outcome === "survived").map((row) => row.id),
          invalid: observations.filter((row) => row.outcome === "invalid").map((row) => row.id),
          equivalent: observations
            .filter((row) => row.outcome === "equivalent")
            .map((row) => row.id),
          observations,
          limitations: [
            "Targeted deterministic unit controls, not live model-quality or hosted GitHub proof.",
            "Equivalent masked-comparison classification applies only to the current pure replacement implementation.",
          ],
        },
        null,
        2,
      ),
    );
    expect(healthy.code, healthy.output).toBe(0);
    expect(healthy.setupFailure, healthy.output).toBe(false);
    expect(healthy.passedTests).toBe(healthyTestCount);
    expect(observations).toHaveLength(mutations.length);
    for (const row of observations) {
      expect(row.occurrences, `${row.id}: source drift`).toBe(1);
      expect(
        ["killed", "equivalent"],
        `${row.id}: ${row.outcome}\n${row.failureExcerpt ?? ""}`,
      ).toContain(row.outcome);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 600_000);
