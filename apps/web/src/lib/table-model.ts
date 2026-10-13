/**
 * Client-side table helpers for the rows that are already loaded. The server owns cursors and
 * paging; search and filters here narrow what is on screen and say so ("N of M loaded rows").
 */

/** Every whitespace-separated term must appear, case-insensitively, in the row's text. */
export function searchRows<T>(
  rows: readonly T[],
  query: string,
  text: (row: T) => string,
): readonly T[] {
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return rows;
  return rows.filter((row) => {
    const haystack = text(row).toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export interface TableFilter<T> {
  readonly key: string;
  readonly label: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  /** `value` is never the empty "all" option here. */
  readonly match: (row: T, value: string) => boolean;
}

export function applyFilters<T>(
  rows: readonly T[],
  filters: readonly TableFilter<T>[],
  values: Readonly<Record<string, string>>,
): readonly T[] {
  return filters.reduce((current, filter) => {
    const value = values[filter.key] ?? "";
    // A value that is not one of the options is ignored: an unknown filter is not an error.
    if (value === "" || !filter.options.some((option) => option.value === value)) return current;
    return current.filter((row) => filter.match(row, value));
  }, rows);
}

/** Stable total order: ties on the sort value fall back to the row key. */
export function stableOrder<T>(
  rows: readonly T[],
  sortValue: (row: T) => string | number,
  direction: "ascending" | "descending",
  rowKey: (row: T) => string,
): T[] {
  const factor = direction === "ascending" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sortValue(a);
    const right = sortValue(b);
    if (left !== right) return (left < right ? -1 : 1) * factor;
    const leftKey = rowKey(a);
    const rightKey = rowKey(b);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

/** What a table with a filter shows when there are no rows to render. */
export type TableEmptiness = "has-rows" | "empty" | "no-matches";

export function tableEmptiness(loaded: number, shown: number): TableEmptiness {
  if (shown > 0) return "has-rows";
  return loaded === 0 ? "empty" : "no-matches";
}
