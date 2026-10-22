import { type Static, Type } from "@sinclair/typebox";
import { runResponseContracts } from "../m4/responses-runs.js";
import * as P from "../primitives.js";
import { ProbeSpec } from "./probes.js";

export const probeContracts = {
  ProbeSpec,
  ProbeInput: P.Obj({
    spec: ProbeSpec,
    name: Type.Optional(P.Name),
  }),
  /** A replay plan a failed property probe stored, by its bundle-relative path. */
  ReproductionInput: P.Obj({
    artifact: Type.String({ pattern: "^property/[1-9][0-9]{0,5}-replay\\.plan\\.json$" }),
  }),
  /** The test created from the replay plan and its admitted Run (ADR-033). */
  ReproductionReceipt: P.Obj({
    testId: P.id("tst"),
    ...runResponseContracts.OwnedRunReceipt.properties,
  }),
};
export type ProbeInput = Static<typeof probeContracts.ProbeInput>;
export type ReproductionInput = Static<typeof probeContracts.ReproductionInput>;
export type ReproductionReceipt = Static<typeof probeContracts.ReproductionReceipt>;
