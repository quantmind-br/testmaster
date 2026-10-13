import { type KeyboardEvent, type ReactNode, useMemo } from "react";
import { stableOrder } from "../lib/table-model";

export type SortDirection = "ascending" | "descending";
export interface SortState {
  readonly key: string;
  readonly direction: SortDirection;
}

export interface Column<T> {
  readonly key: string;
  readonly header: string;
  readonly render: (row: T) => ReactNode;
  /** Present when the column can be sorted (client side, over the loaded rows). */
  readonly sortValue?: (row: T) => string | number;
}

interface DataTableProps<T> {
  readonly caption: string;
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly sort?: SortState | null;
  readonly onSortChange?: (sort: SortState | null) => void;
  readonly pager?: {
    readonly hasMore: boolean;
    readonly loading: boolean;
    readonly onLoadMore: () => void;
  };
  readonly empty?: ReactNode;
}

const focusable = "a[href], button:not([disabled])";

/** Moves focus between rows with the arrow keys; Tab order is untouched. */
function navigate(event: KeyboardEvent<HTMLTableSectionElement>): void {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const row = target.closest("tr");
  const rows = [...event.currentTarget.querySelectorAll("tr")];
  const index = row ? rows.indexOf(row) : -1;
  if (index < 0) return;
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
  const destination = rows[next]?.querySelector<HTMLElement>(focusable);
  if (!destination) return;
  event.preventDefault();
  destination.focus();
}

export function DataTable<T>(props: DataTableProps<T>): ReactNode {
  const { columns, sort } = props;
  const rows = useMemo(() => {
    const column = columns.find((candidate) => candidate.key === sort?.key);
    if (!column?.sortValue || !sort) return props.rows;
    return stableOrder(props.rows, column.sortValue, sort.direction, props.rowKey);
  }, [props.rows, props.rowKey, columns, sort]);

  function toggle(column: Column<T>): void {
    if (!props.onSortChange) return;
    if (sort?.key !== column.key) props.onSortChange({ key: column.key, direction: "ascending" });
    else if (sort.direction === "ascending")
      props.onSortChange({ key: column.key, direction: "descending" });
    else props.onSortChange(null);
  }

  if (rows.length === 0 && props.empty) return props.empty;
  return (
    <div>
      {/* biome-ignore lint/a11y/useSemanticElements: a named scroll region keeps its caption */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll it */}
      <div className="table-scroll" role="region" aria-label={props.caption} tabIndex={0}>
        <table className="data">
          <caption>{props.caption}</caption>
          <thead>
            <tr>
              {columns.map((column) => {
                const sorted = sort?.key === column.key ? sort.direction : "none";
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={column.sortValue ? sorted : undefined}
                  >
                    {column.sortValue && props.onSortChange ? (
                      <button type="button" className="link-button" onClick={() => toggle(column)}>
                        {column.header}
                        <span aria-hidden="true">
                          {sorted === "ascending" ? " ▲" : sorted === "descending" ? " ▼" : ""}
                        </span>
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody onKeyDown={navigate}>
            {rows.map((row) => (
              <tr key={props.rowKey(row)}>
                {columns.map((column) => (
                  <td key={column.key}>{column.render(row)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.pager ? (
        <div className="pager">
          <span>{rows.length} loaded</span>
          {props.pager.hasMore ? (
            <button
              type="button"
              className="button secondary"
              aria-busy={props.pager.loading}
              aria-disabled={props.pager.loading}
              onClick={() => {
                if (!props.pager?.loading) props.pager?.onLoadMore();
              }}
            >
              {props.pager.loading ? "Loading…" : "Load more"}
            </button>
          ) : (
            <span>End of list</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
