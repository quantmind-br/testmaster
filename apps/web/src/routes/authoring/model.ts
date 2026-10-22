/** Shapes the authoring pages read from `/v1`; they mirror the catalog contracts in `packages/contracts`. */

export interface PlanStep {
  readonly id: string;
  readonly kind: string;
  readonly [field: string]: unknown;
}

export interface Plan {
  readonly kind: string;
  readonly name: string;
  readonly type?: string;
  readonly runner?: string;
  readonly requirementRefs?: readonly string[];
  readonly steps?: readonly PlanStep[];
}

export interface BatchDoc {
  readonly id: string;
  readonly projectId: string;
  readonly state: "proposed" | "accepted" | "rejected" | "stale";
  readonly version: number;
  readonly createdAt: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface ProposalDoc {
  readonly id: string;
  readonly batchId: string;
  readonly state: "proposed" | "accepted" | "rejected";
  readonly version: number;
  readonly plan: Plan;
  readonly requirementRefs: readonly string[];
  readonly warnings: readonly string[];
  readonly validation: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface BatchDetail {
  readonly batch: BatchDoc;
  readonly proposals: readonly ProposalDoc[];
}

export interface BatchSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly projectId: string;
  readonly state: BatchDoc["state"];
  readonly version: number;
  readonly origin: string;
  readonly refinesTestId: string | null;
  readonly stale: boolean;
  readonly staleReason: string | null;
  readonly counts: {
    readonly proposed: number;
    readonly accepted: number;
    readonly rejected: number;
  };
  readonly modelCallId: string | null;
}

export interface Issue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly field: string;
  readonly stepId: string | null;
  readonly message: string;
}

export interface Validation {
  readonly valid: boolean;
  readonly runnable: boolean;
  readonly issues: readonly Issue[];
  readonly checked: readonly string[];
}

export interface Similar {
  readonly kind: "test" | "proposal";
  readonly id: string;
  readonly name: string;
  readonly score: number;
  readonly exactDuplicate: boolean;
}

export interface PreviewItem {
  readonly proposalId: string;
  readonly state: string;
  readonly selectable: boolean;
  readonly validation: {
    readonly structural: string;
    readonly semantic: string;
    readonly issues: readonly Issue[];
  };
  readonly revision: {
    readonly action: "create_test" | "create_revision";
    readonly testId: string | null;
    readonly testName: string;
    readonly ordinal: number;
    readonly parentRevisionId: string | null;
    readonly origin: string;
    readonly runner: string;
    readonly type: string;
    readonly stepCount: number;
    readonly assertionCount: number;
    readonly estimate: {
      readonly unit: "seconds";
      readonly min: number;
      readonly max: number;
      readonly reason: string;
    };
  } | null;
  readonly authorship: {
    readonly generatedBy: string | null;
    readonly humanEdits: readonly { readonly principalId: string; readonly at: string }[];
    readonly refinedFrom: string | null;
  };
  readonly similar: readonly Similar[];
  readonly needsDecision: boolean;
}

export interface Preview {
  readonly batchId: string;
  readonly batchVersion: number;
  readonly batchState: string;
  readonly stale: boolean;
  readonly staleReason: string | null;
  readonly policy: {
    readonly canAccept: boolean;
    readonly reason: string | null;
    readonly text: string;
  };
  readonly items: readonly PreviewItem[];
  readonly blocked: boolean;
}

export interface Receipt {
  readonly accepted: readonly string[];
  readonly retained: readonly string[];
  readonly rejected: readonly string[];
}

export interface TestDoc {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly priority: string;
  readonly archivedAt: string | null;
  readonly activeRevisionId: string | null;
  readonly version: number;
  readonly createdAt?: string;
}

export interface RevisionDoc {
  readonly id: string;
  readonly testId: string;
  readonly ordinal: number;
  readonly contentHash: string;
  readonly plan: Plan | null;
  /** A property probe's generator configuration; such a revision has no plan (ADR-033). */
  readonly probe?: unknown;
  readonly origin: string;
  readonly author: string;
  readonly parentId: string | null;
  readonly createdAt: string;
}

export type RevisionState = "current" | "candidate" | "superseded" | "accepted";
export type ChangeKind = "initial" | "intent_assertion" | "operational" | "source_model";
export type Authorship = "human" | "llm" | "healing" | "import";

export interface HistoryEntry {
  readonly id: string;
  readonly ordinal: number;
  readonly createdAt: string;
  readonly author: string;
  readonly origin: string;
  readonly authorship: Authorship;
  readonly humanEdited: boolean;
  readonly parentId: string | null;
  readonly changeKinds: readonly ChangeKind[];
  readonly assertionChanges: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
  };
  readonly operationalChanges: readonly string[];
  readonly justification: string | null;
  readonly proposalId: string | null;
  readonly healingProposalId: string | null;
  readonly modelCallId: string | null;
  readonly states: readonly RevisionState[];
  readonly promotedAt: string | null;
}

export interface DraftDoc {
  readonly id: string;
  readonly testId: string;
  readonly baseRevisionId: string;
  readonly plan: unknown;
  readonly version: number;
  readonly updatedAt: string;
  readonly baseSuperseded: boolean;
}

export interface RunDoc {
  readonly id: string;
  readonly testId: string;
  readonly revisionId: string;
  readonly status: string;
  readonly createdAt: string;
}

export interface Thread {
  readonly subject: { readonly kind: "proposal" | "test"; readonly id: string };
  readonly turns: readonly {
    readonly id: string;
    readonly seq: number;
    readonly role: "user" | "assistant";
    readonly content: string;
    readonly principalId: string;
    readonly createdAt: string;
  }[];
  readonly proposal: { readonly id: string; readonly batchId: string } | null;
}

export const changeKindLabels: Readonly<Record<ChangeKind, string>> = {
  initial: "Initial revision",
  intent_assertion: "Intent or assertion change",
  operational: "Operational adjustment",
  source_model: "Source or model change",
};

export const authorshipLabels: Readonly<Record<Authorship, string>> = {
  human: "Written by a person",
  llm: "Generated by the model",
  healing: "Auto-heal",
  import: "Imported",
};

export function flattenPlanSteps(plan: Plan | null | undefined): readonly PlanStep[] {
  return plan?.steps ?? [];
}

export function prettyPlan(plan: unknown): string {
  return JSON.stringify(plan, null, 2);
}

/** Parses editor text; the error names what is wrong so the field can show it. */
export function parsePlanText(
  text: string,
): { plan: unknown; error: null } | { plan: null; error: string } {
  try {
    const plan: unknown = JSON.parse(text);
    if (typeof plan !== "object" || plan === null || Array.isArray(plan))
      return { plan: null, error: "The plan must be a JSON object." };
    return { plan, error: null };
  } catch (error) {
    return {
      plan: null,
      error: `The text is not valid JSON: ${error instanceof Error ? error.message : "parse error"}`,
    };
  }
}

export function enc(value: string): string {
  return encodeURIComponent(value);
}
