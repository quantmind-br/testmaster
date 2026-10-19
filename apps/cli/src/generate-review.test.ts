import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Application, entity, scaffoldPlan } from "@testmaster/application";
import { afterEach, expect, it } from "vitest";
import { completion, testProvider } from "../../../packages/model-gateway/src/test-support.js";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const cleanups: (() => Promise<void>)[] = [];
const originalExit = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExit;
  delete process.env.FAKE_KEY;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const good =
  "import { test, expect } from '@playwright/test';\ntest('health', async ({ request }) => { const response = await request.get('/health'); expect(response.status()).toBe(200); });\n";
// `process.env` is what a model reaches for to find the base URL; the importer refuses it.
const hostAccess = good.replace("'/health'", "process.env.BASE_URL + '/health'");
const generated = (code: string) => ({ code, format: "playwright" });

/** The fields of every receipt this file reads; each test reads only the ones its command returns. */
interface Data {
  requested: number;
  candidates: {
    id: string;
    testId: string;
    testName: string;
    sourceRevisionId: string;
    proposalId?: string;
    exportCommand: string;
  }[];
  validationErrors: { path: string; message: string }[];
  results: {
    action: string;
    id: string;
    ok: boolean;
    error: { code: string; message: string } | null;
  }[];
  sourceSnapshotId: string;
  version: number;
  pendingApprovalIds: string[];
  unresolvedConflictIds: string[];
  total: number;
  returned: number;
  items: { id: string }[];
  nextCursor: string | null;
}
interface Receipt {
  data: Data;
  warnings?: string[];
  error?: { code: string; message: string; details: Record<string, unknown> };
  exit: number;
}
interface Fixture {
  app: Application;
  cwd: string;
  init: { projectId: string; workspaceId: string };
  invoke: (...args: string[]) => Promise<Receipt>;
  revisionCount: () => number;
  completions: () => number;
  setOutput: (value: unknown) => void;
  queueOutputs: (...values: unknown[]) => void;
}

