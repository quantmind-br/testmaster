import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ContractError } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import {
  type AuxiliaryFence,
  AuxiliaryLeaseRepository,
  StaleFenceError,
} from "@testmaster/persistence";
import type { ServiceContext } from "../context.js";
import { AUXILIARY_LEASE_MS, keepLeaseAlive } from "./job-lease.js";

const POLL_MS = 50;
/** Bounds the job row: a waiter only needs the commits made after the base it saw. */
const MAX_COMMIT_RECORDS = 20;
const LOCK_HASH = semanticHash({ lock: "requirements-normalization" });

/** A snapshot a normalization committed, as the next holder of the project's lock sees it. */
export type NormalizationCommit = {
  /** Snapshot version the normalization started from. */
  baseVersion: number;
  version: number;
  fingerprint: string;
  /** `normalizationInputsKey` of the request that produced it. */
  inputs: string;
};

/** What makes two normalization requests ask for the same thing: the source revisions and the model. */
export function normalizationInputsKey(input: {
  sourceRevisionIds: readonly string[];
  provider?: string | undefined;
  model?: string | undefined;
}): string {
  return semanticHash({
    sourceRevisionIds: [...new Set(input.sourceRevisionIds)].sort(),
    provider: input.provider ?? null,
    model: input.model ?? null,
  });
}

/**
 * The exclusive right to normalize one project. It is held for the whole normalization and renewed
 * while the model runs, so only a holder that stopped (a crashed process) lets it expire.
 */
export class NormalizationHold {
  constructor(
    private readonly leases: AuxiliaryLeaseRepository,
    private readonly fence: AuxiliaryFence,
    private readonly lease: { stop(): void },
    private commits: NormalizationCommit[],
  ) {}
  /** The commit an earlier holder made from `baseVersion` for the same inputs, if any. */
  committed(baseVersion: number, inputs: string): NormalizationCommit | undefined {
    return this.commits.find(
      (commit) => commit.baseVersion === baseVersion && commit.inputs === inputs,
    );
  }
  /**
   * Remembers a commit for the callers waiting behind this holder. Call it inside the commit
   * transaction, so a commit and its record are stored together. Losing the lease only loses the
   * record: the version check still protects the base.
   */
  record(commit: NormalizationCommit): void {
    this.commits = [...this.commits, commit].slice(-MAX_COMMIT_RECORDS);
    try {
      this.leases.mark(this.fence, { commits: this.commits });
    } catch (error) {
      if (!(error instanceof StaleFenceError)) throw error;
    }
  }
  release(): void {
    this.lease.stop();
    try {
      this.leases.finish(this.fence, "completed", {});
    } catch (error) {
      if (!(error instanceof StaleFenceError)) throw error;
    }
  }
}

/**
 * Waits until no other normalization of `projectId` runs, in this process or another one sharing
 * the database, then takes the lock. A model call has no deadline, so the wait has none either;
 * only `signal` ends it.
 */
export async function holdNormalization(
  ctx: ServiceContext,
  projectId: string,
  signal?: AbortSignal,
): Promise<NormalizationHold> {
  const leases = new AuxiliaryLeaseRepository(ctx.database);
  const owner = `normalization-${randomUUID()}`;
  const payload = {
    operation: "normalize",
    targetId: projectId,
    actorId: ctx.principalId,
    evidenceHash: LOCK_HASH,
    configHash: LOCK_HASH,
    options: {},
  };
  for (;;) {
    if (signal?.aborted)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Normalization cancelled while another normalization of this project was running",
      );
    const fence = leases.claimExclusive({
      workspaceId: ctx.workspaceId,
      owner,
      queue: "normalization",
      payload,
      leaseMs: AUXILIARY_LEASE_MS,
    });
    if (fence) {
      const earlier = fence.job.progress.commits;
      const commits = Array.isArray(earlier) ? (earlier as NormalizationCommit[]) : [];
      return new NormalizationHold(leases, fence, keepLeaseAlive(leases, fence), commits);
    }
    // A holder that stopped stops renewing its lease, and the expiry hands the lock over. Only an
    // abort rejects the delay; the loop head turns it into the error above.
    await delay(POLL_MS, undefined, signal ? { signal } : undefined).catch(() => undefined);
  }
}
