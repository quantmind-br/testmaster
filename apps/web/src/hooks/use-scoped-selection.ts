import { useCallback, useState } from "react";
import { createScopedSelection, type ScopedSelection, selectionForScope } from "../lib/selection";

export interface UseScopedSelection {
  readonly selected: ReadonlySet<string>;
  readonly count: number;
  toggle(id: string): void;
  setAll(ids: readonly string[]): void;
  clear(): void;
}

/**
 * A multi-select that belongs to one scope (workspace, project, environment). Changing `scope`
 * drops the selection, so a choice made for project A can never be submitted for project B.
 */
export function useScopedSelection(scope: string): UseScopedSelection {
  const [state, setState] = useState<ScopedSelection>(() => createScopedSelection(scope));
  const current = selectionForScope(state, scope);
  const update = useCallback(
    (next: (value: ScopedSelection) => ScopedSelection) =>
      setState((value) => next(selectionForScope(value, scope))),
    [scope],
  );
  return {
    selected: current.ids,
    count: current.ids.size,
    toggle: (id) =>
      update((value) => {
        const ids = new Set(value.ids);
        if (ids.has(id)) ids.delete(id);
        else ids.add(id);
        return { scope, ids };
      }),
    setAll: (ids) => update(() => ({ scope, ids: new Set(ids) })),
    clear: () => update(() => ({ scope, ids: new Set() })),
  };
}
