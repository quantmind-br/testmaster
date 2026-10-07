import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type BatchReceipt, ContractError, defaults, validate } from "@testmaster/contracts";
import {
  batchExitCode,
  exitCodeForError,
  exitCodeForRun,
  type Gate,
  semanticHash,
} from "@testmaster/domain";
import { ConfinedRoot } from "@testmaster/evidence";
import {
  exportJunit,
  exportMarkdown,
  type ReportSnapshot,
  reportGate,
} from "@testmaster/reporting";
import type { ArtifactsService, ReportsService } from "./artifacts.js";
import { isEvidenceUnavailable } from "./artifacts.js";
import { byteHash } from "./ci-envelope.js";
import { requireEntity } from "./context.js";
import type { AdmissionSnapshot } from "./provenance.js";
import type { BatchesService, RunsService } from "./runs.js";
import type { SelectionInput, SelectionReceipt, SelectionService } from "./selection.js";
import type { WorkerService } from "./worker.js";

export interface CiResult {
  schemaVersion: "1.0.0";
  kind: "batch" | "empty" | "admission_rejected";
  batchId: string | null;
  gate: Gate;
  exitCode: number;
  counts: BatchReceipt["counts"] | null;
  provenance: {
    assessedSha: string | null;
    checkoutSha: string | null;
    binding: "verified" | "unbound";
    targetBinding: "local-checkout" | "unbound";
  };
  selection: {
    requested: number;
    excluded: { testId: string; reason: string; owner: string | null; expiresAt: string | null }[];
    emptyReason: string | null;
    quarantinePolicy: "exclude" | "strict";
  };
  outputs: {
    report: string | null;
    junit: string | null;
    summary: string | null;
    bundleIndex: string | null;
  };
  bundles: {
    runId: string;
    state: "exported" | "missing" | "failed";
    path: string | null;
    error: string | null;
  }[];
  reportHash: string | null;
  error: { code: string; message: string } | null;
}
export type CiInput = SelectionInput & {
  outputDir: string;
  mode?: string;
  healingPolicy?: string;
  maxAttempts?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
};
export function assertStrictCi(
  input: Pick<CiInput, "mode" | "healingPolicy" | "maxAttempts">,
): void {
  if (
    (input.mode !== undefined && input.mode !== "replay") ||
    (input.healingPolicy !== undefined && input.healingPolicy !== "off") ||
    (input.maxAttempts !== undefined && input.maxAttempts !== 1)
  )
    throw new ContractError("POLICY_DENIED", "Strict CI forbids agent mode, healing and retries");
}
export async function openCiOutput(path: string): Promise<ConfinedRoot> {
  const absolute = resolve(path);
  const parent = new ConfinedRoot(dirname(absolute), true);
  try {
    try {
      parent.mkdirExclusive(basename(absolute));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const root = parent.openDirectory(basename(absolute));
    if ((await readdir(`/proc/self/fd/${root.fd}`)).length) {
      root.close();
      throw new ContractError("INVALID_ARGUMENT", "CI output directory must be empty");
    }
    // Exclusive claim also prevents concurrent invocations from sharing an empty directory.
    const claim = await root.openFile(".ci-owner", true);
    await claim.writeFile(randomUUID());
    await claim.close();
    return root;
  } finally {
    parent.close();
  }
}
async function writeAtomic(root: ConfinedRoot, name: string, content: string): Promise<void> {
  const temp = `${name}.${randomUUID()}.tmp`;
  const file = await root.openFile(temp, true);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  await root.rename(temp, name);
}
function interruptedExit(signal?: AbortSignal): number | null {
  if (!signal?.aborted) return null;
  const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
  return reason === "SIGTERM" ? 143 : reason === "SIGHUP" ? 129 : 130;
}
function provenance(
  snapshot: ReportSnapshot,
  runs: RunsService,
  targetUrl?: string,
): CiResult["provenance"] {
  const repositories = snapshot.runs.map((entry) => {
    const cell = entry.run.matrixCell as Record<string, unknown>;
    const admission = cell.admissionSnapshot as AdmissionSnapshot | undefined;
    const environment = requireEntity(
      runs.ctx,
      "EnvironmentRevision",
      entry.run.environmentRevisionId,
    );
    const matches = targetUrl && new URL(targetUrl).origin === cell.baseUrl;
    return {
      repository: admission?.repository,
      local: matches && environment.networkProfile === "local-loopback",
    };
  });
  const first = repositories[0]?.repository;
  const verified = Boolean(
    first?.commitSha &&
      first.checkoutSha &&
      repositories.every(
        (item) =>
          item.local &&
          item.repository?.binding === "verified" &&
          item.repository.dirtyHash === null &&
          item.repository.commitSha === first.commitSha &&
          item.repository.checkoutSha === first.checkoutSha,
      ),
  );
  return {
    assessedSha: first?.commitSha ?? null,
    checkoutSha: first?.checkoutSha ?? null,
    binding: verified ? "verified" : "unbound",
    targetBinding: verified ? "local-checkout" : "unbound",
  };
}
export class CiService {
  constructor(
    readonly selection: SelectionService,
    readonly batches: BatchesService,
    readonly runs: RunsService,
    readonly worker: WorkerService,
    readonly reports: ReportsService,
    readonly artifacts: ArtifactsService,
  ) {}
  async run(input: CiInput): Promise<CiResult> {
    const root = await openCiOutput(input.outputDir);
    let receipt: SelectionReceipt | undefined;
    let snapshot: ReportSnapshot | undefined;
    let failure: ContractError | undefined;
    const {
      outputDir: _out,
      signal,
      timeoutMs,
      mode,
      healingPolicy,
      maxAttempts,
      ...selection
    } = input;
    const controller = new AbortController();
    let owned: string[] = [];
    let ephemeral: string[] = [];
    const interrupt = () => {
      for (const id of owned) this.runs.cancel(id);
      controller.abort(signal?.reason);
    };
    signal?.addEventListener("abort", interrupt, { once: true });
    try {
      try {
        assertStrictCi({
          ...(mode !== undefined ? { mode } : {}),
          ...(healingPolicy !== undefined ? { healingPolicy } : {}),
          ...(maxAttempts !== undefined ? { maxAttempts } : {}),
        });
        if (signal?.aborted)
          throw new ContractError("UNAVAILABLE", "CI interrupted before admission");
        receipt = await this.selection.run(selection, { strict: true, wait: true });
        owned = receipt.allMembers;
        ephemeral = owned.filter((id) => {
          const cell = this.runs.get(id).matrixCell as Record<string, unknown>;
          return cell.ownership === "ephemeral";
        });
        if (signal?.aborted) interrupt();
        const work = ephemeral.length
          ? this.worker.run({ ephemeral: true, runIds: ephemeral, signal: controller.signal })
          : undefined;
        void work?.catch(() => {});
        try {
          const waiting = Promise.all(
            receipt.allMembers.map((id) =>
              this.runs.wait(id, {
                timeoutMs: timeoutMs ?? defaults.executionTimeoutMs + defaults.collectionGraceMs,
                ...(signal ? { signal } : {}),
              }),
            ),
          );
          if (work) await Promise.all([waiting, work]);
          else await waiting;
        } catch (error) {
          for (const id of owned) this.runs.cancel(id);
          controller.abort(error);
          // Collection is bounded independently of the interrupted wait.
          await Promise.race([
            Promise.allSettled([
              ...(work ? [work] : []),
              ...owned.map((id) =>
                this.runs.wait(id, {
                  timeoutMs: defaults.cancellationGraceMs + defaults.collectionGraceMs,
                }),
              ),
            ]),
            delay(defaults.cancellationGraceMs + defaults.collectionGraceMs),
          ]);
          if (!signal?.aborted && !(error instanceof ContractError)) throw error;
          failure =
            error instanceof ContractError
              ? error
              : new ContractError("UNAVAILABLE", "CI interrupted");
        }
        snapshot = await this.reports.snapshot(receipt.batchId);
        if (failure) {
          snapshot.completeness = {
            state: "partial",
            reasons: [
              ...snapshot.completeness.reasons,
              failure.details.waitTimeout === true
                ? "ci-wait-deadline-exceeded"
                : "ci-wait-interrupted",
            ],
          };
        }
        snapshot.selection = {
          ...snapshot.selection,
          excluded: receipt.excluded.map((item) => ({
            memberKey: item.testId,
            reasonCode: item.reason,
          })),
          ...(selection.emptyReason ? { emptyReason: selection.emptyReason } : {}),
        };
        if (!snapshot.runs.length) {
          const repository = await this.selection.preview(selection);
          snapshot.provenance = {
            assessedSha: repository.provenance.commitSha,
            checkoutSha: repository.provenance.checkoutSha,
            binding: "unbound",
            targetBinding: "unbound",
          };
        }
        if (snapshot.runs.length)
          snapshot.provenance = provenance(snapshot, this.runs, selection.targetUrl);
      } catch (error) {
        if (!(error instanceof ContractError) || receipt) throw error;
        failure = error;
      }
      const batch = receipt ? this.batches.get(receipt.batchId) : null;
      const aggregate = batch?.aggregate;
      const counts =
        aggregate && typeof aggregate === "object" && "counts" in aggregate
          ? (aggregate.counts as BatchReceipt["counts"])
          : null;
      const result: CiResult = {
        schemaVersion: "1.0.0",
        kind: receipt ? (receipt.allMembers.length ? "batch" : "empty") : "admission_rejected",
        batchId: receipt?.batchId ?? null,
        gate: snapshot ? reportGate(snapshot) : "failed",
        exitCode: failure ? exitCodeForError(failure.code) : 0,
        counts,
        provenance: snapshot?.provenance ?? {
          assessedSha: input.provenance?.commitSha ?? null,
          checkoutSha: input.provenance?.checkoutSha ?? null,
          binding: "unbound",
          targetBinding: "unbound",
        },
        selection: {
          requested: receipt?.requested ?? 0,
          excluded:
            receipt?.excluded.map(({ testId, reason, owner, expiresAt }) => ({
              testId,
              reason,
              owner,
              expiresAt,
            })) ?? [],
          emptyReason: selection.emptyReason ?? null,
          quarantinePolicy: selection.quarantinePolicy ?? "exclude",
        },
        outputs: {
          report: join(root.path, "report.json"),
          junit: join(root.path, "junit.xml"),
          summary: join(root.path, "summary.md"),
          bundleIndex: join(root.path, "bundle-index.json"),
        },
        bundles: [],
        reportHash: snapshot ? semanticHash(snapshot) : null,
        error: failure ? { code: failure.code, message: failure.message } : null,
      };
      if (snapshot) {
        const codes = snapshot.runs.map((entry) => exitCodeForRun(entry.result));
        result.exitCode = batchExitCode([
          ...codes,
          ...(result.exitCode ? [result.exitCode] : []),
          result.gate === "not_applicable" ? 0 : result.gate === "passed" ? 0 : 1,
        ]);
        for (const entry of snapshot.runs) {
          const path = join(root.path, "bundles", entry.run.id);
          try {
            await this.artifacts.exportSanitized(entry.run.id, path);
            result.bundles.push({ runId: entry.run.id, state: "exported", path, error: null });
          } catch (error) {
            if (!isEvidenceUnavailable(error)) throw error;
            result.bundles.push({
              runId: entry.run.id,
              state: error instanceof ContractError ? "missing" : "failed",
              path: null,
              error: error.message,
            });
            result.gate = "failed";
            if (!result.exitCode) result.exitCode = 1;
          }
        }
        if (result.bundles.some((bundle) => bundle.state !== "exported")) {
          snapshot.completeness = {
            state: "partial",
            reasons: [
              ...snapshot.completeness.reasons,
              ...result.bundles
                .filter((bundle) => bundle.state !== "exported")
                .map((bundle) => `bundle-export:${bundle.runId}:${bundle.state}`),
            ],
          };
          result.reportHash = semanticHash(snapshot);
        }
      }
      if (!snapshot)
        result.reportHash = semanticHash({
          kind: result.kind,
          error: result.error,
          provenance: result.provenance,
        });
      result.exitCode = interruptedExit(signal) ?? result.exitCode;
      validate("CiResult", result);
      const envelope = JSON.stringify(
        { schemaVersion: "1.0.0", result, report: snapshot ?? null },
        null,
        2,
      );
      await writeAtomic(root, "report.json", envelope);
      await writeAtomic(
        root,
        "junit.xml",
        snapshot
          ? exportJunit(snapshot)
          : '<testsuites tests="1" failures="1"><testsuite name="CI admission" tests="1" failures="1"><testcase name="admission"><failure message="Admission rejected"/></testcase></testsuite></testsuites>',
      );
      await writeAtomic(
        root,
        "summary.md",
        snapshot
          ? exportMarkdown(snapshot)
          : `# CI admission rejected\n\nCode: ${failure?.code ?? "UNAVAILABLE"}\n`,
      );
      await writeAtomic(root, "bundle-index.json", JSON.stringify(result.bundles, null, 2));
      const hashes: Record<string, string> = {};
      for (const name of ["report.json", "junit.xml", "summary.md", "bundle-index.json"])
        hashes[name] = byteHash(await readFile(join(root.path, name), "utf8"));
      await writeAtomic(
        root,
        "completion.json",
        JSON.stringify({ schemaVersion: "1.0.0", invocationId: randomUUID(), files: hashes }),
      );
      await root.sync();
      if (result.batchId)
        this.batches.ctx.database.run(
          "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING",
          `ci:result:${this.batches.ctx.workspaceId}:${result.batchId}`,
          JSON.stringify(result),
        );
      return result;
    } finally {
      signal?.removeEventListener("abort", interrupt);
      root.close();
    }
  }
}
