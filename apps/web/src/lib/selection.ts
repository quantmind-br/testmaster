export interface ScopedSelection {
  readonly scope: string;
  readonly ids: ReadonlySet<string>;
}

export function createScopedSelection(scope: string): ScopedSelection {
  return { scope, ids: new Set() };
}

/**
 * What a bulk action may do for a selection. An empty selection never falls back to "everything":
 * the action is blocked with a stated reason (UX-055).
 */
export interface BulkPlan {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly count: number;
}

export function planBulkAction(count: number, noun: string): BulkPlan {
  if (count <= 0)
    return {
      allowed: false,
      reason: `Select at least one ${noun}. Nothing is applied to the whole list by default.`,
      count: 0,
    };
  return { allowed: true, reason: null, count };
}

/** A selection made under another scope is dropped: it can never be applied to this scope. */
export function selectionForScope(state: ScopedSelection, scope: string): ScopedSelection {
  return state.scope === scope ? state : createScopedSelection(scope);
}