async function fixture(): Promise<Fixture> {
  const cwd = await mkdtemp(join(tmpdir(), "tm-cli-generate-review-"));
  const home = join(cwd, "home");
  await mkdir(join(home, ".config/testmaster"), { recursive: true });
  let completions = 0;
  const queued: unknown[] = [];
  let output: unknown = generated(good);
  const server: Server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "model" }] }));
      return;
    }
    completions++;
    for await (const _chunk of request);
    const content = queued.length ? queued.shift() : output;
    response.end(
      JSON.stringify({
        ...completion,
        choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  await writeFile(
    join(home, ".config/testmaster/profiles.json"),
    JSON.stringify({
      defaultProfile: "test",
      profiles: {
        test: {
          modelProviders: [{ ...testProvider, baseUrl: `http://127.0.0.1:${address.port}/v1` }],
        },
      },
    }),
  );
  await writeFile(
    join(home, ".config/testmaster/policy.json"),
    JSON.stringify({ allowedModelProviders: ["fake"] }),
  );
  process.env.FAKE_KEY = "fake-key";
  const app = await Application.open({ cwd, home, env: { HOME: home } });
  cleanups.push(async () => {
    app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  });
  const init = await app.init();
  const invoke = async (...args: string[]): Promise<Receipt> => {
    let stdout = "";
    const sink = (append: (text: string) => void) =>
      new Writable({
        write(chunk, _encoding, done) {
          append(String(chunk));
          done();
        },
      });
    const runtime = new Runtime(
      sink((text) => {
        stdout += text;
      }),
      sink(() => undefined),
    );
    runtime.app = async () => app;
    process.exitCode = 0;
    await runCli(["--json", "--cwd", cwd, ...args], runtime);
    return { ...(JSON.parse(stdout) as Omit<Receipt, "exit">), exit: process.exitCode ?? 0 };
  };
  const revisionCount = () =>
    Number(app.database.get("SELECT COUNT(*) AS n FROM test_revisions")?.n ?? 0);
  return {
    app,
    cwd,
    init,
    invoke,
    revisionCount,
    completions: () => completions,
    setOutput(value: unknown) {
      output = value;
    },
    queueOutputs(...values: unknown[]) {
      queued.push(...values);
    },
  };
}

/** An accepted proposal whose candidate revision is `revisionId`, as `plan review` leaves it. */
function acceptedProposal(f: Fixture, revisionId: string): string {
  const batch = entity(f.app.context, "pbt", {
    projectId: f.init.projectId,
    sourceSnapshotId: "snapshot-fingerprint",
    version: 1,
    state: "proposed",
  });
  f.app.context.entities.insert("ProposalBatch", batch);
  const proposal = entity(f.app.context, "pro", {
    batchId: batch.id,
    plan: scaffoldPlan("backend"),
    requirementRefs: [],
    evidenceRefs: [{ relativePath: "spec.md" }],
    warnings: [],
    state: "accepted",
    validation: "valid",
    extensions: { "testmaster:candidateRevisionId": revisionId },
  });
  f.app.context.entities.insert("Proposal", proposal);
  return proposal.id;
}

it("test generate from an accepted proposal returns an inactive candidate revision with its test, proposal and export command", async () => {
  const f = await fixture();
  const test = f.app.tests.create({
    projectId: f.init.projectId,
    plan: scaffoldPlan("backend"),
    name: "Health check",
  });
  const revisionId = String(test.activeRevisionId);
  const proposalId = acceptedProposal(f, revisionId);
  const before = f.revisionCount();

  const receipt = await f.invoke("test", "generate", "--proposal", proposalId);

  expect(receipt.exit).toBe(0);
  expect(receipt.data).toMatchObject({ requested: 1, validationErrors: [] });
  expect(receipt.data.candidates).toHaveLength(1);
  const [candidate] = receipt.data.candidates;
  expect(candidate).toMatchObject({
    testId: test.id,
    testName: "Health check",
    sourceRevisionId: revisionId,
    proposalId,
    exportCommand: expect.stringContaining(`--revision ${candidate.id}`),
  });
  expect(f.revisionCount()).toBe(before + 1);
  // A candidate never replaces the active revision: runs keep using it until it is promoted.
  expect(f.app.tests.get(test.id).activeRevisionId).toBe(revisionId);
  expect(f.app.revisions.get(candidate.id)).toMatchObject({
    testId: test.id,
    parentId: revisionId,
  });
});

it("test generate lists the revision whose candidate the checks refused beside the one it kept", async () => {
  const f = await fixture();
  const accepted = String(
    f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") })
      .activeRevisionId,
  );
  const refused = String(
    f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") })
      .activeRevisionId,
  );
  f.queueOutputs(generated(good));
  f.setOutput(generated(hostAccess));

  const receipt = await f.invoke("test", "generate", "--revision", accepted, "--revision", refused);

  expect(receipt.exit).toBe(0);
  expect(receipt.data.requested).toBe(2);
  expect(receipt.data.candidates).toHaveLength(1);
  expect(receipt.data.candidates[0].sourceRevisionId).toBe(accepted);
  expect(receipt.data.validationErrors).toEqual([
    {
      path: refused,
      message: 'Runtime code, shell and host access are forbidden: "process" at line 2',
    },
  ]);
  // The failure is also a warning, so a text-mode reader sees it.
  expect(receipt.warnings).toEqual([expect.stringContaining(refused)]);
});

it("test generate refuses an empty or contradictory selection and an unknown provider before any model call", async () => {
  const f = await fixture();
  const revisionId = String(
    f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") })
      .activeRevisionId,
  );
  const runId = "run_01900000-0000-7000-8000-000000000001";

  const none = await f.invoke("test", "generate");
  expect(none.error?.code).toBe("INVALID_ARGUMENT");
  expect(none.exit).not.toBe(0);
  const mixed = await f.invoke("test", "generate", "--run", runId, "--revision", revisionId);
  expect(mixed.error).toMatchObject({
    code: "INVALID_ARGUMENT",
    message: expect.stringContaining("cannot be combined"),
  });
  const provider = await f.invoke(
    "test",
    "generate",
    "--revision",
    revisionId,
    "--provider",
    "nobody",
  );
  expect(provider.error?.details).toMatchObject({ reasonCode: "provider_unavailable" });
  // Control: the same revision generates once the provider is the configured one.
  const accepted = await f.invoke(
    "test",
    "generate",
    "--revision",
    revisionId,
    "--provider",
    "fake",
  );
  expect(accepted.data.candidates).toHaveLength(1);
  // Only the control reached the model.
  expect(f.completions()).toBe(1);
});

it("test generate --dry-run checks the selection and calls no model", async () => {
  const f = await fixture();
  const revisionId = String(
    f.app.tests.create({ projectId: f.init.projectId, plan: scaffoldPlan("backend") })
      .activeRevisionId,
  );
  const before = f.revisionCount();
  const dry = await f.invoke("--dry-run", "test", "generate", "--revision", revisionId);
  expect(dry.data).toMatchObject({ dryRun: true, validated: true });
  expect(f.completions()).toBe(0);
  expect(f.revisionCount()).toBe(before);
  const empty = await f.invoke("--dry-run", "test", "generate");
  expect(empty.error?.code).toBe("INVALID_ARGUMENT");
});

/** Two requirements that disagree and a third, as `requirement normalize` leaves them (version 2). */
function seedRequirements(f: Fixture, count = 3) {
  const requirements = Array.from({ length: count }, (_, index) =>
    entity(f.app.context, "req", {
      text: `Requirement ${index + 1}`,
      acceptanceCriteria: [`Criterion ${index + 1}`],
      sourceRefs: [],
      originKind: "user_spec",
      confidence: null,
      approval: null,
      extensions: {
        "testmaster:projectId": f.init.projectId,
        "testmaster:key": `key-${index + 1}`,
        "testmaster:reason": "PRD",
      },
    }),
  );
  for (const value of requirements)
    f.app.context.entities.insert("Requirement", value, { projectId: f.init.projectId });
  f.app.database.run(
    "INSERT INTO operational_state(key,value) VALUES(?,?)",
    `requirements:${f.init.workspaceId}:${f.init.projectId}`,
    JSON.stringify({
      requirements,
      conflicts: [
        {
          id: "conflict-1",
          requirementIds: [requirements[0]?.id, requirements[1]?.id],
          reason: "The two statements disagree",
          sourceRefs: [],
          resolution: null,
        },
      ],
      openQuestions: [],
      version: 2,
      fingerprint: "seed-fingerprint",
    }),
  );
  return requirements.map((item) => item.id);
}

it("requirement snapshot shows the conflicts and the snapshot version that adjudicate takes", async () => {
  const f = await fixture();
  const [first, second, third] = seedRequirements(f) as [string, string, string];

  const before = await f.invoke("requirement", "snapshot");

  expect(before.exit).toBe(0);
  expect(before.data).toMatchObject({ version: 2, sourceSnapshotId: "seed-fingerprint" });
  expect(before.data.conflicts).toEqual([
    expect.objectContaining({
      id: "conflict-1",
      requirementIds: [first, second],
      resolution: null,
    }),
  ]);
  expect(before.data.requirements.map((item: { status: string }) => item.status)).toEqual([
    "pending",
    "pending",
    "pending",
  ]);

  const decided = await f.invoke(
    "requirement",
    "adjudicate",
    "conflict-1",
    "--selected-requirement",
    first,
    "--reason",
    "First wins",
    "--expected-version",
    String(before.data.version),
  );
  expect(decided.exit).toBe(0);

  const after = await f.invoke("requirement", "snapshot");
  expect(after.data.version).toBeGreaterThan(2);
  expect(after.data.conflicts[0].resolution).toMatchObject({ selectedRequirementId: first });
  expect(
    Object.fromEntries(
      after.data.requirements.map((item: { id: string; status: string }) => [item.id, item.status]),
    ),
  ).toEqual({ [first]: "pending", [second]: "superseded", [third]: "pending" });
});

it("requirement review applies edits, the conflict decision and approvals from one file and returns the new snapshot", async () => {
  const f = await fixture();
  const [first, second, third] = seedRequirements(f) as [string, string, string];
  await writeFile(
    join(f.cwd, "review.json"),
    JSON.stringify({
      expectedVersion: 2,
      update: [{ requirementId: first, text: "Requirement 1, reworded" }],
      adjudicate: [
        { conflictId: "conflict-1", selectedRequirementId: first, reason: "First wins" },
      ],
      reject: [{ requirementId: third, reason: "Out of scope" }],
      approve: [first],
      reason: "Matches the PRD",
    }),
  );

  const receipt = await f.invoke("requirement", "review", "--file", "review.json");

  expect(receipt.exit).toBe(0);
  expect(receipt.data.results).toEqual([
    { action: "update", id: first, ok: true, error: null },
    { action: "adjudicate", id: "conflict-1", ok: true, error: null },
    { action: "reject", id: third, ok: true, error: null },
    { action: "approve", id: first, ok: true, error: null },
  ]);
  const snapshot = f.app.requirements.snapshot(f.init.projectId);
  expect(receipt.data).toMatchObject({
    sourceSnapshotId: snapshot.fingerprint,
    version: snapshot.version,
    // The loser of the conflict is superseded and the third is rejected: nothing waits for approval.
    pendingApprovalIds: [],
    unresolvedConflictIds: [],
  });
  expect(snapshot.version).toBeGreaterThan(2);
  expect(f.app.requirements.get(first)).toMatchObject({
    text: "Requirement 1, reworded",
    approval: expect.stringMatching(/^apr_/),
  });
  expect(f.app.requirements.get(second).approval).toBeNull();
});

it("requirement review reports a refused item and still applies the others", async () => {
  const f = await fixture();
  const [first] = seedRequirements(f) as [string];
  const missing = "req_01900000-0000-7000-8000-0000000000ff";
  await writeFile(
    join(f.cwd, "review.json"),
    JSON.stringify({
      expectedVersion: 2,
      update: [
        { requirementId: missing, text: "Nobody" },
        { requirementId: first, text: "Edited" },
      ],
    }),
  );

  const receipt = await f.invoke("requirement", "review", "--file", "review.json");

  expect(receipt.data.results).toEqual([
    {
      action: "update",
      id: missing,
      ok: false,
      error: { code: "NOT_FOUND", message: expect.any(String) },
    },
    { action: "update", id: first, ok: true, error: null },
  ]);
  expect(receipt.warnings).toEqual([expect.stringContaining(missing)]);
  expect(f.app.requirements.get(first).text).toBe("Edited");
});

it("requirement review at a stale expectedVersion changes nothing", async () => {
  const f = await fixture();
  const [first] = seedRequirements(f) as [string];
  const before = JSON.stringify(f.app.requirements.snapshot(f.init.projectId));
  await writeFile(
    join(f.cwd, "review.json"),
    JSON.stringify({
      expectedVersion: 1,
      update: [{ requirementId: first, text: "Never stored" }],
      adjudicate: [{ conflictId: "conflict-1", selectedRequirementId: first, reason: "Stale" }],
      approve: [first],
    }),
  );

  const receipt = await f.invoke("requirement", "review", "--file", "review.json");

  expect(receipt.error?.code).toBe("REVISION_CONFLICT");
  expect(receipt.error?.details).toMatchObject({ expectedVersion: 1, currentVersion: 2 });
  expect(receipt.exit).not.toBe(0);
  expect(JSON.stringify(f.app.requirements.snapshot(f.init.projectId))).toBe(before);
  expect(f.app.requirements.get(first)).toMatchObject({ text: "Requirement 1", approval: null });
});

it("requirement review refuses an id in both reject and approve, and a file that names a project or breaks the contract, before any change", async () => {
  const f = await fixture();
  const [first] = seedRequirements(f) as [string];
  const before = JSON.stringify(f.app.requirements.snapshot(f.init.projectId));
  const review = async (document: unknown) => {
    await writeFile(join(f.cwd, "review.json"), JSON.stringify(document));
    return f.invoke("requirement", "review", "--file", "review.json");
  };

  const both = await review({
    expectedVersion: 2,
    reject: [{ requirementId: first, reason: "No" }],
    approve: [first],
  });
  expect(both.error).toMatchObject({
    code: "INVALID_ARGUMENT",
    message: expect.stringContaining("approved and rejected"),
  });
  const named = await review({ expectedVersion: 2, projectId: f.init.projectId, approve: [] });
  expect(named.error?.message).toContain("--project");
  const unknownField = await review({ expectedVersion: 2, approveAll: true });
  expect(unknownField.error?.code).toBe("INVALID_ARGUMENT");
  const noReason = await review({ expectedVersion: 2, reject: [{ requirementId: first }] });
  expect(noReason.error?.code).toBe("INVALID_ARGUMENT");
  expect(JSON.stringify(f.app.requirements.snapshot(f.init.projectId))).toBe(before);
  // Control: the empty decision is valid and changes nothing.
  const empty = await review({ expectedVersion: 2 });
  expect(empty.data).toMatchObject({ results: [], version: 2 });
});

/** Every item of a list walked page by page with `--limit`, and the pages' sizes. */
async function walk(f: Fixture, command: string[], limit: number) {
  const items: { id: string }[] = [];
  const sizes: number[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const receipt: Receipt = await f.invoke(
      ...command,
      "--limit",
      String(limit),
      ...(cursor ? ["--cursor", cursor] : []),
    );
    expect(receipt.error, JSON.stringify(receipt.error)).toBeUndefined();
    expect(receipt.data.total).toBeGreaterThan(0);
    items.push(...receipt.data.items);
    sizes.push(receipt.data.returned);
    cursor = receipt.data.nextCursor ?? undefined;
    if (!cursor) return { items, sizes };
  }
  throw new Error("The walk did not end");
}

it("test list pages return every test exactly once, honor the filters and refuse a cursor of another filter", async () => {
  const f = await fixture();
  const created = Array.from({ length: 5 }, (_, index) =>
    f.app.tests.create({
      projectId: f.init.projectId,
      plan: scaffoldPlan("backend"),
      name: `Test ${index}`,
      tags: index % 2 ? ["even"] : ["odd"],
    }),
  );
  const unpaged = await f.invoke("test", "list");
  expect((unpaged.data as unknown as { id: string }[]).map((item) => item.id).sort()).toEqual(
    created.map((item) => item.id).sort(),
  );

  const paged = await walk(f, ["test", "list"], 2);
  expect(paged.sizes).toEqual([2, 2, 1]);
  expect(paged.items.map((item) => item.id)).toEqual(
    (unpaged.data as unknown as { id: string }[]).map((item) => item.id),
  );

  const odd = await walk(f, ["test", "list", "--tag", "odd"], 2);
  expect(odd.items.map((item) => item.id).sort()).toEqual(
    created
      .filter((item) => item.tags.includes("odd"))
      .map((item) => item.id)
      .sort(),
  );

  const first = await f.invoke("test", "list", "--limit", "2");
  const other = await f.invoke(
    "test",
    "list",
    "--tag",
    "odd",
    "--limit",
    "2",
    "--cursor",
    String(first.data.nextCursor),
  );
  expect(other.error?.code).toBe("INVALID_ARGUMENT");
  const forged = await f.invoke("test", "list", "--limit", "2", "--cursor", "not-a-cursor");
  expect(forged.error?.code).toBe("INVALID_ARGUMENT");
});

it("requirement list pages return every requirement exactly once", async () => {
  const f = await fixture();
  const ids = seedRequirements(f, 5);

  const paged = await walk(f, ["requirement", "list"], 2);

  expect(paged.sizes).toEqual([2, 2, 1]);
  expect(paged.items.map((item) => item.id)).toEqual(ids);
  // Without paging options the list is the whole array.
  const whole = await f.invoke("requirement", "list");
  expect((whole.data as unknown as { id: string }[]).map((item) => item.id)).toEqual(ids);
  // A page past the last one does not exist: the last cursor is null.
  const last = await f.invoke("requirement", "list", "--limit", "5");
  expect(last.data).toMatchObject({ total: 5, returned: 5, nextCursor: null });
});
