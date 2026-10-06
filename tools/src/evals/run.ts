import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checks, startShop } from "../../../evals/fixture.mjs";
import { assertFrozenFiles, assertRegistrationUnchanged, committedRegistration } from "./freeze.js";
import type { Pair, Proportion, Replay, TrialError, TrialScoreInput } from "./scoring.js";
import { scoreTrial, summarize } from "./scoring.js";

type Json = Record<string, unknown>;
interface Case {
  id: string;
  mutant: string;
  failureCategory: string;
  oracle: { checkName: string };
}
interface Registration {
  id: string;
  dataset: { manifest: string; sha256: string; development: string[]; holdout: string[] };
  frozenFiles: Record<string, string>;
  provider: {
    id: string;
    kind: "openai-compatible";
    baseUrl: string;
    apiKeyEnv: string;
    model: string;
  };
  decoding?: { reasoning_effort?: "low" | "medium" | "high" };
  budget: {
    maxTokens: number;
    maxWallTimeMs: number;
    perModelCommandConservativeTokens: number;
    normalizationConservativeTokens?: number;
    planConservativeTokens?: number;
  };
}
function registeredReasoningEffort(
  registration: Registration,
): "low" | "medium" | "high" | undefined {
  const decoding: unknown = registration.decoding;
  if (decoding === undefined) return undefined;
  if (decoding === null || typeof decoding !== "object" || Array.isArray(decoding))
    throw new Error("Invalid preregistered reasoning_effort");
  const effort = (decoding as Record<string, unknown>).reasoning_effort;
  if (effort === undefined) return undefined;
  if (effort !== "low" && effort !== "medium" && effort !== "high")
    throw new Error("Invalid preregistered reasoning_effort");
  return effort;
}
interface CommandRecord {
  args: string[];
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  envelope: Json | null;
  stdout: string;
  stderr: string;
}
interface TrialLedger extends TrialScoreInput {
  mutant: string;
  commands: CommandRecord[];
  decisions: Json[];
  oracleVerdicts: Json[];
  usage: Json | null;
  durationMs: number;
  workspace: string | null;
}
function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}
function rows(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(object) : [];
}
class EvaluationFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly evidence: unknown,
    readonly exclusion: TrialError["exclusion"] = null,
  ) {
    super(message);
  }
}
function deriveCommandConservativeTokens(args: string[], registration: Registration): number {
  if (args[0] === "requirement" && args[1] === "normalize") {
    if (registration.budget.normalizationConservativeTokens !== undefined) {
      return registration.budget.normalizationConservativeTokens;
    }
    if (registration.budget.perModelCommandConservativeTokens !== undefined) {
      return registration.budget.perModelCommandConservativeTokens;
    }
    throw new EvaluationFailure(
      "budget_unaccountable",
      "Cannot derive conservative upper bound for normalization before network",
      { args },
    );
  }
  if (args[0] === "plan" && args[1] === "generate") {
    return (
      registration.budget.planConservativeTokens ??
      registration.budget.perModelCommandConservativeTokens ??
      6 * (100000 + 8192)
    );
  }
  return registration.budget.perModelCommandConservativeTokens ?? 6 * (100000 + 8192);
}

