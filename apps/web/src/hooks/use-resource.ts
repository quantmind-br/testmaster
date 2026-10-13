import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { type ApiMethod, type ApiResult, api } from "../api";
import type { QueryValue } from "../api/client";
import {
  createPagedController,
  createResourceController,
  type Page,
  type PagedState,
  type ResourceState,
} from "../api/controllers";

type Query = Readonly<Record<string, QueryValue>>;

/** Stable dependency key for a query object. */
function queryKey(query: Query | undefined): string {
  return JSON.stringify(Object.entries(query ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

export interface UseResource<T> extends ResourceState<T> {
  reload(): Promise<void>;
  /**
   * Sends a mutation guarded by the ETag of the data on screen, then reloads. A stale ETag
   * surfaces as `REVISION_CONFLICT`; nothing is overwritten.
   */
  mutate<R>(method: Exclude<ApiMethod, "GET">, body?: unknown): Promise<ApiResult<R>>;
}

/** ETag-aware GET. FORBIDDEN is reported as `not-found` so an ID never reveals existence. */
export function useResource<T>(path: string, query?: Query): UseResource<T> {
  const key = queryKey(query);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the stable form of `query`
  const controller = useMemo(
    () =>
      createResourceController<T>({
        load: (signal) => api<T>("GET", path, { query: query ?? {}, signal }),
      }),
    [path, key],
  );
  useEffect(() => {
    void controller.reload();
    return () => controller.dispose();
  }, [controller]);
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.get);
  const reload = useCallback(() => controller.reload(), [controller]);
  const mutate = useCallback(
    async <R>(method: Exclude<ApiMethod, "GET">, body?: unknown) => {
      const { etag } = controller.store.get();
      const result = await api<R>(method, path, { body, ifMatch: etag });
      await controller.reload();
      return result;
    },
    [controller, path],
  );
  return { ...state, reload, mutate };
}

export interface UsePaged<T> extends PagedState<T> {
  reload(): Promise<void>;
  loadMore(): Promise<void>;
}

/** Cursor pages with `limit` capped at 100. Changing `path` or `query` restarts from page one. */
export function usePaged<T extends { id: string }>(
  path: string,
  query?: Query,
  limit?: number,
): UsePaged<T> {
  const key = queryKey(query);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the stable form of `query`
  const controller = useMemo(
    () =>
      createPagedController<T>({
        ...(limit === undefined ? {} : { limit }),
        fetchPage: (cursor, size, signal) =>
          api<Page<T>>("GET", path, { query: { ...query, limit: size, cursor }, signal }),
      }),
    [path, key, limit],
  );
  useEffect(() => {
    void controller.reload();
    return () => controller.dispose();
  }, [controller]);
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.get);
  return {
    ...state,
    reload: useCallback(() => controller.reload(), [controller]),
    loadMore: useCallback(() => controller.loadMore(), [controller]),
  };
}
