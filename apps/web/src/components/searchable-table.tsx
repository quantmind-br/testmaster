import { type ReactNode, useEffect, useId, useMemo } from "react";
import { useUrlState } from "../hooks/use-url-state";
import { applyFilters, searchRows, type TableFilter, tableEmptiness } from "../lib/table-model";
import { enumField, stringField, type UrlSchema } from "../lib/url-state";
import { type Column, DataTable, type SortDirection, type SortState } from "./data-table";
import { useAnnounce } from "./live-region";
import { ViewState } from "./view-state";

interface SearchableTableProps<T> {
  readonly caption: string;
  readonly columns: readonly Column<T>[];
  /** Rows loaded so far; the server owns paging. */
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  /** The text a search term is matched against. */
  readonly searchText: (row: T) => string;
  readonly filters?: readonly TableFilter<T>[];
  /** Shown when nothing is loaded at all (distinct from "no matches"). */
  readonly empty: ReactNode;
  readonly pager?: {
    readonly hasMore: boolean;
    readonly loading: boolean;
    readonly onLoadMore: () => void;
  };
  /** Distinguishes several tables on one page in the URL (`<prefix>q`, `<prefix>sort`, …). */
  readonly urlPrefix?: string;
}

/**
 * Search, filters and sort persisted in the URL (UX-008), over the rows already loaded. A filter
 * that matches nothing says so; it never looks like an empty list or a load failure.
 */
export function SearchableTable<T>(props: SearchableTableProps<T>): ReactNode {
  const prefix = props.urlPrefix ?? "";
  const filters = props.filters ?? [];
  const sortable = props.columns.filter((column) => column.sortValue).map((column) => column.key);
  const signature = [
    prefix,
    sortable.join(","),
    filters.map((filter) => filter.key).join(","),
  ].join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` is the stable form of the inputs
  const schema = useMemo<UrlSchema>(
    () => ({
      [`${prefix}q`]: stringField("", 100),
      [`${prefix}sort`]: enumField(["", ...sortable], ""),
      [`${prefix}dir`]: enumField(["ascending", "descending"] as const, "ascending"),
      ...Object.fromEntries(
        filters.map((filter) => [`${prefix}${filter.key}`, stringField("", 60)]),
      ),
    }),
    [signature],
  );
  const [values, setValues] = useUrlState(schema) as unknown as [
    Record<string, string>,
    (patch: Record<string, string>) => void,
  ];
  const announce = useAnnounce();
  const searchId = useId();
  const query = values[`${prefix}q`] ?? "";
  const sortKey = values[`${prefix}sort`] ?? "";
  const direction = (values[`${prefix}dir`] ?? "ascending") as SortDirection;
  const filterValues = Object.fromEntries(
    filters.map((filter) => [filter.key, values[`${prefix}${filter.key}`] ?? ""]),
  );
  const narrowed = applyFilters(props.rows, filters, filterValues);
  const shown = searchRows(narrowed, query, props.searchText);
  const emptiness = tableEmptiness(props.rows.length, shown.length);
  const narrowing =
    query !== "" || filters.some((filter) => (filterValues[filter.key] ?? "") !== "");
  const sort: SortState | null = sortKey === "" ? null : { key: sortKey, direction };

  // One polite sentence per change of result, never per keystroke burst (the announcer coalesces).
  useEffect(() => {
    if (!narrowing) return;
    announce(`${shown.length} of ${props.rows.length} loaded rows shown`);
  }, [narrowing, shown.length, props.rows.length, announce]);

  function clear(): void {
    setValues({
      [`${prefix}q`]: "",
      ...Object.fromEntries(filters.map((filter) => [`${prefix}${filter.key}`, ""])),
    });
  }

  return (
    <div className="searchable-table">
      <search className="table-controls" aria-label={`Search and filter ${props.caption}`}>
        <div className="field">
          <label htmlFor={searchId}>Search {props.caption.toLowerCase()}</label>
          <input
            id={searchId}
            type="search"
            value={query}
            maxLength={100}
            autoComplete="off"
            onChange={(event) => setValues({ [`${prefix}q`]: event.target.value })}
          />
        </div>
        {filters.map((filter) => (
          <FilterSelect
            key={filter.key}
            filter={filter}
            value={filterValues[filter.key] ?? ""}
            onChange={(value) => setValues({ [`${prefix}${filter.key}`]: value })}
          />
        ))}
        {narrowing ? (
          <button type="button" className="button secondary" onClick={clear}>
            Clear search and filters
          </button>
        ) : null}
      </search>
      <p className="hint" data-testid="table-count">
        {narrowing
          ? `${shown.length} of ${props.rows.length} loaded rows shown`
          : `${props.rows.length} loaded rows`}
        {props.pager?.hasMore ? "; more rows are available on the server" : ""}
      </p>
      {emptiness === "empty" ? (
        props.empty
      ) : emptiness === "no-matches" ? (
        <ViewState
          kind="empty"
          title="No matching rows"
          message={`No loaded rows match the current search or filters.${
            props.pager?.hasMore ? " Load more rows to search further." : ""
          }`}
          action={
            <button type="button" className="button secondary" onClick={clear}>
              Clear search and filters
            </button>
          }
        />
      ) : null}
      {emptiness === "has-rows" ? (
        <DataTable
          caption={props.caption}
          columns={props.columns}
          rows={shown}
          rowKey={props.rowKey}
          sort={sort}
          onSortChange={(next) =>
            setValues(
              next
                ? { [`${prefix}sort`]: next.key, [`${prefix}dir`]: next.direction }
                : { [`${prefix}sort`]: "", [`${prefix}dir`]: "ascending" },
            )
          }
          {...(props.pager ? { pager: props.pager } : {})}
        />
      ) : props.pager?.hasMore ? (
        <div className="pager">
          <button
            type="button"
            className="button secondary"
            aria-disabled={props.pager.loading}
            onClick={() => {
              if (!props.pager?.loading) props.pager?.onLoadMore();
            }}
          >
            {props.pager.loading ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function FilterSelect<T>({
  filter,
  value,
  onChange,
}: {
  filter: TableFilter<T>;
  value: string;
  onChange: (value: string) => void;
}): ReactNode {
  const id = useId();
  const known = filter.options.some((option) => option.value === value);
  return (
    <div className="field">
      <label htmlFor={id}>{filter.label}</label>
      <select id={id} value={known ? value : ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">All</option>
        {filter.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
