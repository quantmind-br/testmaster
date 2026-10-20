import { ApiError, type ApiResult } from "./client";
import { createStore, type Store } from "./store";

export type ViewStatus = "loading" | "ready" | "empty" | "error" | "not-found" | "forbidden";

function failureStatus(error: ApiError, hideExistence: boolean): ViewStatus {
  if (error.code === "NOT_FOUND") return "not-found";
  if (error.code === "FORBIDDEN") return hideExistence ? "not-found" : "forbidden";
  return "error";
}

function asApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError(0, "unknown", { code: "INTERNAL", message: String(error) });
}

export interface ResourceState<T> {
  readonly status: ViewStatus;
  readonly data: T | null;
  readonly etag: string | null;
  readonly error: ApiError | null;
  /** True while a reload runs over data that is already displayed. */
  readonly refreshing: boolean;
}

export interface ResourceController<T> {
  readonly store: Store<ResourceState<T>>;
  reload(): Promise<void>;
  dispose(): void;
}

export interface ResourceOptions<T> {
  readonly load: (signal: AbortSignal) => Promise<ApiResult<T>>;
  /** Map FORBIDDEN onto not-found so an ID never reveals whether it exists. Default true. */
  readonly hideExistence?: boolean;
}

/** ETag-aware single-resource loader. The newest request wins; older responses are discarded. */
export function createResourceController<T>(options: ResourceOptions<T>): ResourceController<T> {
  const store = createStore<ResourceState<T>>({
    status: "loading",
    data: null,
    etag: null,
    error: null,
    refreshing: false,
  });
  const hide = options.hideExistence ?? true;
  let generation = 0;
  let inflight: AbortController | null = null;

  async function reload(): Promise<void> {
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;
    const mine = ++generation;
    store.update((state) => ({ ...state, refreshing: state.data !== null }));
    try {
      const result = await options.load(controller.signal);
      if (mine !== generation) return;
      store.set({
        status: "ready",
        data: result.data,
        etag: result.etag,
        error: null,
        refreshing: false,
      });
    } catch (error) {
      if (mine !== generation || controller.signal.aborted) return;
      const failure = asApiError(error);
      const status = failureStatus(failure, hide);
      // Keep showing known data when only the refresh failed, but report that it is stale.
      store.update((state) => ({
        status,
        data: status === "error" ? state.data : null,
        etag: status === "error" ? state.etag : null,
        error: failure,
        refreshing: false,
      }));
    }
  }

  return {
    store,
    reload,
    dispose() {
      generation++;
      inflight?.abort();
    },
  };
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface PagedState<T> {
  readonly status: ViewStatus;
  readonly items: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly loadingMore: boolean;
  readonly error: ApiError | null;
  /** Set when a stale cursor forced a restart from the first page. */
  readonly restarted: boolean;
}

export interface PagedController<T> {
  readonly store: Store<PagedState<T>>;
  reload(): Promise<void>;
  loadMore(): Promise<void>;
  dispose(): void;
}

export interface PagedOptions<T> {
  readonly fetchPage: (
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ) => Promise<ApiResult<Page<T>>>;
  readonly limit?: number;
  readonly key?: (item: T) => string;
}

export const defaultPageSize = 50;
export const maxPageSize = 100;

/** Cursor pager. Items are de-duplicated by key, so an overlapping page never repeats a row. */
export function createPagedController<T extends { id: string }>(
  options: PagedOptions<T>,
): PagedController<T> {
  const limit = Math.min(maxPageSize, Math.max(1, options.limit ?? defaultPageSize));
  const key = options.key ?? ((item: T) => item.id);
  const store = createStore<PagedState<T>>({
    status: "loading",
    items: [],
    hasMore: false,
    nextCursor: null,
    loadingMore: false,
    error: null,
    restarted: false,
  });
  let generation = 0;
  let inflight: AbortController | null = null;

  async function fetchFrom(cursor: string | null, append: boolean): Promise<void> {
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;
    const mine = ++generation;
    store.update((state) => ({ ...state, loadingMore: append, error: null }));
    try {
      const result = await options.fetchPage(cursor, limit, controller.signal);
      if (mine !== generation) return;
      const page = result.data;
      store.update((state) => {
        const seen = new Set(append ? state.items.map(key) : []);
        const merged = append ? [...state.items] : [];
        for (const item of page.items) {
          if (seen.has(key(item))) continue;
          seen.add(key(item));
          merged.push(item);
        }
        return {
          status: merged.length === 0 ? "empty" : "ready",
          items: merged,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          loadingMore: false,
          error: null,
          restarted: false,
        };
      });
    } catch (error) {
      if (mine !== generation || controller.signal.aborted) return;
      const failure = asApiError(error);
      if (append && failure.code === "CURSOR_EXPIRED") {
        await fetchFrom(null, false);
        store.update((state) => ({ ...state, restarted: true }));
        return;
      }
      store.update((state) => ({
        ...state,
        status: append && state.items.length > 0 ? state.status : failureStatus(failure, false),
        loadingMore: false,
        error: failure,
      }));
    }
  }

  return {
    store,
    reload: () => {
      store.update((state) => ({
        ...state,
        status: state.items.length > 0 ? state.status : "loading",
      }));
      return fetchFrom(null, false);
    },
    async loadMore() {
      const { hasMore, nextCursor, loadingMore } = store.get();
      if (!hasMore || !nextCursor || loadingMore) return;
      await fetchFrom(nextCursor, true);
    },
    dispose() {
      generation++;
      inflight?.abort();
    },
  };
}

/**
 * Every item of a cursor-paged list; a failed page throws its ApiError. An expired cursor restarts
 * the walk from the first page once (createPagedController), as the CLI's remote lists do; a second
 * expiry throws CURSOR_EXPIRED instead of walking again.
 */
export async function loadAllPages<T extends { id: string }>(
  fetchPage: PagedOptions<T>["fetchPage"],
): Promise<T[]> {
  const controller = createPagedController<T>({ fetchPage, limit: maxPageSize });
  try {
    await controller.reload();
    let state = controller.store.get();
    let restarted = false;
    while (state.hasMore && state.nextCursor && !state.error) {
      await controller.loadMore();
      state = controller.store.get();
      if (!state.restarted || state.error) continue;
      if (restarted)
        throw new ApiError(410, "", {
          code: "CURSOR_EXPIRED",
          message: "The cursor expired again after the walk restarted from the first page",
        });
      restarted = true;
    }
    if (state.error) throw state.error;
    return [...state.items];
  } finally {
    controller.dispose();
  }
}
