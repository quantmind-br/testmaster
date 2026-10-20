import { describe, expect, it } from "vitest";
import { ApiError, type ApiResult } from "./client";
import {
  createPagedController,
  createResourceController,
  loadAllPages,
  type Page,
} from "./controllers";

const result = <T>(data: T, etag: string | null = null): ApiResult<T> => ({
  data,
  etag,
  requestId: "req",
  warnings: [],
});
const failure = (status: number, code: string) => new ApiError(status, "req", { code });

describe("resource controller", () => {
  it("UX-003 loads data with its ETag and reports ready", async () => {
    const controller = createResourceController({ load: async () => result({ id: "a" }, '"4"') });
    expect(controller.store.get().status).toBe("loading");
    await controller.reload();
    expect(controller.store.get()).toMatchObject({
      status: "ready",
      data: { id: "a" },
      etag: '"4"',
    });
  });

  it("SEC-030 reports FORBIDDEN and NOT_FOUND as the same not-found state without data", async () => {
    const states: string[] = [];
    for (const code of ["FORBIDDEN", "NOT_FOUND"]) {
      const controller = createResourceController({
        load: async () => {
          throw failure(code === "FORBIDDEN" ? 403 : 404, code);
        },
      });
      await controller.reload();
      const state = controller.store.get();
      states.push(`${state.status}:${state.data === null}:${state.etag}`);
    }
    expect(states).toEqual(["not-found:true:null", "not-found:true:null"]);
  });

  it("UX-003 distinguishes forbidden from not-found when existence is not hidden", async () => {
    const controller = createResourceController({
      hideExistence: false,
      load: async () => {
        throw failure(403, "FORBIDDEN");
      },
    });
    await controller.reload();
    expect(controller.store.get().status).toBe("forbidden");
  });

  it("UX-003 keeps known data visible but marks the error when only a refresh fails", async () => {
    let calls = 0;
    const controller = createResourceController({
      load: async () => {
        if (++calls === 1) return result({ id: "a" }, '"1"');
        throw failure(503, "INTERNAL");
      },
    });
    await controller.reload();
    await controller.reload();
    expect(controller.store.get()).toMatchObject({
      status: "error",
      data: { id: "a" },
      etag: '"1"',
      refreshing: false,
    });
  });

  it("UX-003 discards a slow response that was superseded by a newer request", async () => {
    const releases: ((value: ApiResult<string>) => void)[] = [];
    const controller = createResourceController<string>({
      load: () => new Promise((resolve) => releases.push(resolve)),
    });
    const first = controller.reload();
    const second = controller.reload();
    releases[1]?.(result("new"));
    await second;
    releases[0]?.(result("old"));
    await first;
    expect(controller.store.get().data).toBe("new");
  });
});

interface Row {
  readonly id: string;
}

function pages(...all: Page<Row>[]) {
  const cursors: (string | null)[] = [];
  const limits: number[] = [];
  return {
    cursors,
    limits,
    fetchPage: async (cursor: string | null, limit: number) => {
      cursors.push(cursor);
      limits.push(limit);
      const index = cursor === null ? 0 : Number(cursor);
      const page = all[index];
      if (!page) throw failure(400, "INVALID_ARGUMENT");
      return result(page);
    },
  };
}

