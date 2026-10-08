import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { Application } from "@testmaster/application";
import type { Analysis } from "@testmaster/contracts";
import { canonicalJson } from "@testmaster/domain";
import { diagnosticUtility, unsupportedClaimsForRun, writeEvalProfile } from "./m3.js";
import type { M3Ledger, PlannedCase } from "./m3-scoring.js";
import { emptyLedger, scoreM3 } from "./m3-scoring.js";

export const smokeLimits = {
  cases: 4,
  calls: 8,
  conservativeTokens: 200000,
  outputReservation: 8192,
} as const;
export interface ReplayOptions {
  model?: boolean;
  caseIds?: string[];
}
export interface SmokeState {
  calls: number;
  generationCalls: number;
  inventoryCalls: number;
  conservativeTokens: number;
  stopped: string | null;
  wire: {
    model: string;
    reasoningEffort: string;
    promptBytes: number;
    reservation: number;
    status: number | null;
  }[];
}
export interface SmokeForwarder {
  baseUrl: string;
  close(): Promise<void>;
}
/** Enforces admission before forwarding, including repairs and retries inside the gateway. */
export function smokeFetch(
  delegate: typeof fetch,
  state: SmokeState,
  providerUrl: string,
): typeof fetch {
  const origin = new URL(providerUrl).origin;
  return async (input, init) => {
    if (state.stopped) throw new Error(state.stopped);
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input.toString() : input.url,
    );
    if (url.origin !== origin) {
      state.stopped = "unexpected_network_destination";
      throw new Error(state.stopped);
    }
    let reservation = 0;
    let wire: SmokeState["wire"][number] | undefined;
    if (url.pathname.endsWith("/chat/completions")) {
      if (state.generationCalls >= smokeLimits.calls) {
        state.stopped = "smoke_call_limit";
        throw new Error(state.stopped);
      }
      if (typeof init?.body !== "string")
        throw new Error("Smoke requires inspectable request body");
      const payload = JSON.parse(init.body) as Record<string, unknown>;
      if (payload.model !== "qwen3.8-flash" || payload.reasoning_effort !== "medium") {
        state.stopped = "smoke_model_configuration_mismatch";
        throw new Error(state.stopped);
      }
      const promptBytes = Buffer.byteLength(canonicalJson(payload));
      reservation = promptBytes + smokeLimits.outputReservation;
      if (state.conservativeTokens + reservation > smokeLimits.conservativeTokens) {
        state.stopped = "smoke_token_limit";
        throw new Error(state.stopped);
      }
      wire = {
        model: "qwen3.8-flash",
        reasoningEffort: "medium",
        promptBytes,
        reservation,
        status: null,
      };
      state.wire.push(wire);
    } else if (!url.pathname.endsWith("/models")) {
      state.stopped = "unexpected_provider_operation";
      throw new Error(state.stopped);
    }
    state.calls++;
    if (wire) state.generationCalls++;
    else state.inventoryCalls++;
    state.conservativeTokens += reservation;
    try {
      const response = await delegate(input, init);
      if (wire) wire.status = response.status;
      if (!response.ok) state.stopped = "first_provider_failure";
      return response;
    } catch (error) {
      state.stopped = "first_provider_failure";
      throw error;
    }
  };
}
/** The gateway uses undici, so an isolated profile routes it through this admission boundary. */
export async function startSmokeForwarder(providerUrl: string, state: SmokeState) {
  const guarded = smokeFetch(globalThis.fetch, state, providerUrl);
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 1048576) throw new Error("Smoke request exceeds admitted byte bound");
        chunks.push(buffer);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const suffix =
        request.url === "/v1/models"
          ? "models"
          : request.url === "/v1/chat/completions"
            ? "chat/completions"
            : null;
      if (!suffix) throw new Error("Unexpected smoke route");
      const upstream = await guarded(`${providerUrl.replace(/\/$/, "")}/${suffix}`, {
        method: suffix === "models" ? "GET" : "POST",
        headers: {
          authorization: request.headers.authorization ?? "",
          "content-type": "application/json",
        },
        ...(suffix === "models" ? {} : { body }),
        redirect: "error",
        signal: AbortSignal.timeout(180000),
      });
      const result = await upstream.text();
      if (upstream.ok) {
        try {
          const parsed: unknown = JSON.parse(result);
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            (suffix === "models" && (!("data" in parsed) || !Array.isArray(parsed.data)))
          )
            state.stopped ??= "first_provider_failure";
        } catch {
          state.stopped ??= "first_provider_failure";
        }
      }
      response.writeHead(upstream.status, { "content-type": "application/json" });
      response.end(result);
    } catch {
      state.stopped ??= "first_provider_failure";
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Development smoke forwarding stopped" } }));
    }
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Smoke forwarding address unavailable");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((accept, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : accept()));
      }),
  };
}
async function rejectLinks(path: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) throw new Error("Retained workspace must not contain symbolic links");
  if (entry.isDirectory())
    for (const child of await readdir(path)) await rejectLinks(join(path, child));
}
/** Originals are never opened by Application; cleanup covers failures as well as success. */
export async function withRetainedCopy<T>(
  source: string,
  operation: (copy: string) => Promise<T>,
): Promise<T> {
  const original = await realpath(source);
  if (original === "/" || original === tmpdir()) throw new Error("Invalid retained workspace root");
  await rejectLinks(original);
  const temporary = await mkdtemp(join(tmpdir(), "tm-dev-replay-"));
  const copy = join(temporary, "workspace");
  try {
    await cp(original, copy, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    return await operation(copy);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
function replayEnvironment(copy: string, model: boolean): NodeJS.ProcessEnv {
  const home = join(copy, "home");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    TESTMASTER_DATA_DIR: join(copy, "repo/.testmaster"),
    TESTMASTER_OFFLINE: model ? "false" : "true",
    CI: "false",
  };
  for (const name of [
    "NODE_OPTIONS",
    "TESTMASTER_PROJECT_ID",
    "TESTMASTER_PROFILE",
    "TESTMASTER_ENDPOINT",
    "TESTMASTER_API_KEY",
    "TESTMASTER_MODEL_API_KEY",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
  ])
    delete env[name];
  return env;
}
export async function replayM3(
  root: string,
  resultsDirectory: string,
  outLabel: string,
  options: ReplayOptions = {},
) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(outLabel))
    throw new Error("Invalid development replay label");
  const source = resolve(root, resultsDirectory);
  const corpus = JSON.parse(await readFile(join(root, "evals/m3/corpus.json"), "utf8")) as {
    cases: PlannedCase[];
  };
  const retained: M3Ledger[] = [];
  for (const name of (await readdir(source)).sort()) {
    if (!name.endsWith(".json") || ["round.json", "report.json"].includes(name)) continue;
    const value = JSON.parse(await readFile(join(source, name), "utf8")) as M3Ledger;
    if (value.id && value.records && value.group) retained.push(value);
  }
  if (!retained.length || new Set(retained.map((row) => row.id)).size !== retained.length)
    throw new Error("Missing or duplicate retained case ledgers");
  const ids = options.caseIds ?? retained.map((row) => row.id);
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !retained.some((row) => row.id === id))
  )
    throw new Error("Replay case selection invalid");
  if (options.model && ids.length > smokeLimits.cases)
    throw new Error("Model smoke allows at most four cases");
  const directory = join(
    root,
    "evals/results",
    `dev-replay-${outLabel}-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const state: SmokeState = {
    calls: 0,
    generationCalls: 0,
    inventoryCalls: 0,
    conservativeTokens: 0,
    stopped: null,
    wire: [],
  };
  const ledgers: M3Ledger[] = [];
  const analyses: { caseId: string; rules: Analysis; model?: Analysis }[] = [];
  const skips: { caseId: string; reason: string }[] = [];
  const selected = ids.map((id) => {
    const retainedCase = retained.find((row) => row.id === id)!;
    const planned = corpus.cases.find((row) => row.id === id) ?? {
      id,
      group: retainedCase.group,
      expectedFailureKind: retainedCase.expectedFailureKind,
    };
    return { retainedCase, planned };
  });
  for (const { retainedCase, planned } of selected) {
    const ledger = emptyLedger(planned);
    ledgers.push(ledger);
    const transformed = retainedCase.records.transformed as { runId?: string } | undefined;
    const workspace = retainedCase.records.workspace;
    if (!transformed?.runId || typeof workspace !== "string") {
      skips.push({
        caseId: ledger.id,
        reason: "Retained transformed run or workspace unavailable; no run invented.",
      });
      await writeFile(
        join(directory, `${ledger.id}.json`),
        JSON.stringify(ledger, null, 2) + "\n",
        { mode: 0o600 },
      );
      continue;
    }
    if (state.stopped) {
      skips.push({ caseId: ledger.id, reason: state.stopped });
      await writeFile(
        join(directory, `${ledger.id}.json`),
        JSON.stringify(ledger, null, 2) + "\n",
        { mode: 0o600 },
      );
      continue;
    }
    try {
      await withRetainedCopy(workspace, async (copy) => {
        const cwd = join(copy, "repo"),
          home = join(copy, "home");
        const env = replayEnvironment(copy, Boolean(options.model));
        let forwarder: SmokeForwarder | undefined;
        if (options.model) {
          const profile = JSON.parse(
            await readFile(join(home, ".config/testmaster/profiles.json"), "utf8"),
          ) as {
            defaultProfile: string;
            profiles: Record<
              string,
              { modelProviders: { id: string; kind: string; baseUrl: string; apiKeyEnv: string }[] }
            >;
          };
          const provider = profile.profiles[profile.defaultProfile]?.modelProviders[0];
          if (!provider || !env[provider.apiKeyEnv])
            throw new Error("Smoke provider credentials unavailable");
          forwarder = await startSmokeForwarder(provider.baseUrl, state);
          try {
            await writeEvalProfile(
              home,
              {
                ...provider,
                baseUrl: forwarder.baseUrl,
                model: "qwen3.8-flash",
                capabilities: {
                  contextTokens: 128000,
                  maxOutputTokens: smokeLimits.outputReservation,
                },
              },
              { reasoning_effort: "medium" },
            );
          } catch (error) {
            await forwarder.close();
            throw error;
          }
        }
        const originalFetch = globalThis.fetch;
        if (!options.model)
          globalThis.fetch = async () => {
            throw new Error("Offline replay attempted network");
          };
        let app: Application | undefined;
        try {
          app = await Application.open({ cwd, home, env });
          const runId = transformed.runId!;
          const rules = await app.analysis.analyze(runId, { model: false });
          ledger.utility = { rules: diagnosticUtility(rules) };
          ledger.diagnosis = {
            failureKind: rules.failureKind,
            grounded: true,
            abstained: rules.failureKind === "unknown",
          };
          ledger.status = "observed";
          ledger.records = { retainedWorkspace: workspace, runId, rulesAnalysisId: rules.id };
          const record: { caseId: string; rules: Analysis; model?: Analysis } = {
            caseId: ledger.id,
            rules,
          };
          if (options.model) {
            const project = app.tests.get(app.runs.get(runId).testId).projectId;
            const provider = app.model.config.modelProviders[0]!;
            app.model.grantConsent(
              project,
              provider.id,
              ["execution_evidence", "dom", "plans", "requirements", "documents", "code_summary"],
              true,
            );
            const existingCharge =
              app.database.get<{ used: number }>(
                "SELECT COALESCE(SUM(CASE WHEN state='reserved' THEN reserved_tokens ELSE COALESCE(charged_tokens,reserved_tokens) END),0) AS used FROM budget_reservations WHERE workspace_id=? AND project_id=? AND state<>'released'",
                app.context.workspaceId,
                project,
              )?.used ?? 0;
            app.usage.setBudget(project, {
              tokens:
                Number(existingCharge) + smokeLimits.conservativeTokens - state.conservativeTokens,
            });
            const before = new Set(
              app.usage.get({ projectId: project }).calls.map((call) => call.id),
            );
            const wireStart = state.wire.length;
            try {
              record.model = await app.analysis.analyze(runId, { model: true });
              ledger.utility.model = diagnosticUtility(record.model);
              const unsupportedClaims = unsupportedClaimsForRun(app, runId);
              if (unsupportedClaims !== undefined)
                ledger.utility.model.unsupportedClaims = unsupportedClaims;
              else if (record.model.source !== "model")
                delete ledger.utility.model.unsupportedClaims;
              ledger.diagnosis = {
                failureKind: record.model.failureKind,
                grounded: true,
                abstained: record.model.failureKind === "unknown",
              };
            } finally {
              const calls = app.usage
                .get({ projectId: project })
                .calls.filter((call) => !before.has(call.id));
              ledger.records.calls = calls.map((call) => ({
                id: call.id,
                model: call.model,
                latencyMs: call.latency,
                createdAt: call.createdAt,
                repairAttempt: call.repairAttempt,
                transportAttempt: call.transportAttempt,
                outcome: call.outcome,
                usage: call.usage,
                cost: call.cost,
              }));
              for (const call of calls) {
                ledger.usage.inputTokens += call.usage.inputTokens ?? 0;
                ledger.usage.outputTokens += call.usage.outputTokens ?? 0;
                ledger.usage.reasoningTokens += call.usage.reasoningTokens ?? 0;
                ledger.usage.unknownCalls += Number(
                  call.usage.inputTokens === null || call.usage.outputTokens === null,
                );
                ledger.usage.unknownCostCalls += Number(call.cost === "unknown");
                if (call.cost !== "unknown") ledger.usage.costs.push(call.cost);
                if (call.outcome === "failed" || call.outcome === "cancelled")
                  state.stopped ??= "first_provider_failure";
              }
              ledger.usage.conservativeCharge = state.wire
                .slice(wireStart)
                .reduce((sum, wire) => sum + wire.reservation, 0);
            }
            if (!(ledger.records.calls as unknown[]).length && record.model?.source === "model")
              throw new Error("Smoke model cache receipt reused; no live measurement");
          }
          analyses.push(record);
        } finally {
          app?.close();
          globalThis.fetch = originalFetch;
          await forwarder?.close();
        }
      });
    } catch (error) {
      ledger.status = "error";
      let detail = error instanceof Error ? error.message : "Replay operation failed";
      for (const [name, value] of Object.entries(process.env))
        if (value && /KEY|TOKEN|SECRET|PASSWORD|CANARY/i.test(name))
          detail = detail.replaceAll(value, "[REDACTED]");
      detail = detail.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 500);
      const code =
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : "replay_failed";
      ledger.errors.push({
        phase: "replay",
        code,
        messageHash: createHash("sha256").update(String(error)).digest("hex"),
        detail,
      });
      if (options.model) state.stopped ??= "smoke_operation_failed";
    }
    await writeFile(join(directory, `${ledger.id}.json`), JSON.stringify(ledger, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  const report = {
    development: true,
    registered: false,
    holdout: false,
    source: resultsDirectory,
    directory: relative(root, directory),
    modelSmoke: Boolean(options.model),
    smoke: state,
    skips,
    analyses,
    ledgers,
    score: scoreM3(
      ledgers,
      selected.map(({ planned }) => planned),
    ),
    limitations: [
      "Replay reuses development cases and post-hoc labels; it is not holdout, a registered round, or capability homologation.",
    ],
  };
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  return report;
}