export async function runEvaluation(
  root: string,
  preregistrationCommit: string,
  registrationPath = "evals/preregistration.json",
): Promise<void> {
  if (!/^[a-f0-9]{40,64}$/.test(preregistrationCommit))
    throw new Error("Supply the orchestrator's committed preregistration hash");
  const rel = relative(resolve(root), resolve(root, registrationPath)).replaceAll("\\", "/");
  if (isAbsolute(registrationPath) || rel === ".." || rel.startsWith("../"))
    throw new Error(`Unsafe registration path: ${registrationPath}`);
  const preregistrationBytes = await readFile(resolve(root, registrationPath));
  const registration = JSON.parse(preregistrationBytes.toString()) as Registration;
  const reasoningEffort = registeredReasoningEffort(registration);
  assertRegistrationUnchanged(
    preregistrationBytes,
    await committedRegistration(root, preregistrationCommit, registrationPath),
  );
  const manifestBytes = await readFile(join(root, registration.dataset.manifest));
  if (createHash("sha256").update(manifestBytes).digest("hex") !== registration.dataset.sha256)
    throw new Error(
      "Corpus differs from committed preregistration; preregister a distinct round before live calls",
    );
  await assertFrozenFiles(root, registration.frozenFiles);
  const manifest = JSON.parse(manifestBytes.toString()) as { cases: Case[] };
  const cases = manifest.cases;
  const runId = `${registration.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const directory = join(root, "evals/results", runId);
  await mkdir(directory, { recursive: true });
  const started = performance.now();
  let chargedTokens = 0;
  let stopReason: EvaluationFailure | null = null;
  const trials: TrialLedger[] = [
    ...registration.dataset.development,
    ...registration.dataset.holdout,
  ].map((id, index) => {
    const entry = cases.find((item) => item.id === id);
    if (!entry) throw new Error(`Missing preregistered case ${id}`);
    return {
      trialId: `trial-${String(index + 1).padStart(2, "0")}`,
      caseId: id,
      split: registration.dataset.holdout.includes(id) ? "holdout" : "development",
      category: entry.failureCategory,
      mutant: entry.mutant,
      oracle: { healthyConfirmed: false, defectConfirmed: false },
      pairs: [],
      errors: [],
      generatedProposals: 0,
      validProposals: 0,
      commands: [],
      decisions: [],
      oracleVerdicts: [],
      usage: null,
      durationMs: 0,
      workspace: null,
    };
  });
  const key = process.env[registration.provider.apiKeyEnv];
  const redact = (value: string) => (key ? value.split(key).join("[REDACTED]") : value);
  if (!key)
    stopReason = new EvaluationFailure(
      "missing_key",
      `${registration.provider.apiKeyEnv} is absent`,
      { env: registration.provider.apiKeyEnv },
      "missing_key",
    );
  const flush = async () => {
    for (const trial of trials)
      await writeFile(
        join(directory, `${trial.trialId}.json`),
        `${redact(JSON.stringify({ ...trial, score: scoreTrial(trial) }, null, 2))}\n`,
      );
  };
  for (const trial of trials) {
    const trialStarted = performance.now();
    if (stopReason) {
      trial.errors.push({
        phase: "scheduling",
        code: stopReason.code,
        message: stopReason.message,
        evidence: stopReason.evidence,
        exclusion: stopReason.exclusion,
      });
      continue;
    }
    const workspace = await mkdtemp(join(tmpdir(), "tm-eval-"));
    trial.workspace = workspace;
    const cwd = join(workspace, "repo");
    const home = join(workspace, "home");
    const dataDir = join(cwd, ".testmaster");
    await mkdir(cwd);
    await mkdir(join(home, ".config/testmaster"), { recursive: true });
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      TESTMASTER_DATA_DIR: dataDir,
      TESTMASTER_OFFLINE: "false",
      CI: "true",
    };
    for (const variable of [
      "TESTMASTER_PROJECT_ID",
      "TESTMASTER_PROFILE",
      "TESTMASTER_ENDPOINT",
      "TESTMASTER_API_KEY",
      "TESTMASTER_MODEL_API_KEY",
      "NODE_OPTIONS",
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
    ])
      delete environment[variable];
    await writeFile(
      join(home, ".config/testmaster/profiles.json"),
      JSON.stringify({
        defaultProfile: "eval",
        profiles: {
          eval: {
            modelProviders: [
              {
                id: registration.provider.id,
                kind: registration.provider.kind,
                baseUrl: registration.provider.baseUrl,
                apiKeyEnv: registration.provider.apiKeyEnv,
                models: [
                  {
                    id: registration.provider.model,
                    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
                    capabilities: {
                      structuredJson: true,
                      toolCalls: true,
                      contextTokens: 128000,
                      maxOutputTokens: 8192,
                    },
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    await writeFile(
      join(home, ".config/testmaster/policy.json"),
      JSON.stringify({ allowedModelProviders: [registration.provider.id] }),
    );
    let phase = "setup";
    let trialCharge = 0;
    let previousCallCount = 0;
    const unmeasuredReservations: number[] = [];
    const command = async (
      args: string[],
      modelCommand = false,
      allowFailure = false,
      finalizing = false,
    ): Promise<Json> => {
      const remaining = registration.budget.maxWallTimeMs - (performance.now() - started);
      if (!finalizing && remaining <= 0)
        throw new EvaluationFailure(
          "wall_time_exhausted",
          "Preregistered wall deadline reached",
          { elapsedMs: performance.now() - started },
          "wall_time_exhausted",
        );
      if (modelCommand) {
        const requiredTokens = deriveCommandConservativeTokens(args, registration);
        if (chargedTokens + requiredTokens > registration.budget.maxTokens)
          throw new EvaluationFailure(
            "budget_exhausted",
            "Insufficient conservative token reservation",
            { chargedTokens, requiredTokens },
            "budget_exhausted",
          );
        chargedTokens += requiredTokens;
        trialCharge += requiredTokens;
        unmeasuredReservations.push(requiredTokens);
      }
      const before = performance.now();
      const record: CommandRecord = {
        args,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        exitCode: null,
        signal: null,
        envelope: null,
        stdout: "",
        stderr: "",
      };
      trial.commands.push(record);
      const child = spawn(
        process.execPath,
        [join(root, "apps/cli/dist/main.js"), ...args, "--output", "json", "--no-color"],
        { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] },
      );
      let deadlineReached = false;
      const timer = setTimeout(
        () => {
          deadlineReached = true;
          child.kill("SIGTERM");
        },
        Math.max(1, Math.min(finalizing ? 30000 : remaining, 600000)),
      );
      const hardTimer = setTimeout(
        () => child.kill("SIGKILL"),
        Math.max(1, Math.min(finalizing ? 30000 : remaining, 600000)) + 15000,
      );
      child.stdout.on("data", (chunk: Buffer) => {
        record.stdout += redact(chunk.toString());
      });
      child.stderr.on("data", (chunk: Buffer) => {
        record.stderr += redact(chunk.toString());
      });
      try {
        await new Promise<void>((accept, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => {
            record.exitCode = code;
            record.signal = signal;
            accept();
          });
        });
      } finally {
        clearTimeout(timer);
        clearTimeout(hardTimer);
        record.durationMs = performance.now() - before;
      }
      try {
        record.envelope = object(JSON.parse(record.stdout));
      } catch {
        /* Malformed CLI output is recorded as a pipeline error. */
      }
      if (modelCommand) await settle();
      if (deadlineReached)
        throw new EvaluationFailure(
          "wall_time_exhausted",
          "Command cancelled at deadline",
          record,
          "wall_time_exhausted",
        );
      if (!record.envelope)
        throw new EvaluationFailure(
          "malformed_cli_output",
          "CLI emitted no parseable envelope",
          record,
        );
      const error = object(record.envelope.error);
      if (record.exitCode !== 0 && !allowFailure) {
        const details = object(error.details);
        const reason = String(details.reasonCode ?? "");
        const exclusion =
          modelCommand && error.code === "UPSTREAM_TIMEOUT"
            ? "provider_timeout"
            : modelCommand &&
                ["UNAVAILABLE", "RATE_LIMITED"].includes(String(error.code)) &&
                (object(error.details).status === undefined ||
                  Number(object(error.details).status) >= 429)
              ? "provider_transport"
              : reason === "sandbox_unavailable"
                ? "sandbox_unavailable"
                : reason === "worker_lost"
                  ? "worker_lost"
                  : null;
        throw new EvaluationFailure(
          exclusion ?? String(error.code ?? "pipeline_error"),
          String(error.message ?? "CLI command failed"),
          record,
          exclusion,
        );
      }
      const payload = record.envelope.data;
      return Array.isArray(payload) ? { items: payload } : object(payload);
    };
    const settle = async () => {
      const usage = await command(["usage"], false, false, true);
      trial.usage = usage;
      const calls = rows(usage.calls);
      const measured = calls.reduce((total, call) => {
        const tokens = object(call.usage);
        return (
          total +
          (typeof tokens.inputTokens === "number" ? tokens.inputTokens : 100000) +
          (typeof tokens.outputTokens === "number" ? tokens.outputTokens : 8192)
        );
      }, 0);
      if (
        calls.length > previousCallCount &&
        calls.every(
          (call) =>
            typeof object(call.usage).inputTokens === "number" &&
            typeof object(call.usage).outputTokens === "number",
        )
      ) {
        unmeasuredReservations.pop();
        const pendingReservations = unmeasuredReservations.reduce((sum, v) => sum + v, 0);
        const settled = measured + pendingReservations;
        chargedTokens += settled - trialCharge;
        trialCharge = settled;
      }
      previousCallCount = calls.length;
      usage["eval:chargedTokens"] = trialCharge;
    };
    try {
      phase = "oracle";
      const entry = cases.find((item) => item.id === trial.caseId);
      const check = entry ? checks[entry.oracle.checkName] : undefined;
      if (!check)
        throw new EvaluationFailure(
          "oracle_error",
          "Missing independent oracle",
          entry,
          "oracle_error",
        );
      for (const side of ["healthy", "mutant"] as const) {
        const shop = await startShop({
          port: 0,
          mutant: side === "healthy" ? "healthy" : trial.mutant,
        });
        try {
          const verdict = await check(shop);
          trial.oracleVerdicts.push({ side, ...verdict });
          if (side === "healthy")
            trial.oracle.healthyConfirmed = verdict.healthy && !verdict.defective;
          else trial.oracle.defectConfirmed = verdict.defective && !verdict.healthy;
        } catch (error) {
          throw new EvaluationFailure("oracle_error", String(error), { side }, "oracle_error");
        } finally {
          await shop.close();
        }
      }
      if (!trial.oracle.healthyConfirmed || !trial.oracle.defectConfirmed)
        throw new EvaluationFailure(
          "oracle_mismatch",
          "Independent oracle did not confirm paired ground truth",
          trial.oracleVerdicts,
          "oracle_mismatch",
        );
      phase = "setup";
      const identity = await command([
        "init",
        "--mode",
        "local",
        "--name",
        trial.trialId,
        "--base-url",
        "http://127.0.0.1:8080",
      ]);
      const configPath = join(cwd, "testmaster.config.json");
      const config = object(JSON.parse(await readFile(configPath, "utf8")));
      config.execution = {
        ...object(config.execution),
        executor: "docker",
        mode: "replay",
        concurrency: 1,
        maxAttempts: 1,
        attemptTimeoutMs: 120000,
        executionTimeoutMs: 150000,
        stepTimeoutMs: 5000,
        networkRequestTimeoutMs: 90000,
      };
      config.healing = { mode: "off" };
      config.telemetry = { enabled: false };
      await writeFile(configPath, JSON.stringify(config));
      trial.decisions.push({
        projectId: identity.projectId,
        reviewer: "preregistered external rule-based evaluator",
        humanReview: false,
      });
      await command([
        "consent",
        "grant",
        "--provider",
        registration.provider.id,
        "--allow-unknown-cost",
        "--data-class",
        "documents",
        "code_summary",
        "requirements",
        "plans",
      ]);
      await command(["budget", "set", "--tokens", String(registration.budget.maxTokens)]);
      phase = "sources";
      const revisions: string[] = [];
      for (const [basename, role, format] of [
        ["PRD.md", "prd", "markdown"],
        ["openapi.yaml", "api-spec", "openapi"],
      ]) {
        if (!basename || !role || !format) throw new Error("Invalid source definition");
        await cp(join(root, "fixtures/reference-shop/artifacts", basename), join(cwd, basename));
        const source = await command([
          "source",
          "add",
          basename,
          "--role",
          role,
          "--format",
          format,
        ]);
        revisions.push(String(object(source.revision).id));
      }
      phase = "discovery";
      await command([
        "discover",
        "--scope",
        "codebase",
        ...revisions.flatMap((id) => ["--source-revision", id]),
      ]);
      phase = "normalize";
      const normalized = await command(
        ["requirement", "normalize", "--source-revision", ...revisions],
        true,
      );
      phase = "review";
      const conflicted = new Set(
        rows(normalized.conflicts).flatMap((conflict) =>
          Array.isArray(conflict.requirementIds) ? conflict.requirementIds.map(String) : [],
        ),
      );
      const requirements = rows(normalized.requirements).sort(
        (a, b) =>
          String(a.text).localeCompare(String(b.text)) || String(a.id).localeCompare(String(b.id)),
      );
      const approved: Json[] = [];
      for (const requirement of requirements) {
        const grounded =
          rows(requirement.sourceRefs).length > 0 &&
          rows(requirement.sourceRefs).every((ref) =>
            revisions.includes(String(ref.sourceRevisionId)),
          );
        const eligible =
          (requirement.originKind === "explicit" || requirement.originKind === "user_spec") &&
          grounded &&
          !conflicted.has(String(requirement.id)) &&
          Array.isArray(requirement.acceptanceCriteria) &&
          requirement.acceptanceCriteria.length > 0 &&
          approved.length < 12;
        trial.decisions.push({
          requirementId: requirement.id,
          text: requirement.text,
          eligible,
          reason: eligible
            ? "explicit grounded nonconflicting requirement"
            : "inferred/observed, missing grounding/criteria, unresolved conflict or fixed 12-requirement cap",
        });
        if (eligible)
          approved.push(
            await command([
              "requirement",
              "approve",
              String(requirement.id),
              "--expected-version",
              String(requirement.version),
            ]),
          );
      }
      if (!approved.length)
        throw new EvaluationFailure(
          "no_approved_requirements",
          "No requirements passed fixed review policy",
          normalized,
        );
      for (const requirement of approved) {
        phase = "plan";
        let batch: Json;
        try {
          batch = await command(
            ["plan", "generate", "--type", "auto", "--requirement", String(requirement.id)],
            true,
          );
        } catch (error) {
          if (error instanceof EvaluationFailure && !error.exclusion) {
            trial.errors.push({
              phase,
              code: error.code,
              message: error.message,
              evidence: error.evidence,
              exclusion: null,
            });
            continue;
          }
          throw error;
        }
        const detail = await command(["plan", "get", String(batch.id)]);
        const proposals = rows(detail.proposals);
        trial.generatedProposals += proposals.length;
        const valid = proposals.filter(
          (proposal) =>
            proposal.validation === "valid" && object(proposal.plan).kind === "executable",
        );
        trial.validProposals += valid.length;
        trial.decisions.push({
          batchId: batch.id,
          acceptedProposalIds: valid.map((proposal) => proposal.id),
          reason:
            "All locally validated executable proposals; unchanged assertions; outcomes not observed",
        });
        if (!valid.length) continue;
        phase = "accept";
        const receipt = await command([
          "plan",
          "accept",
          String(batch.id),
          "--only",
          ...valid.map((proposal) => String(proposal.id)),
          "--expected-version",
          String(batch.version),
          "--idempotency-key",
          `${trial.trialId}-${batch.id}`,
        ]);
        const tests = Array.isArray(receipt.accepted) ? receipt.accepted.map(String) : [];
        for (const testId of tests) {
          const test = await command(["test", "get", testId]);
          const revisionId = String(test.activeRevisionId);
          const revision = await command(["test", "revision", "get", revisionId]);
          const assertionIds = new Set<string>();
          const visit = (steps: unknown) => {
            for (const step of rows(steps)) {
              if (step.required !== false && (step.kind === "assertion" || step.expectation))
                assertionIds.add(String(step.id));
              visit(object(step.input).childSteps);
            }
          };
          visit(object(revision.plan).steps);
          const pair: Pair = {
            healthy: {
              testId,
              revisionId,
              runId: null,
              outcome: null,
              gate: null,
              requiredAssertionFailed: false,
            },
            mutant: {
              testId,
              revisionId,
              runId: null,
              outcome: null,
              gate: null,
              requiredAssertionFailed: false,
            },
          };
          trial.pairs.push(pair);
          for (const side of ["healthy", "mutant"] as const) {
            phase = `replay-${side}`;
            const shop = await startShop({
              port: 0,
              mutant: side === "healthy" ? "healthy" : trial.mutant,
            });
            try {
              const target = await command([
                "env",
                "create",
                "--name",
                `${side}-${testId}`,
                "--base-url",
                shop.url,
                "--network-profile",
                "local-loopback",
                "--locale",
                "en-US",
                "--timezone",
                "UTC",
              ]);
              const result = await command(
                [
                  "test",
                  "run",
                  testId,
                  "--revision",
                  revisionId,
                  "--env",
                  String(target.id),
                  "--wait",
                  "--mode",
                  "replay",
                  "--heal",
                  "off",
                  "--max-attempts",
                  "1",
                  "--timeout",
                  "180",
                ],
                false,
                true,
              );
              const run = object(result.run);
              const replay: Replay = pair[side];
              replay.runId = typeof run.id === "string" ? run.id : null;
              replay.outcome = typeof run.outcome === "string" ? run.outcome : null;
              replay.gate = typeof run.gate === "string" ? run.gate : null;
              const replayCommand = trial.commands.at(-1);
              const replayError = object(replayCommand?.envelope?.error);
              if (Object.keys(replayError).length)
                trial.errors.push({
                  phase,
                  code: String(replayError.code ?? "replay_error"),
                  message: String(replayError.message ?? "Replay admission failed"),
                  evidence: replayCommand,
                  exclusion: null,
                });
              if (replay.runId) {
                const steps = await command(["run", "steps", replay.runId]);
                const stepRows = rows(steps.items ?? steps);
                replay.requiredAssertionFailed = stepRows.some(
                  (step) =>
                    assertionIds.has(String(step.planStepId)) &&
                    step.status === "failed" &&
                    step.reasonCode === "assertion_failed",
                );
                for (const step of stepRows.filter((item) => item.status === "failed")) {
                  trial.errors.push({
                    phase,
                    code: String(step.reasonCode ?? "generated_action_failure"),
                    message: String(object(step.error).message ?? "Generated replay step failed"),
                    evidence: { runId: replay.runId, step },
                    exclusion: null,
                  });
                }
                await command(["run", "events", replay.runId]);
                await command(["artifact", "get", replay.runId]);
              }
              if (!["passed", "failed"].includes(replay.outcome ?? "")) {
                const reason = String(run.reasonCode ?? "");
                trial.errors.push({
                  phase,
                  code: reason || "replay_unavailable",
                  message: "Replay did not produce a business outcome",
                  evidence: { run, command: replayCommand },
                  exclusion:
                    reason === "sandbox_unavailable"
                      ? "sandbox_unavailable"
                      : reason === "worker_lost"
                        ? "worker_lost"
                        : null,
                });
              }
            } finally {
              await shop.close();
            }
          }
        }
      }
      if (!trial.pairs.length)
        trial.errors.push({
          phase: "accept",
          code: "no_accepted_tests",
          message: "No generated tests accepted",
          evidence: trial.decisions,
          exclusion: null,
        });
    } catch (error) {
      const failure =
        error instanceof EvaluationFailure
          ? error
          : new EvaluationFailure("harness_error", String(error), { phase });
      trial.errors.push({
        phase,
        code: failure.code,
        message: redact(failure.message),
        evidence: failure.evidence,
        exclusion: failure.exclusion,
      });
      if (["budget_exhausted", "wall_time_exhausted"].includes(failure.code)) stopReason = failure;
    } finally {
      try {
        await settle();
      } catch (error) {
        trial.errors.push({
          phase: "usage",
          code: "usage_unavailable",
          message: redact(String(error)),
          evidence: trial.commands.at(-1),
          exclusion: null,
        });
      }
      trial.durationMs = performance.now() - trialStarted;
      try {
        await cp(join(dataDir, "runs"), join(directory, `${trial.trialId}-evidence`), {
          recursive: true,
        });
      } catch (error) {
        const isEnoent =
          typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
        const hasAttempts = trial.pairs.some(
          (p) => Boolean(p.healthy.runId) || Boolean(p.mutant.runId),
        );
        if (isEnoent && !hasAttempts) {
          trial.errors.push({
            phase: "evidence",
            code: "no_attempts",
            message: "No test runs executed; runs evidence directory was not created",
            evidence: { dataDir },
            exclusion: null,
          });
        } else {
          trial.errors.push({
            phase: "evidence",
            code: "evidence_copy_unavailable",
            message: String(error),
            evidence: { dataDir },
            exclusion: null,
          });
        }
      }
      await flush();
    }
  }
  await flush();
  const measuredCosts: Record<string, { amount: string; currency: string; scale: number }> = {};
  let unknownCostCalls = 0;
  const tokens: Record<string, number | null> = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
  for (const trial of trials) {
    if (!trial.usage) continue;
    unknownCostCalls += Number(trial.usage.unknownCostCalls ?? 0);
    for (const field of Object.keys(tokens)) {
      const value = object(trial.usage.tokens)[field];
      tokens[field] =
        tokens[field] === null || typeof value !== "number" ? null : Number(tokens[field]) + value;
    }
    for (const cost of rows(trial.usage.measuredCosts)) {
      const key = `${cost.currency}:${cost.scale}`;
      measuredCosts[key] = {
        amount: (
          BigInt(measuredCosts[key]?.amount ?? "0") + BigInt(String(cost.amount))
        ).toString(),
        currency: String(cost.currency),
        scale: Number(cost.scale),
      };
    }
  }
  const report = {
    ...summarize(trials),
    runId,
    preregistrationCommit,
    preregistrationSha256: createHash("sha256").update(preregistrationBytes).digest("hex"),
    class: "live-model-evaluation",
    runner: "real-cli-docker",
    provider: registration.provider.id,
    model: registration.provider.model,
    reasoningEffort: reasoningEffort ?? null,
    chargedTokens,
    tokens,
    measuredCosts: Object.values(measuredCosts),
    unknownCostCalls,
    cost:
      unknownCostCalls || trials.some((trial) => !trial.usage)
        ? "unknown"
        : Object.values(measuredCosts),
    durationMs: performance.now() - started,
    stopReason: stopReason?.code ?? "planned_trials_recorded",
    limitations: [
      "Single application family; mutant-level holdout only; correlated trials",
      "Pending independent human labels and conflict adjudication",
      "External rule-based review, not independent human semantic intent review",
      "Descriptive Wilson intervals; insufficient n for parity or graduation",
      "Provider snapshot and monetary tariff unavailable",
    ],
    trialLedgerDirectory: `evals/results/${runId}`,
  };
  await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(root, "evals/results/report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const metric = (value: Proportion) =>
    value.estimate === null
      ? "insufficientData (n=0)"
      : `${value.successes}/${value.n} = ${(100 * value.estimate).toFixed(1)}%; Wilson 95% [${(100 * Number(value.lower)).toFixed(1)}%, ${(100 * Number(value.upper)).toFixed(1)}%]`;
  const markdown = [
    "# Experimental M2 model evaluation",
    "",
    `Round: ${runId}. Preregistration commit: ${preregistrationCommit}.`,
    "",
    `- Settings: provider ${report.provider}; model ${report.model}; reasoning effort ${report.reasoningEffort ?? "provider default"}`,
    `- Primary, all planned trials: ${metric(report.primary)}`,
    `- Conditional oracle-confirmed non-infrastructure cohort: ${metric(report.conditional)}`,
    `- Healthy false failures: ${metric(report.healthyFalseFailure)}`,
    `- Returned proposal validity: ${metric(report.proposalValidity)}`,
    `- Healthy unavailable replays: ${report.healthyUnavailable}`,
    `- Excluded trials (conditional only): ${report.exclusions.length}; errors: ${report.errors.length}`,
    `- Conservative/settled token charge: ${chargedTokens}/${registration.budget.maxTokens}; measured tokens: ${JSON.stringify(tokens)}`,
    `- Cost: ${JSON.stringify(report.cost)}; unknown-price calls: ${unknownCostCalls}`,
    `- Wall duration: ${Math.round(report.durationMs)} ms; stop: ${report.stopReason}`,
    "",
    "## Case outcomes",
    "",
    "| Case | Split | Detected | Exclusions |",
    "|---|---|---|---|",
    ...trials.map((trial) => {
      const score = scoreTrial(trial);
      return `| ${trial.caseId} | ${trial.split} | ${score.detected} | ${score.exclusions.join(", ") || "none"} |`;
    }),
    "",
    "## Strata",
    "",
    ...Object.entries(report.strata).map(([stratum, value]) => `- ${stratum}: ${metric(value)}`),
    "",
    "## Exclusions and errors",
    "",
    ...report.errors.map(
      (error) =>
        `- ${error.trialId}, ${error.phase}, ${error.code}: ${error.message.replaceAll("\n", " ")} (conditional exclusion: ${error.exclusion ?? "none"})`,
    ),
    ...(report.errors.length ? [] : ["None recorded."]),
    "",
    "## Limits and decision",
    "",
    ...report.limitations.map((value) => `- ${value}`),
    "",
    "Capabilities remain **experimental**. No parity, human-adjudicated benchmark eligibility, unseen-family generalization or rare-event claim.",
    "Invalid generation and all infrastructure exclusions remain misses in the planned end-to-end denominator. Retries/repairs are calls, not independent trials.",
    `Ledger: ${report.trialLedgerDirectory}; per-trial commands, exit codes, Run/revision IDs, oracle verdicts, usage calls and evidence are retained.`,
    "",
  ].join("\n");
  await writeFile(join(directory, "report.md"), markdown);
  await writeFile(join(root, "evals/results/report.md"), markdown);
  console.log(JSON.stringify({ runId, directory, primary: report.primary, label: report.label }));
}

export async function checkPreregistration(
  root: string,
  registrationPath = "evals/preregistration.json",
): Promise<void> {
  const rel = relative(resolve(root), resolve(root, registrationPath)).replaceAll("\\", "/");
  if (isAbsolute(registrationPath) || rel === ".." || rel.startsWith("../"))
    throw new Error(`Unsafe registration path: ${registrationPath}`);
  const registration = JSON.parse(
    await readFile(resolve(root, registrationPath), "utf8"),
  ) as Registration;
  registeredReasoningEffort(registration);
  const manifestBytes = await readFile(join(root, registration.dataset.manifest));
  if (createHash("sha256").update(manifestBytes).digest("hex") !== registration.dataset.sha256)
    throw new Error("Corpus hash differs from preregistration");
  await assertFrozenFiles(root, registration.frozenFiles);
  const manifest = JSON.parse(manifestBytes.toString()) as { cases: Case[] };
  const ids = [...registration.dataset.development, ...registration.dataset.holdout];
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== 8 ||
    ids.some((id) => !manifest.cases.some((entry) => entry.id === id))
  )
    throw new Error("Preregistered split has missing, duplicate or unexpected trial cases");
  const order = ids
    .map((id) => ({
      id,
      hash: createHash("sha256").update(`testmaster-m2-eval-2026-10-05:${id}`).digest("hex"),
    }))
    .sort((a, b) => a.hash.localeCompare(b.hash))
    .map((entry) => entry.id);
  if (order.some((id, index) => ids[index] !== id))
    throw new Error("Preregistered seeded ordering differs");
  if (
    registration.budget.maxTokens <= 0 ||
    registration.budget.maxWallTimeMs <= 0 ||
    registration.budget.perModelCommandConservativeTokens !== 6 * (100000 + 8192)
  )
    throw new Error("Invalid preregistered budget");
  if (
    registration.budget.normalizationConservativeTokens !== undefined &&
    registration.budget.normalizationConservativeTokens !== 7 * 6 * (100000 + 8192)
  )
    throw new Error("Invalid preregistered normalization budget");
  console.log(
    JSON.stringify({
      mode: "check",
      preregistration: registration.id,
      corpusHash: registration.dataset.sha256,
      plannedTrials: ids.length,
      liveCalls: 0,
      dockerCalls: 0,
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const argv = process.argv.slice(2);
  let mode: "check" | "execute" | null = null;
  let commit: string | null = null;
  let registrationPath = "evals/preregistration.json";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--registration" && i + 1 < argv.length) {
      registrationPath = argv[++i]!;
    } else if (arg === "--check") {
      mode = "check";
      if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
        registrationPath = argv[++i]!;
      }
    } else if (arg === "--execute-preregistered") {
      mode = "execute";
      if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
        commit = argv[++i]!;
      }
      if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
        registrationPath = argv[++i]!;
      }
    }
  }
  if (mode === "check") await checkPreregistration(root, registrationPath);
  else if (mode === "execute" && commit) await runEvaluation(root, commit, registrationPath);
  else
    throw new Error(
      "Use --check [--registration <path>] (offline) or, only after phase-2 authorization, --execute-preregistered <commit> [--registration <path>]",
    );
}