describe("paged controller", () => {
  it("UX-008 follows cursors, appends pages and stops when there is no more", async () => {
    const source = pages(
      { items: [{ id: "a" }, { id: "b" }], hasMore: true, nextCursor: "1" },
      { items: [{ id: "c" }], hasMore: false, nextCursor: null },
    );
    const controller = createPagedController<Row>({ fetchPage: source.fetchPage });
    await controller.reload();
    expect(controller.store.get().items.map((row) => row.id)).toEqual(["a", "b"]);
    await controller.loadMore();
    await controller.loadMore();
    expect(controller.store.get()).toMatchObject({ hasMore: false, status: "ready" });
    expect(controller.store.get().items.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(source.cursors).toEqual([null, "1"]);
  });

  it("UX-008 defaults to 50 rows and never asks for more than 100", async () => {
    const small = pages({ items: [], hasMore: false, nextCursor: null });
    await createPagedController<Row>({ fetchPage: small.fetchPage }).reload();
    const large = pages({ items: [], hasMore: false, nextCursor: null });
    await createPagedController<Row>({ fetchPage: large.fetchPage, limit: 5_000 }).reload();
    expect([small.limits[0], large.limits[0]]).toEqual([50, 100]);
  });

  it("UX-008 never repeats a row when consecutive pages overlap", async () => {
    const source = pages(
      { items: [{ id: "a" }, { id: "b" }], hasMore: true, nextCursor: "1" },
      { items: [{ id: "b" }, { id: "c" }], hasMore: false, nextCursor: null },
    );
    const controller = createPagedController<Row>({ fetchPage: source.fetchPage });
    await controller.reload();
    await controller.loadMore();
    expect(controller.store.get().items.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("UX-003 an empty first page is the empty state, not an error", async () => {
    const controller = createPagedController<Row>({
      fetchPage: pages({ items: [], hasMore: false, nextCursor: null }).fetchPage,
    });
    await controller.reload();
    expect(controller.store.get().status).toBe("empty");
  });

  it("UX-003 a forbidden list is reported as forbidden, not as empty", async () => {
    const controller = createPagedController<Row>({
      fetchPage: async () => {
        throw failure(403, "FORBIDDEN");
      },
    });
    await controller.reload();
    expect(controller.store.get()).toMatchObject({ status: "forbidden", items: [] });
  });

  it("UX-008 restarts from the first page when a stored cursor has expired", async () => {
    let calls = 0;
    const controller = createPagedController<Row>({
      fetchPage: async (cursor) => {
        calls++;
        if (calls === 1)
          return result({ items: [{ id: "a" }], hasMore: true, nextCursor: "stale" });
        if (cursor === "stale") throw failure(410, "CURSOR_EXPIRED");
        return result({ items: [{ id: "a" }, { id: "z" }], hasMore: false, nextCursor: null });
      },
    });
    await controller.reload();
    await controller.loadMore();
    expect(controller.store.get()).toMatchObject({ restarted: true, hasMore: false });
    expect(controller.store.get().items.map((row) => row.id)).toEqual(["a", "z"]);
  });

  it("UX-008 keeps loaded rows and surfaces the error when load-more fails", async () => {
    let calls = 0;
    const controller = createPagedController<Row>({
      fetchPage: async () => {
        if (++calls === 1) return result({ items: [{ id: "a" }], hasMore: true, nextCursor: "1" });
        throw failure(503, "INTERNAL");
      },
    });
    await controller.reload();
    await controller.loadMore();
    expect(controller.store.get()).toMatchObject({ status: "ready", loadingMore: false });
    expect(controller.store.get().error?.code).toBe("INTERNAL");
    expect(controller.store.get().items).toHaveLength(1);
  });
});

describe("loadAllPages", () => {
  const ids = (rows: readonly Row[]) => rows.map((row) => row.id);

  it("returns the items of every page in order", async () => {
    const source = pages(
      { items: [{ id: "a" }, { id: "b" }], hasMore: true, nextCursor: "1" },
      { items: [{ id: "c" }], hasMore: true, nextCursor: "2" },
      { items: [{ id: "d" }], hasMore: false, nextCursor: null },
    );
    expect(ids(await loadAllPages<Row>(source.fetchPage))).toEqual(["a", "b", "c", "d"]);
    expect(source.cursors).toEqual([null, "1", "2"]);
    expect(source.limits).toEqual([100, 100, 100]);
  });

  it("rejects with the ApiError of a failing page instead of returning the pages read so far", async () => {
    const error = failure(503, "UNAVAILABLE");
    await expect(
      loadAllPages<Row>(async (cursor) => {
        if (cursor === "1") throw error;
        return result({ items: [{ id: "a" }], hasMore: true, nextCursor: "1" });
      }),
    ).rejects.toBe(error);
  });

  it("returns the restarted walk, each item once, when a cursor expires", async () => {
    let expiredOnce = false;
    const rows = await loadAllPages<Row>(async (cursor) => {
      if (cursor === null)
        return result({ items: [{ id: "a" }, { id: "b" }], hasMore: true, nextCursor: "1" });
      if (!expiredOnce) {
        expiredOnce = true;
        throw failure(410, "CURSOR_EXPIRED");
      }
      return result({ items: [{ id: "c" }], hasMore: false, nextCursor: null });
    });
    expect(expiredOnce).toBe(true);
    expect(ids(rows)).toEqual(["a", "b", "c"]);
  });

  it("rejects with CURSOR_EXPIRED when the restarted walk expires too", async () => {
    const cursors: (string | null)[] = [];
    await expect(
      loadAllPages<Row>(async (cursor) => {
        cursors.push(cursor);
        // A walk that keeps restarting would never settle: end it with another error instead.
        if (cursors.length > 6) throw failure(503, "UNAVAILABLE");
        if (cursor !== null) throw failure(410, "CURSOR_EXPIRED");
        return result({ items: [{ id: "a" }], hasMore: true, nextCursor: "1" });
      }),
    ).rejects.toMatchObject({ status: 410, code: "CURSOR_EXPIRED" });
    expect(cursors.filter((cursor) => cursor !== null)).toEqual(["1", "1"]);
  });
});
