import { type Static, Type } from "@sinclair/typebox";
import { entities } from "../entities.js";
import * as P from "../primitives.js";

/**
 * Where a project memory entry stands (ADR-034). Only `active` entries reach a prompt: approved,
 * inside `validFrom`/`expiresAt`, not forgotten, and every source revision they cite still current.
 */
export const memoryStates = [
  "pending",
  "active",
  "scheduled",
  "expired",
  "stale",
  "forgotten",
] as const;

const MemoryText = Type.String({ minLength: 1, maxLength: 2000 });
const MemoryRefs = Type.Array(P.EvidenceRef, { minItems: 1, maxItems: 20 });
// `MemoryEntry` redeclares the entity's optional `version`; spreading both would intersect them.
const { version: _version, ...memoryEntryFields } = entities.MemoryEntry.properties;
/** A stored entry with the state its approval, validity window, tombstone and sources give it. */
const MemoryEntryView = P.Obj({
  ...memoryEntryFields,
  version: P.Version,
  state: P.Enum(memoryStates),
  /** Cited source revisions that are no longer the active revision of a live source. */
  staleRefs: Type.Array(P.EvidenceRef),
});

export const memoryContracts = {
  /** A factual statement with its origin; it is data in every prompt, never an instruction. */
  MemoryEntryInput: P.Obj({
    text: MemoryText,
    sourceRefs: MemoryRefs,
    validFrom: Type.Optional(P.Timestamp),
    expiresAt: Type.Optional(Type.Union([P.Timestamp, Type.Null()])),
  }),
  /** An edit clears the approval, so the changed fact is reviewed again; `approve` stands alone. */
  MemoryEntryPatchInput: P.Obj({
    expectedVersion: P.Version,
    text: Type.Optional(MemoryText),
    sourceRefs: Type.Optional(MemoryRefs),
    validFrom: Type.Optional(P.Timestamp),
    expiresAt: Type.Optional(Type.Union([P.Timestamp, Type.Null()])),
    approve: Type.Optional(Type.Literal(true)),
    reason: Type.Optional(P.DecisionReason),
  }),
  MemoryEntryView,
};
export type MemoryState = (typeof memoryStates)[number];
export type MemoryEntryInput = Static<typeof memoryContracts.MemoryEntryInput>;
export type MemoryEntryPatchInput = Static<typeof memoryContracts.MemoryEntryPatchInput>;
export type MemoryEntryView = Static<typeof memoryContracts.MemoryEntryView>;
