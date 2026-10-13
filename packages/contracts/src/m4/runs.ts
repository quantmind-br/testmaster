import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { ExecutionMetrics } from "../metrics.js";
import * as P from "../primitives.js";
import { reasonCodes } from "../registries.js";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** Lifetime of a signed artifact gateway link (UX-032). */
export const ARTIFACT_LINK_TTL_SECONDS = 300;

/** One Attempt of a Run with the policy and reason that made it run (UX-029). */
const AttemptView = P.Obj({
  id: P.id("att"),
  runId: P.id("run"),
  number: P.Version,
  workerId: nullable(P.id("wrk")),
  phase: P.Phase,
  startedAt: nullable(P.Timestamp),
  endedAt: nullable(P.Timestamp),
  outcome: nullable(P.Outcome),
  kind: P.Enum(["initial", "retry"]),
  /** Pinned retry policy of the Run; never inferred from this Attempt's result. */
  policy: P.Obj({ maxAttempts: P.Positive }),
  /**
   * Why a retry exists. `infrastructure` is a retry-safe recovery of an inconclusive Attempt;
   * `diagnostic` re-runs after a proven failure. Null for the first Attempt.
   */
  retry: nullable(
    P.Obj({
      previousAttemptId: P.id("att"),
      previousOutcome: nullable(P.Outcome),
      category: P.Enum(["infrastructure", "diagnostic"]),
      reasonCode: nullable(P.Enum(reasonCodes)),
    }),
  ),
});

export const runViewContracts = {
  AttemptView,
  ArtifactLinkInput: P.Obj({
    /** `inline` (default) renders in a sandboxed frame or image; `attachment` forces a download. */
    disposition: Type.Optional(P.Enum(["inline", "attachment"])),
  }),
  /** A capability URL: single artifact, single method, short lived, re-authorized on every use. */
  ArtifactLink: P.Obj({
    artifactId: P.id("art"),
    method: Type.Literal("GET"),
    disposition: P.Enum(["inline", "attachment"]),
    url: Type.String({ minLength: 1, maxLength: 2048 }),
    expiresAt: P.Timestamp,
    ttlSeconds: Type.Literal(ARTIFACT_LINK_TTL_SECONDS),
  }),
  /** Dashboard metrics over the most recent Runs of one project (VAL-007). */
  ProjectMetrics: P.Obj({
    projectId: P.id("prj"),
    window: P.Obj({ since: P.Timestamp, until: P.Timestamp }),
    considered: P.Nonnegative,
    /** True when more Runs matched the window than the cap; the metrics then cover the newest ones. */
    truncated: Type.Boolean(),
    metrics: ExecutionMetrics,
    quarantined: Type.Array(
      P.Obj({
        testId: P.id("tst"),
        owner: P.EntityId,
        reason: Type.String({ minLength: 1, maxLength: 2000 }),
        expiresAt: P.Timestamp,
        active: Type.Boolean(),
        runsInWindow: P.Nonnegative,
        failedRunsInWindow: P.Nonnegative,
      }),
    ),
    limitations: Type.Array(P.Description),
  }),
};
export type AttemptView = Static<typeof runViewContracts.AttemptView>;
export type ArtifactLink = Static<typeof runViewContracts.ArtifactLink>;
export type ProjectMetrics = Static<typeof runViewContracts.ProjectMetrics>;
