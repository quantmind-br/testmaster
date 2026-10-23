import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { completion, testProvider } from "../../model-gateway/src/test-support.js";
import { Application } from "./application.js";

const roots: string[] = [];
const apps: Application[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  delete process.env.FAKE_KEY;
});

/** A real application over a local OpenAI-compatible provider that records every request body. */
async function fixture(contextTokens?: number) {
  const root = await mkdtemp(join(tmpdir(), "tm-memory-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(join(home, ".config/testmaster"), { recursive: true });
  const payloads: { messages: { role: string; content: string }[] }[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    payloads.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.end(
      JSON.stringify({
        ...completion,
        choices: [
          {
            message: { content: JSON.stringify({ amount: 1, currency: "USD", scale: 2 }) },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  servers.push(server);
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  await writeFile(
    join(home, ".config/testmaster/profiles.json"),
    JSON.stringify({
      defaultProfile: "test",
      profiles: {
        test: {
          modelProviders: [
            {
              ...testProvider,
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              models: testProvider.models.map((model) => ({
                ...model,
                capabilities: {
                  ...model.capabilities,
                  ...(contextTokens ? { contextTokens } : {}),
                },
              })),
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(home, ".config/testmaster/policy.json"),
    JSON.stringify({ allowedModelProviders: ["fake"] }),
  );
  process.env.FAKE_KEY = "fake-key";
  const app = await Application.open({ cwd: root, home, env: { HOME: home } });
  apps.push(app);
  const initialized = await app.init();
  const projectId = initialized.projectId;
  const call = async (
    purpose: "plan" | "analyze" | "heal" | "normalize",
    data: unknown,
    forProject = projectId,
  ) => {
    await app.model.complete({
      projectId: forProject,
      purpose,
      responseSchema: "Money",
      data,
    });
    const prompt = payloads.at(-1)?.messages.find((message) => message.role === "user")?.content;
    return JSON.parse(String(prompt)).untrustedData;
  };
  return {
    app,
    projectId,
    root,
    payloads,
    /** What the provider received under `projectMemory` for one call: the entry texts. */
    async memoryTexts(
      purpose: "plan" | "analyze" | "heal" | "normalize" = "plan",
      project = projectId,
    ) {
      const data = await call(purpose, { goal: "plan the checkout" }, project);
      return ((data.projectMemory ?? []) as { text: string }[]).map((item) => item.text);
    },
    call,
    async source(name: string, text: string, project = projectId) {
      await writeFile(join(root, name), text);
      return app.sources.add({ projectId: project, role: "prd", path: name, format: "markdown" });
    },
    /** A pending entry citing `revisionId`. */
    add(text: string, revisionId: string, extra: { validFrom?: string; expiresAt?: string } = {}) {
      return app.memory.create(projectId, {
        text,
        sourceRefs: [{ sourceRevisionId: revisionId }],
        ...extra,
      });
    },
    approve(entry: { id: string; version: number }) {
      return app.memory.approve(entry.id, { expectedVersion: entry.version });
    },
  };
}

it("a new source revision makes an entry stale and it stops reaching the prompt", async () => {
  const f = await fixture();
  const first = await f.source("prd.md", "# Checkout\nTotals include VAT.");
  const approved = f.approve(f.add("Totals include VAT", first.revision.id));
  expect(approved.state).toBe("active");
  expect(await f.memoryTexts()).toEqual(["Totals include VAT"]);

  await writeFile(join(f.root, "prd.md"), "# Checkout\nTotals exclude VAT.");
  const second = await f.app.sources.add({
    projectId: f.projectId,
    role: "prd",
    path: "prd.md",
    format: "markdown",
    sourceId: first.source.id,
    expectedVersion: Number(first.source.version),
  });
  expect(second.revision.id).not.toBe(first.revision.id);
  const [entry] = f.app.memory.list(f.projectId);
  expect(entry).toMatchObject({
    state: "stale",
    staleRefs: [{ sourceRevisionId: first.revision.id }],
  });
  expect(await f.memoryTexts()).toEqual([]);
  expect(f.app.memory.activeProjectMemory(f.projectId)).toEqual([]);
});

it("an archived source retires the entries that cite it", async () => {
  const f = await fixture();
  const source = await f.source("prd.md", "# Checkout\nTotals include VAT.");
  f.approve(f.add("Totals include VAT", source.revision.id));
  f.app.sources.archive(source.source.id, Number(source.source.version));
  expect(f.app.memory.list(f.projectId)[0]?.state).toBe("stale");
  expect(await f.memoryTexts()).toEqual([]);
});

it("an entry applies only between validFrom and expiresAt", async () => {
  const f = await fixture();
  const { revision } = await f.source("prd.md", "# Checkout\nTotals include VAT.");
  const hour = 3_600_000;
  const at = (offset: number) => new Date(Date.now() + offset).toISOString();
  f.approve(f.add("Applies now", revision.id, { validFrom: at(-2 * hour), expiresAt: at(hour) }));
  f.approve(f.add("Applies tomorrow", revision.id, { validFrom: at(24 * hour) }));
  f.approve(f.add("Expired", revision.id, { validFrom: at(-2 * hour), expiresAt: at(-hour) }));
  const states = Object.fromEntries(
    f.app.memory.list(f.projectId).map((entry) => [entry.text, entry.state]),
  );
  expect(states).toEqual({
    "Applies now": "active",
    "Applies tomorrow": "scheduled",
    Expired: "expired",
  });
  expect(await f.memoryTexts()).toEqual(["Applies now"]);
  await refusal(() =>
    f.app.memory.create(f.projectId, {
      text: "Window never opens",
      sourceRefs: [{ sourceRevisionId: revision.id }],
      validFrom: at(hour),
      expiresAt: at(hour),
    }),
  ).toMatchObject({ code: "INVALID_ARGUMENT" });
});

it("forgetting erases the text and sources, keeps the approval and is idempotent", async () => {
  const f = await fixture();
  const { revision } = await f.source("prd.md", "# Checkout\nTotals include VAT.");
  const approved = f.approve(f.add("Totals include VAT", revision.id));
  const forgotten = f.app.memory.forget(approved.id);
  expect(forgotten).toMatchObject({
    state: "forgotten",
    text: "",
    sourceRefs: [],
    approval: approved.approval,
  });
  expect(forgotten.tombstoneAt).not.toBeNull();
  expect(f.app.memory.forget(approved.id)).toEqual(forgotten);
  expect(await f.memoryTexts()).toEqual([]);
  await refusal(() =>
    f.app.memory.update(approved.id, { expectedVersion: forgotten.version, text: "Back" }),
  ).toMatchObject({ code: "PRECONDITION_FAILED" });
  await refusal(() =>
    f.app.memory.approve(approved.id, { expectedVersion: forgotten.version }),
  ).toMatchObject({ code: "PRECONDITION_FAILED" });
});

it("only approved, active entries reach the provider, and only for plan, analyze and heal", async () => {
  const f = await fixture();
  const { revision } = await f.source("prd.md", "# Checkout\nTotals include VAT.");
  f.add("Still pending", revision.id);
  const approved = f.approve(f.add("Approved fact", revision.id));
  const edited = f.approve(f.add("Edited after approval", revision.id));
  const reopened = f.app.memory.update(edited.id, {
    expectedVersion: edited.version,
    text: "Edited and unreviewed",
  });
  expect(reopened).toMatchObject({ state: "pending", approval: null });

  for (const purpose of ["plan", "analyze", "heal"] as const)
    expect(await f.memoryTexts(purpose)).toEqual(["Approved fact"]);
  expect(await f.memoryTexts("normalize")).toEqual([]);

  const sent = await f.call("plan", { goal: "plan the checkout" });
  expect(sent.goal).toBe("plan the checkout");
  expect(sent.projectMemory).toEqual([
    {
      id: approved.id,
      text: "Approved fact",
      sourceRefs: [{ sourceRevisionId: revision.id }],
      validFrom: approved.validFrom,
      expiresAt: null,
    },
  ]);
  // Data that is not a plain object has nowhere to carry memory and is sent as the caller gave it.
  expect(await f.call("plan", "a plain string")).toBe("a plain string");
  expect(await f.call("plan", ["a list"])).toEqual(["a list"]);
});

it("admission counts the memory the call will carry", async () => {
  const f = await fixture(900);
  const { revision } = await f.source("prd.md", "# Checkout\nTotals include VAT.");
  const input = {
    projectId: f.projectId,
    purpose: "plan" as const,
    responseSchema: "Money",
    data: { goal: "plan the checkout" },
  };
  f.app.model.assertFitsContext(input);
  const entry = f.add("x".repeat(1500), revision.id);
  f.app.model.assertFitsContext(input);
  f.approve(entry);
  expect(() => f.app.model.assertFitsContext(input)).toThrow(
    expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }),
  );
});

it("approval is an Approval record bound to the entry, the author may approve it and an edit clears it", async () => {
  const f = await fixture();
  const { revision } = await f.source("prd.md", "# Checkout\nTotals include VAT.");
  const entry = f.add("Totals include VAT", revision.id);
  expect(entry).toMatchObject({ state: "pending", approval: null, version: 1 });
  await refusal(() => f.app.memory.approve(entry.id, { expectedVersion: 7 })).toMatchObject({
    code: "REVISION_CONFLICT",
  });
  const approved = f.app.memory.approve(entry.id, {
    expectedVersion: 1,
    reason: "Confirmed with the product owner",
  });
  expect(approved).toMatchObject({ state: "active", version: 2 });
  expect(
    f.app.context.entities.get("Approval", f.app.context.workspaceId, String(approved.approval)),
  ).toMatchObject({
    actionSet: ["memory.approve"],
    reviewerId: f.app.context.principalId,
    revokedAt: null,
  });
  await refusal(() => f.app.memory.approve(entry.id, { expectedVersion: 2 })).toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  const reopened = f.app.memory.update(entry.id, {
    expectedVersion: 2,
    expiresAt: null,
    text: "Totals include VAT 21%",
  });
  expect(reopened).toMatchObject({ state: "pending", approval: null, version: 3 });
  expect(await f.memoryTexts()).toEqual([]);
});

it("refuses text that holds a credential or personal data, and sources outside the evidence", async () => {
  const f = await fixture();
  const { revision } = await f.source("prd.md", "# Checkout\nTotals include VAT.");
  const refs = [{ sourceRevisionId: revision.id }];
  for (const text of ["The admin password: hunter2hunter2", "Ask maria@example.com for access"])
    await refusal(() => f.app.memory.create(f.projectId, { text, sourceRefs: refs })).toMatchObject(
      {
        code: "POLICY_DENIED",
        details: { reasonCode: "memory_sensitive_content" },
      },
    );
  const entry = f.add("Totals include VAT", revision.id);
  await refusal(() =>
    f.app.memory.update(entry.id, { expectedVersion: 1, text: "Reach 123.456.789-09 for support" }),
  ).toMatchObject({ code: "POLICY_DENIED" });
  expect(f.app.memory.list(f.projectId)).toHaveLength(1);

  for (const sourceRefs of [
    [{ sourceRevisionId: "svr_00000000-0000-4000-8000-000000000001" }],
    [{ relativePath: "src/price.ts" }],
    [{ runId: "run_00000000-0000-4000-8000-000000000001" }],
  ])
    await refusal(() =>
      f.app.memory.create(f.projectId, { text: "A fact", sourceRefs }),
    ).toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reasonCode: "memory_source_unresolved" },
    });
});

it("one project never sees another project's memory or cites its sources", async () => {
  const f = await fixture();
  const other = f.app.projects.create({ name: "Other shop" });
  f.app.environments.create({
    projectId: other.id,
    name: "staging",
    baseUrl: "http://127.0.0.1:9",
  });
  const mine = await f.source("prd.md", "# Checkout\nTotals include VAT.");
  const theirs = await f.source("other.md", "# Billing\nInvoices are monthly.", other.id);

  await refusal(() =>
    f.app.memory.create(f.projectId, {
      text: "Borrowed fact",
      sourceRefs: [{ sourceRevisionId: theirs.revision.id }],
    }),
  ).toMatchObject({ code: "INVALID_ARGUMENT" });

  f.approve(f.add("Totals include VAT", mine.revision.id));
  const foreign = f.app.memory.create(other.id, {
    text: "Invoices are monthly",
    sourceRefs: [{ sourceRevisionId: theirs.revision.id }],
  });
  f.app.memory.approve(foreign.id, { expectedVersion: 1 });

  expect(await f.memoryTexts("plan", f.projectId)).toEqual(["Totals include VAT"]);
  expect(await f.memoryTexts("plan", other.id)).toEqual(["Invoices are monthly"]);
  expect(f.app.memory.list(f.projectId).map((entry) => entry.text)).toEqual(["Totals include VAT"]);
  expect(f.app.memory.list(other.id).map((entry) => entry.text)).toEqual(["Invoices are monthly"]);
});

/** The memory service is synchronous: a refusal is a throw, read as a rejection to match on it. */
function refusal(action: () => unknown) {
  return expect(Promise.resolve().then(action)).rejects;
}
