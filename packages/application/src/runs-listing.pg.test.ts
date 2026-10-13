import { afterEach, expect, it, vi } from "vitest";
import {
  addWorkspace,
  createListingTest,
  insertListedRuns,
  type OpsStack,
  opsStack,
} from "./ops.testkit.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function freshStack(): Promise<OpsStack> {
  const stack = await opsStack();
  cleanups.push(() => stack.cleanup());
  return stack;
}
const at = (index: number): string => new Date(Date.UTC(2026, 9, 1) + index * 1000).toISOString();
const everything = { cutoff: "9999-12-31T23:59:59.999Z", after: null } as const;

it("NFR-006 streams Runs newest first across internal pages and list() returns the same Runs", async () => {
  const stack = await freshStack();
  const listed = createListingTest(stack.workspace, "Listing order");
  const ids = insertListedRuns(stack.workspace, listed, 230);
  const streamed = [...stack.workspace.runs.stream({}, everything)].map((run) => run.id);
  expect(streamed).toEqual([...ids].reverse());
  expect(stack.workspace.runs.list().map((run) => run.id)).toEqual(streamed);
  const resumed = [
    ...stack.workspace.runs.stream(
      {},
      { cutoff: everything.cutoff, after: { createdAt: at(100), id: ids[100] as string } },
    ),
  ].map((run) => run.id);
  expect(resumed).toEqual(ids.slice(0, 100).reverse());
  expect(resumed).not.toContain(ids[100]);
});

it("NFR-006 reads one page of rows when the consumer stops after a few Runs", async () => {
  const stack = await freshStack();
  insertListedRuns(stack.workspace, createListingTest(stack.workspace, "Listing laziness"), 230);
  const page = vi.spyOn(stack.workspace.runs.ctx.entities, "page");
  const iterator = stack.workspace.runs.stream({}, everything);
  for (let taken = 0; taken < 5; taken++) iterator.next();
  expect(page).toHaveBeenCalledTimes(1);
  iterator.return(undefined);
  page.mockClear();
  expect([...stack.workspace.runs.stream({}, everything)]).toHaveLength(230);
  expect(page).toHaveBeenCalledTimes(3);
});

it("NFR-006 pushes status, test, project and creation-time filters into the listing", async () => {
  const stack = await freshStack();
  const first = createListingTest(stack.workspace, "Listing first");
  const second = createListingTest(stack.workspace, "Listing second");
  const passed = insertListedRuns(stack.workspace, first, 6);
  const failed = insertListedRuns(stack.workspace, first, 3, { from: 6, outcome: "failed" });
  const other = insertListedRuns(stack.workspace, second, 2, { from: 20 });
  const ids = (filter: Parameters<typeof stack.workspace.runs.stream>[0]): string[] =>
    [...stack.workspace.runs.stream(filter, everything)].map((run) => run.id);
  expect(ids({ status: "failed" }).sort()).toEqual([...failed].sort());
  expect(ids({ status: "passed" }).sort()).toEqual([...passed, ...other].sort());
  expect(ids({ testId: first.testId })).toHaveLength(9);
  expect(ids({ testId: second.testId }).sort()).toEqual([...other].sort());
  expect(ids({ testId: "tst_missing" })).toEqual([]);
  expect(ids({ projectId: second.projectId }).sort()).toEqual([...other].sort());
  expect(ids({ projectId: "prj_missing" })).toEqual([]);
  expect(ids({ since: at(3), testId: first.testId })).toEqual(
    [...passed, ...failed].slice(3).reverse(),
  );
});

it("NFR-006 never lists another workspace's Runs and refuses a column filter that does not exist", async () => {
  const stack = await freshStack();
  insertListedRuns(stack.workspace, createListingTest(stack.workspace, "Listing own"), 3);
  const otherWorkspace = addWorkspace(stack, "Other", "other-owner");
  const otherApp = stack.application.forWorkspaceSystem(otherWorkspace);
  const theirs = insertListedRuns(otherApp, createListingTest(otherApp, "Listing theirs"), 1);
  expect([...stack.workspace.runs.stream({}, everything)]).toHaveLength(3);
  expect([...otherApp.runs.stream({}, everything)].map((run) => run.id)).toEqual(theirs);
  expect(() =>
    stack.workspace.runs.ctx.entities.page("Run", stack.workspaceId, { where: { data_json: "x" } }),
  ).toThrowError(expect.objectContaining({ code: "INTERNAL" }));
});
