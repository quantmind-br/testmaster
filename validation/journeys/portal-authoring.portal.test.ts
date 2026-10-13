import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Application, scaffoldPlan } from "@testmaster/application";
import { type ExecutablePlan, routeCatalog } from "@testmaster/contracts";
import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeModel, fakeModelEnv, startFakeModel } from "./fake-model.js";
import {
  atViewport,
  expectAccessible,
  expectNoPageOverflow,
  keyboardOnly,
  type OpenPortal,
  openPortal,
} from "./portal.js";
import { type ServerStack, type StackUser, startServerStack } from "./server-stack.js";
import type { HttpsClient } from "./tls-proxy.js";

/**
 * M4-04 acceptance: a real browser authors tests through the portal on the server profile, and
 * every request it makes is a catalog `/v1` route. The model is a local scripted provider, so no
 * paid call is made. Data is seeded through the application (sources, requirements, generation)
 * because those steps have no portal surface in this slice; everything under test is done in the UI
 * or through the public API.
 */
let stack: ServerStack;
let model: FakeModel;
const open: OpenPortal[] = [];
const everyRequest: string[] = [];

const hostileName = `<img src=x onerror="window.__pwned='img'"> Hostile <script>window.__pwned='script'</script>`;

beforeAll(async () => {
  model = await startFakeModel();
  // The in-process application used for seeding reads the provider key from this process.
  process.env.FAKE_KEY = fakeModelEnv.FAKE_KEY;
  stack = await startServerStack({
    homeFiles: model.homeFiles(),
    env: fakeModelEnv,
  });
}, 600_000);

afterAll(async () => {
  for (const portal of open.splice(0)) {
    everyRequest.push(...portal.diagnostics.requests);
    await portal.close().catch(() => undefined);
  }
  await stack?.stop();
  await model?.close();
  delete process.env.FAKE_KEY;
});

/**
 * Browsers rotate through three workspace admins: the server rate-limits state-changing calls per
 * person (the previews and plan checks the pages send count), and sign-ins per client address, so
 * neither one person nor one new person per test fits.
 */
const reviewers: StackUser[] = [];
let nextReviewer = 0;
let viewer: StackUser | null = null;
async function portal(
  role: "org_admin" | "viewer" = "org_admin",
): Promise<OpenPortal & { user: StackUser }> {
  const index = nextReviewer++ % 3;
  let user: StackUser;
  if (role === "viewer") {
    viewer ??= await stack.addMember("viewer");
    user = viewer;
  } else {
    reviewers[index] ??= await stack.addMember("org_admin");
    user = reviewers[index] as StackUser;
  }
  const opened = await openPortal(
    { baseUrl: stack.baseUrl, spkiSha256: stack.ca.spkiSha256 },
    user,
  );
  open.push(opened);
  return { ...opened, user };
}

/** The same person as a browser session, for requests the page cannot resend itself. */
async function signedIn(user: StackUser): Promise<HttpsClient> {
  const client = stack.anonymous();
  const response = await client.request("POST", "/v1/identity/login", {
    body: { principal: user.login, password: user.password },
    headers: { origin: stack.baseUrl, "idempotency-key": crypto.randomUUID() },
  });
  if (response.status !== 200) throw new Error(`login failed: ${response.status}`);
  client.csrfToken = response.json<{ data: { csrfToken: string } }>().data.csrfToken;
  return client;
}

async function system(): Promise<Application> {
  return (await stack.application()).forWorkspaceSystem(stack.workspaceId);
}

async function newProject(
  name: string,
  keys: readonly string[],
): Promise<{
  projectId: string;
  requirements: Requirement[];
  sourceId: string;
  environmentId: string;
}> {
  const app = await system();
  const projectId = app.projects.create({ name }).id;
  const environment = app.environments.create({
    projectId,
    name: "Local",
    baseUrl: "http://127.0.0.1:9",
    networkProfile: "local-loopback",
  });
  await writeFile(
    join(stack.cwd, `prd-${projectId}.md`),
    `# Health\nThe health endpoint must report ok. ${keys.join(" ")}`,
  );
  const source = await app.sources.add({
    projectId,
    role: "prd",
    path: join(stack.cwd, `prd-${projectId}.md`),
    format: "markdown",
  });
  app.model.grantConsent(projectId, "fake", ["documents", "requirements", "plans"], true);
  model.setOutput({
    requirements: keys.map((key) => ({
      key,
      text: `Health requirement ${key}`,
      acceptanceCriteria: ["Health reports ok"],
      evidenceIds: ["E1"],
      originKind: "user_spec",
      confidence: null,
      reason: "Explicit PRD",
    })),
    conflicts: [],
    openQuestions: [],
  });
  const normalized = await app.requirements.normalize({
    projectId,
    sourceRevisionIds: [source.revision.id],
  });
  for (const requirement of normalized.requirements)
    app.requirements.approve(requirement.id, requirement.version ?? 1);
  return {
    projectId,
    requirements: normalized.requirements,
    sourceId: source.source.id,
    environmentId: environment.id,
  };
}

interface Requirement {
  readonly id: string;
}

function plan(requirement: Requirement, name: string, tweak?: (plan: ExecutablePlan) => void) {
  const value = scaffoldPlan("backend");
  value.name = name;
  value.requirementRefs = [requirement.id];
  tweak?.(value);
  return {
    plan: value,
    requirementRefs: [requirement.id],
    evidenceIds: ["E1"],
    warnings: [] as string[],
  };
}

async function generate(projectId: string, proposals: ReturnType<typeof plan>[]) {
  model.setOutput({ proposals });
  const app = await system();
  return app.proposals.generate({ projectId });
}

/** A project whose first requirement already has a test, created directly so seeding stays fast. */
async function projectWithTest(name: string, keys: readonly string[] = ["A"]) {
  const seeded = await newProject(name, keys);
  const [requirement] = seeded.requirements;
  if (!requirement) throw new Error("No requirement");
  const app = await system();
  const test = app.tests.create({
    projectId: seeded.projectId,
    plan: plan(requirement, "Health reports ok").plan,
  });
  return { ...seeded, requirement, testId: test.id };
}

const card = (page: Page, name: string): Locator =>
  page.locator("article.proposal-card", {
    has: page.getByRole("heading", { level: 3, name, exact: true }),
  });

async function confirm(page: Page, label: string): Promise<void> {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: label, exact: true }).click();
}

describe("portal authoring on the server profile", () => {
  it("M4-04 UX-015 UX-016 reviews a subset in the real UI: A and B are accepted, C stays pending, a resend changes nothing", async () => {
    const { projectId, requirements } = await newProject("Subset review", ["A", "B", "C"]);
    const [ra, rb, rc] = requirements;
    if (!ra || !rb || !rc) throw new Error("Missing requirements");
    const batch = await generate(projectId, [
      plan(ra, "Scenario A"),
      plan(rb, "Scenario B"),
      plan(rc, "Scenario C"),
    ]);
    const { page, user } = await portal();
    await page.goto(`/proposal-batches/${batch.id}`);
    await page.getByRole("heading", { level: 1, name: "Proposal batch" }).waitFor();
    // Preview before deciding: what each acceptance would create, who wrote it, how long it takes.
    const a = card(page, "Scenario A");
    await a.getByText("A new test, revision 1").waitFor();
    expect(await a.textContent()).toContain("Generated by the model");
    expect(await a.textContent()).toMatch(/Estimated duration\s*\d/);
    expect(await page.getByTestId("selection-summary").textContent()).toContain("0 of 3");

    await page.getByRole("checkbox", { name: "Scenario A" }).check();
    await page.getByRole("checkbox", { name: "Scenario B" }).check();
    expect(await page.getByTestId("selection-summary").textContent()).toContain("2 of 3");
    const request = page.waitForRequest((candidate) => candidate.url().endsWith("/accept"));
    await page.getByRole("button", { name: "Accept 2 selected" }).click();
    await page.getByRole("dialog").waitFor();
    expect(await page.getByRole("dialog").textContent()).toContain("Staying pending");
    await confirm(page, "Accept");
    const accepted = await request;
    const receipt = page.getByTestId("receipt");
    await receipt.waitFor();
    expect(await receipt.textContent()).toContain("2 tests created");
    expect(await receipt.textContent()).toContain("1 left pending");

    // C was not touched: still pending and still selectable.
    await page.getByRole("checkbox", { name: "Scenario C" }).waitFor();
    expect(await page.getByRole("checkbox", { name: "Scenario C" }).isEnabled()).toBe(true);
    const app = await system();
    const tests = app.tests.list(projectId);
    expect(tests.map((test) => test.name).sort()).toEqual(["Scenario A", "Scenario B"]);
    const detail = app.proposals.detail(batch.id);
    expect(detail.proposals.map((proposal) => [proposal.plan.name, proposal.state]).sort()).toEqual(
      [
        ["Scenario A", "accepted"],
        ["Scenario B", "accepted"],
        ["Scenario C", "proposed"],
      ],
    );

    // Resending the same request with the same key returns the same receipt and creates nothing.
    const headers = accepted.headers();
    const resend = await (await signedIn(user)).mutate(
      "POST",
      `/v1/proposal-batches/${batch.id}/accept`,
      JSON.parse(accepted.postData() ?? "{}"),
      {
        "idempotency-key": headers["idempotency-key"] ?? "",
        "if-match": headers["if-match"] ?? "",
      },
    );
    expect(resend.status).toBe(200);
    expect(resend.json<{ data: { accepted: string[] } }>().data.accepted).toHaveLength(2);
    expect(app.tests.list(projectId)).toHaveLength(2);
    await expectAccessible(page, "proposal batch after partial accept");
  });

  it("UX-017 an exact duplicate needs an explicit decision, a merely similar proposal only warns, and both show their match", async () => {
    const { projectId, requirements, testId } = await projectWithTest("Duplicates", ["A", "B"]);
    const [ra, rb] = requirements;
    if (!ra || !rb) throw new Error("Missing requirements");
    const batch = await generate(projectId, [
      plan(ra, "Health again"),
      plan(rb, "Health trimmed", (value) => {
        value.steps = value.steps.slice(0, 2);
      }),
    ]);
    const { page } = await portal();
    await page.goto(`/proposal-batches/${batch.id}`);
    const duplicate = card(page, "Health again");
    await duplicate.getByText("Exact duplicate").waitFor();
    expect(await duplicate.getByTestId("similar").textContent()).toMatch(/100% match with test/);
    const similar = card(page, "Health trimmed");
    await similar.getByTestId("similar").waitFor();
    expect(await similar.textContent()).not.toContain("Exact duplicate");
    expect(await similar.getByTestId("similar").textContent()).toMatch(/\d+% match with test/);

    // The merely similar proposal can be accepted straight away.
    await page.getByRole("checkbox", { name: "Health trimmed" }).check();
    expect(await page.getByRole("button", { name: "Accept 1 selected" }).isEnabled()).toBe(true);
    await page.getByRole("checkbox", { name: "Health trimmed" }).uncheck();

    // The exact duplicate blocks accepting until the reviewer decides.
    await page.getByRole("checkbox", { name: "Health again" }).check();
    expect(await page.getByRole("button", { name: "Accept 1 selected" }).isDisabled()).toBe(true);
    expect(await page.getByTestId("accept-blocked").textContent()).toContain("duplicate");
    await page
      .getByRole("checkbox", { name: /I accept this proposal even though it duplicates/ })
      .check();
    await page.getByRole("button", { name: "Accept 1 selected" }).click();
    await confirm(page, "Accept");
    await page.getByTestId("receipt").waitFor();
    const app = await system();
    expect(app.tests.list(projectId)).toHaveLength(2);
    expect(app.tests.get(testId).activeRevisionId).not.toBeNull();

    // Without the acknowledgement the API refuses the same decision.
    const other = await generate(projectId, [
      plan(ra, "Health third"),
      plan(rb, "Health fourth", (value) => {
        value.steps = value.steps.slice(0, 2);
      }),
    ]);
    const detail = await stack.ownerClient().request("GET", `/v1/proposal-batches/${other.id}`);
    const proposals = detail
      .json<{ data: { proposals: { id: string; plan: { name: string } }[] } }>()
      .data.proposals.filter((proposal) => proposal.plan.name === "Health third");
    const refused = await stack
      .ownerClient()
      .mutate(
        "POST",
        `/v1/proposal-batches/${other.id}/accept`,
        { proposalIds: proposals.map((proposal) => proposal.id), expectedVersion: other.version },
        { "if-match": `"${other.version}"` },
      );
    expect(refused.status).toBe(422);
    expect(refused.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      "duplicate_decision_required",
    );
  });

  it("UX-018 generation shows its budget, cancelling keeps the prepared phases and creates nothing, and resume completes", async () => {
    const { projectId, requirements } = await newProject("Generation", ["A"]);
    const [requirement] = requirements;
    if (!requirement) throw new Error("Missing requirement");
    const limit = await stack
      .ownerClient()
      .mutate("POST", `/v1/projects/${projectId}/budget`, { tokens: 100_000 });
    expect(limit.status).toBe(200);
    const { page } = await portal();
    await page.goto(`/projects/${projectId}/proposals`);
    await page.getByRole("heading", { level: 2, name: "Generate proposals" }).waitFor();
    await page.getByText("Requirements approved").waitFor();
    await expect
      .poll(async () => page.getByTestId("token-budget").textContent())
      .toMatch(/of 100,000/);
    await expect
      .poll(async () => page.getByTestId("requirement-count").textContent())
      .toMatch(/1 of 1/);
    const callsBefore = Number(await page.getByTestId("call-count").textContent());

    model.setOutput({ proposals: [plan(requirement, "Generated after resume")] });
    const arrived = model.completionArrived();
    const cancelled = model.completionAborted();
    const release = model.holdResponses();
    await page.getByRole("button", { name: "Generate proposals" }).click();
    await arrived;
    await page.getByRole("button", { name: "Cancel generation" }).click();
    await expect
      .poll(async () => page.getByTestId("generation-phase").textContent())
      .toContain("Generation was cancelled");
    // The server saw the browser leave and cancelled the model call before any answer existed.
    await cancelled;
    release();
    // Nothing was stored, and the prepared sources and requirements are untouched.
    const listed = await stack
      .ownerClient()
      .request("GET", `/v1/projects/${projectId}/proposal-batches`);
    expect(listed.json<{ data: { items: unknown[] } }>().data.items).toHaveLength(0);
    expect(await page.getByTestId("requirement-count").textContent()).toMatch(/1 of 1/);
    expect(callsBefore).toBeGreaterThanOrEqual(0);

    await page.getByRole("button", { name: "Resume generation" }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/proposal-batches/"));
    await card(page, "Generated after resume").waitFor();
    const after = await stack
      .ownerClient()
      .request("GET", `/v1/projects/${projectId}/proposal-batches`);
    expect(after.json<{ data: { items: unknown[] } }>().data.items).toHaveLength(1);
  });

  it("UX-018 a project without a token limit says so instead of failing the generate panel", async () => {
    const { projectId } = await newProject("No limit", ["A"]);
    const { page, diagnostics } = await portal();
    await page.goto(`/projects/${projectId}/proposals`);
    await page.getByRole("heading", { level: 2, name: "Generate proposals" }).waitFor();
    await expect
      .poll(async () => page.getByTestId("token-budget").textContent())
      .toContain("No limit set for this project");
    expect(diagnostics.pageErrors).toEqual([]);
    await expectAccessible(page, "generate panel without a token limit");
  });

  it("UX-019 only a person in an interactive session may accept; a token is refused and told why, and nothing becomes a test", async () => {
    const { projectId, requirements } = await newProject("Policy", ["A"]);
    const [requirement] = requirements;
    if (!requirement) throw new Error("Missing requirement");
    const batch = await generate(projectId, [plan(requirement, "Needs a person")]);
    const token = await stack.issueToken(stack.owner.principalId, ["R", "W", "X", "A"]);
    const automation = stack.anonymous();
    const headers = { authorization: `Bearer ${token}`, origin: stack.baseUrl };
    const detail = await automation.request("GET", `/v1/proposal-batches/${batch.id}`, {
      headers,
      cookies: false,
    });
    const proposals = detail.json<{ data: { proposals: { id: string }[] } }>().data.proposals;
    const preview = await automation.request("POST", `/v1/proposal-batches/${batch.id}/preview`, {
      body: { proposalIds: proposals.map((proposal) => proposal.id) },
      headers: { ...headers, "idempotency-key": crypto.randomUUID() },
      cookies: false,
    });
    expect(
      preview.json<{ data: { policy: { canAccept: boolean; reason: string } } }>().data.policy,
    ).toMatchObject({
      canAccept: false,
      reason: "interactive_acceptance_required",
    });
    const denied = await automation.request("POST", `/v1/proposal-batches/${batch.id}/accept`, {
      body: {
        proposalIds: proposals.map((proposal) => proposal.id),
        expectedVersion: batch.version,
      },
      headers: {
        ...headers,
        "idempotency-key": crypto.randomUUID(),
        "if-match": `"${batch.version}"`,
      },
      cookies: false,
    });
    expect(denied.status).toBe(422);
    expect(
      denied.json<{ error: { code: string; details: { reason: string } } }>().error,
    ).toMatchObject({
      code: "POLICY_DENIED",
      details: { reason: "interactive_acceptance_required" },
    });
    expect((await system()).tests.list(projectId)).toHaveLength(0);

    // The same decision is available to the person in the portal, with the policy stated.
    const { page } = await portal();
    await page.goto(`/proposal-batches/${batch.id}`);
    await expect.poll(async () => page.getByTestId("policy").textContent()).toMatch(/\S/);
    await page.getByRole("checkbox", { name: "Needs a person" }).check();
    expect(await page.getByRole("button", { name: "Accept 1 selected" }).isEnabled()).toBe(true);

    // A viewer can read the batch, is told why accepting is unavailable, and the server agrees.
    const reader = await portal("viewer");
    await reader.page.goto(`/proposal-batches/${batch.id}`);
    await expect
      .poll(async () => reader.page.getByTestId("policy").textContent())
      .toContain("Your role can read this batch but not accept it");
    // Nothing can be selected for acceptance, so the accept action stays disabled with the reason above.
    await reader.page.getByRole("button", { name: /^Accept \d+ selected$/ }).waitFor();
    expect(
      await reader.page.getByRole("button", { name: /^Accept \d+ selected$/ }).isDisabled(),
    ).toBe(true);
    expect((await system()).tests.list(projectId)).toHaveLength(0);
  });

  it("UX-021 M4-04 a concurrent edit to a proposal is shown as a diff and never overwritten silently", async () => {
    const { projectId, requirements } = await newProject("Conflict", ["A"]);
    const [requirement] = requirements;
    if (!requirement) throw new Error("Missing requirement");
    const batch = await generate(projectId, [plan(requirement, "Contested")]);
    const read = async () => {
      const response = await stack.ownerClient().request("GET", `/v1/proposal-batches/${batch.id}`);
      const [proposal] = response.json<{
        data: { proposals: { id: string; version: number; plan: ExecutablePlan }[] };
      }>().data.proposals;
      if (!proposal) throw new Error("Missing proposal");
      return proposal;
    };
    const original = await read();
    const { page } = await portal();
    await page.goto(`/proposal-batches/${batch.id}`);
    const proposal = card(page, "Contested");
    await proposal.getByRole("button", { name: "Edit plan" }).click();
    const editor = proposal.getByRole("textbox", { name: "Plan for Contested" });
    await editor.fill(JSON.stringify({ ...original.plan, name: "Mine" }, null, 2));

    // Someone else saves first.
    const competing = await stack
      .ownerClient()
      .mutate(
        "PATCH",
        `/v1/proposals/${original.id}`,
        { ...original, plan: { ...original.plan, name: "Theirs" } },
        { "if-match": `"${original.version}"` },
      );
    expect(competing.status).toBe(200);

    await proposal.getByRole("button", { name: "Save proposal" }).click();
    const conflict = page.getByTestId("edit-conflict");
    await conflict.waitFor();
    expect(await conflict.textContent()).toContain("Nothing was overwritten");
    expect(await conflict.locator("table.diff").textContent()).toContain("Theirs");
    expect((await read()).plan.name).toBe("Theirs");

    // Recovery: keep my edits on top of theirs, then save again.
    await conflict.getByRole("button", { name: "Keep my edits on top of theirs" }).click();
    await proposal.getByRole("button", { name: "Save proposal" }).click();
    await expect.poll(async () => (await read()).plan.name).toBe("Mine");
  });

  it("REQ-054 a chat refinement lands as a new proposal for review, a weakening answer is refused, and no test changes", async () => {
    const { projectId, requirements } = await newProject("Refinement", ["A"]);
    const [requirement] = requirements;
    if (!requirement) throw new Error("Missing requirement");
    const batch = await generate(projectId, [plan(requirement, "Refine me")]);
    const app = await system();
    const { page } = await portal();
    await page.goto(`/proposal-batches/${batch.id}`);
    const proposal = card(page, "Refine me");
    await proposal.getByRole("button", { name: "Refine with chat" }).click();

    // A refinement that removes the required health check is refused and stores nothing.
    model.setOutput({
      proposals: [
        plan(requirement, "Refine me", (value) => {
          value.steps = value.steps.filter((step) => step.id !== "check-health");
        }),
      ],
    });
    await proposal.getByLabel("Your instruction").fill("Drop the flaky health check");
    await proposal.getByRole("button", { name: "Send", exact: true }).click();
    await proposal.getByTestId("action-error").waitFor();
    expect(await proposal.getByTestId("action-error").textContent()).toContain("INVALID_ARGUMENT");
    expect(app.proposals.detail(batch.id).proposals).toHaveLength(1);

    // Adding a check is accepted as a new proposal in the same batch; the original stays.
    model.setOutput({
      proposals: [
        plan(requirement, "Refine me", (value) => {
          value.steps.push({
            id: "check-version",
            kind: "assertion",
            operation: "assert",
            description: "Require the reported version",
            required: true,
            input: { responseStepId: "get-health", jsonPointer: "/version" },
            expectation: { predicate: "jsonEquals", value: { literal: "1" } },
          });
        }),
      ],
    });
    await proposal.getByLabel("Your instruction").fill("Also check the version");
    await proposal.getByRole("button", { name: "Send", exact: true }).click();
    await proposal
      .getByRole("link", { name: "Review the proposal this conversation produced" })
      .waitFor();
    await expect
      .poll(async () =>
        page.getByRole("heading", { level: 3, name: "Refine me", exact: true }).count(),
      )
      .toBe(2);
    expect(app.proposals.detail(batch.id).proposals).toHaveLength(2);
    expect(app.tests.list(projectId)).toHaveLength(0);
    expect(
      await proposal.getByRole("listitem").filter({ hasText: "Also check the version" }).count(),
    ).toBe(1);
  });

  it("UX-020 UX-022 UX-023 UX-024 the editor blocks an unrunnable plan, undoes locally, recovers a draft, publishes with a diff and keeps revision 1 intact", async () => {
    const seeded = await projectWithTest("Editor");
    const app = await system();
    const test = app.tests.get(seeded.testId);
    const revisionOne = test.activeRevisionId;
    if (!revisionOne) throw new Error("No active revision");
    const runId = `run_${crypto.randomUUID()}`;
    app.context.entities.insert("Run", {
      id: runId,
      workspaceId: app.context.workspaceId,
      testId: seeded.testId,
      revisionId: revisionOne,
      environmentRevisionId: app.environments.get(seeded.environmentId).activeRevisionId,
      batchId: null,
      matrixCell: {},
      mode: "replay",
      phase: "completed",
      status: "passed",
      outcome: "passed",
      origin: "api",
      gatePolicy: {},
      gate: "passed",
      cleanupOutcome: "not_required",
      analysisStatus: "not_requested",
    });
    const original = app.revisions.get(revisionOne);
    const { page } = await portal();
    await page.goto(`/tests/${seeded.testId}`);
    await page.getByRole("heading", { level: 1, name: "Health reports ok" }).waitFor();
    const row = page.getByRole("row").filter({ hasText: revisionOne });
    await row.getByText("Current", { exact: true }).waitFor();
    await row.getByText("Executed", { exact: true }).waitFor();
    const editor = page.getByRole("textbox", { name: "Plan", exact: true });
    const baseText = await editor.inputValue();

    // UX-022: a missing secret blocks running and publishing, naming the step and field.
    const broken = JSON.parse(baseText) as ExecutablePlan;
    const request = broken.steps.find((step) => step.id === "get-health");
    if (request?.kind !== "action") throw new Error("Unexpected scaffold");
    (request as unknown as { input: { headers: Record<string, unknown> } }).input.headers = {
      "x-api-key": { secretRef: "sec_00000000-0000-4000-8000-000000000000" },
    };
    await editor.fill(JSON.stringify(broken, null, 2));
    const problems = page.getByRole("list", { name: "Problems found" });
    await problems.waitFor();
    const issue = problems.locator('li[data-code="secret_missing"]');
    await issue.waitFor();
    expect(await issue.textContent()).toContain("Step get-health");
    expect(await issue.textContent()).toContain("/headers");
    expect(await page.getByTestId("run-blocked").textContent()).toMatch(/Save your edits|problems/);
    expect(await page.getByRole("button", { name: "Review and publish" }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: /^Run revision/ }).isDisabled()).toBe(true);

    // UX-023: local undo restores the previous text without a request.
    await page.getByRole("button", { name: "Undo last edit" }).click();
    expect(await editor.inputValue()).toBe(baseText);
    await expect
      .poll(async () => page.getByTestId("plan-check").textContent())
      .toContain("can be run");
    expect(await page.getByRole("button", { name: /^Run revision/ }).isEnabled()).toBe(true);

    // A real change to an assertion, kept as a draft across a reload.
    expect(baseText.match(/"ok"/g)).toHaveLength(1);
    const changed = baseText.replace('"ok"', '"healthy"');
    await editor.fill(changed);
    await page.getByRole("button", { name: "Save draft" }).click();
    await page
      .getByText("Draft saved. The published revision is unchanged.")
      .waitFor({ state: "attached" });
    await page.reload();
    await page.getByTestId("draft-restored").waitFor();
    expect(await page.getByRole("textbox", { name: "Plan", exact: true }).inputValue()).toBe(
      changed,
    );
    expect(app.revisions.list(seeded.testId)).toHaveLength(1);
    expect(app.tests.get(seeded.testId).activeRevisionId).toBe(revisionOne);

    // Review the diff, give a reason and publish: a candidate revision 2 appears.
    await page.getByRole("button", { name: "Review and publish" }).click();
    const review = page.getByTestId("publish-review");
    expect(await review.locator("table.diff").textContent()).toContain("healthy");
    await review.getByLabel("Why are you changing this?").fill("Tighten the health expectation");
    await review.getByRole("button", { name: "Publish as a new revision" }).click();
    await confirm(page, "Publish");
    await expect.poll(() => app.revisions.list(seeded.testId).length).toBe(2);
    const [second] = app.revisions
      .list(seeded.testId)
      .filter((revision) => revision.id !== revisionOne);
    if (!second) throw new Error("Missing revision 2");
    const rowTwo = page.getByRole("row").filter({ hasText: second.id });
    await rowTwo.getByText("Candidate", { exact: true }).waitFor();

    // UX-020: revision 1 is unchanged, still current and still the one the Run used.
    expect(app.revisions.get(revisionOne)).toEqual(original);
    expect(app.tests.get(seeded.testId).activeRevisionId).toBe(revisionOne);
    const rowOne = page.getByRole("row").filter({ hasText: revisionOne });
    await rowOne.getByText("Executed", { exact: true }).waitFor();
    expect(await rowTwo.getByText("Executed", { exact: true }).count()).toBe(0);
    const download = page.waitForEvent("download");
    await rowOne.getByRole("button", { name: "Download revision 1" }).click();
    const file = await (await download).createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of file) chunks.push(Buffer.from(chunk));
    const downloaded = JSON.parse(Buffer.concat(chunks).toString()) as {
      revisionId: string;
      contentHash: string;
      plan: ExecutablePlan;
    };
    expect(downloaded).toMatchObject({
      revisionId: revisionOne,
      contentHash: original.contentHash,
    });
    expect(JSON.stringify(downloaded.plan)).toContain('{"literal":"ok"}');
    expect(JSON.stringify(downloaded.plan)).not.toContain('{"literal":"healthy"}');

    // The draft is gone once published.
    await page.reload();
    await page.getByRole("heading", { level: 1, name: "Health reports ok" }).waitFor();
    expect(await page.getByTestId("draft-restored").count()).toBe(0);

    // UX-024: history says what kind of change it was, who made it and why.
    const history = page.getByRole("region", { name: "Revision change history" });
    const entry = history.getByRole("row").filter({ hasText: second.id });
    await entry.getByText("Intent or assertion change").waitFor();
    expect(await entry.textContent()).toContain("Tighten the health expectation");
    expect(await entry.textContent()).toContain("Written by a person");
    expect(await entry.textContent()).toContain("check-health");
    expect(await entry.textContent()).not.toContain("Auto-heal");
    await expectAccessible(page, "test page with revisions and history");
  });

  it("UX-025 hostile titles, step text and test names render as inert text in every authoring page", async () => {
    const { projectId, requirements } = await newProject("Hostile content", ["A"]);
    const [requirement] = requirements;
    if (!requirement) throw new Error("Missing requirement");
    const batch = await generate(projectId, [
      plan(requirement, hostileName, (value) => {
        const [first] = value.steps;
        if (first) first.description = hostileName;
      }),
    ]);
    const { page, diagnostics } = await portal();
    const expectInert = async () => {
      expect(await page.locator("main img").count()).toBe(0);
      expect(await page.locator("main script").count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { __pwned?: string }).__pwned)).toBe(
        undefined,
      );
    };
    await page.goto(`/proposal-batches/${batch.id}`);
    await page.getByRole("heading", { level: 3 }).first().waitFor();
    expect(await page.getByRole("heading", { level: 3 }).first().textContent()).toContain(
      "<script>",
    );
    await page.locator("details summary").first().click();
    expect(await page.locator("pre.untrusted-block").first().textContent()).toContain("<img");
    await expectInert();

    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "Accept 1 selected" }).click();
    await confirm(page, "Accept");
    const receipt = page.getByTestId("receipt");
    await receipt.waitFor();
    await receipt.getByRole("link").first().click();
    await page.waitForURL((url) => url.pathname.startsWith("/tests/"));
    const title = page.getByRole("heading", { level: 1, name: /Hostile/ });
    await title.waitFor();
    expect(await title.textContent()).toContain("<script>");
    await expectInert();
    await page.goto(`/projects/${projectId}/tests`);
    await page.getByRole("link", { name: /Hostile/ }).waitFor();
    await expectInert();
    expect(diagnostics.pageErrors).toEqual([]);
  });

  it("M4-04 every request the authoring pages make is a catalog /v1 route, and the pages are axe clean and reflow at 320 px", async () => {
    const { projectId, requirements } = await newProject("Catalog and a11y", ["A"]);
    const [requirement] = requirements;
    if (!requirement) throw new Error("Missing requirement");
    const batch = await generate(projectId, [plan(requirement, "Accessible scenario")]);
    const { page } = await portal();
    for (const path of [
      `/projects/${projectId}/proposals`,
      `/proposal-batches/${batch.id}`,
      `/projects/${projectId}/tests`,
    ]) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await page.getByRole("main").waitFor();
      await expectAccessible(
        page,
        `authoring ${path.replace(/[a-z]{3}_[0-9a-f-]+/g, ":id")} desktop`,
      );
    }
    await atViewport(page, { width: 320, zoom: 2, textScale: 1 });
    for (const path of [`/projects/${projectId}/proposals`, `/proposal-batches/${batch.id}`]) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await expectNoPageOverflow(page, `authoring ${path} at 320 px`);
      await expectAccessible(
        page,
        `authoring ${path.replace(/[a-z]{3}_[0-9a-f-]+/g, ":id")} 320px 200%`,
      );
    }

    // Everything the browsers requested across this journey, checked against the catalog.
    const requests = [...everyRequest, ...open.flatMap((entry) => entry.diagnostics.requests)];
    const calls = requests
      .map((entry) => {
        const [method = "", target = ""] = entry.split(" ");
        return { method, path: target.split("?")[0] ?? "" };
      })
      .filter((call) => call.path.startsWith("/v1/"));
    const catalog = routeCatalog.map((route) => ({
      method: route.method,
      pattern: new RegExp(`^(?:/v1)?${route.path.replace(/\{[^}]+\}/g, "[^/]+")}$`),
    }));
    const unknown = calls.filter(
      (call) =>
        !catalog.some((route) => route.method === call.method && route.pattern.test(call.path)),
    );
    expect(unknown).toEqual([]);
    const used = new Set(
      calls.map((call) => `${call.method} ${call.path.replace(/[a-z]{3}_[0-9a-f-]{36}/g, "{id}")}`),
    );
    for (const expected of [
      "POST /v1/proposal-batches/{id}/preview",
      "POST /v1/proposal-batches/{id}/accept",
      "POST /v1/projects/{id}/plan-validations",
      "GET /v1/tests/{id}/history",
      "PUT /v1/tests/{id}/draft",
      "POST /v1/tests/{id}/revisions",
      "POST /v1/proposals/{id}/refinements",
      "PATCH /v1/proposals/{id}",
      "POST /v1/projects/{id}/proposal-batches",
    ])
      expect(used, expected).toContain(expected);
  });

  it("UX-015 UX-016 a keyboard-only reviewer selects a proposal and accepts it without the pointer", async () => {
    const { projectId, requirements } = await newProject("Keyboard review", ["A", "B"]);
    const [ra, rb] = requirements;
    if (!ra || !rb) throw new Error("Missing requirements");
    const batch = await generate(projectId, [plan(ra, "Keyboard A"), plan(rb, "Keyboard B")]);
    const { page } = await portal();
    const keyboard = await keyboardOnly(page);
    await page.goto(`/proposal-batches/${batch.id}`);
    await page.getByRole("heading", { level: 1, name: "Proposal batch" }).waitFor();
    // The checkbox is enabled once the server's preview of the revision it would create has arrived.
    await card(page, "Keyboard A").getByText("A new test, revision 1").waitFor();
    await keyboard.tabTo((element) => element.name === "Keyboard A");
    expect((await keyboard.focused()).focusRing).toBe(true);
    await keyboard.press("Space");
    expect(await page.getByTestId("selection-summary").textContent()).toContain("1 of 2");
    await keyboard.tabTo((element) => element.name === "Accept 1 selected", 60);
    await keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    await keyboard.tabTo((element) => element.name === "Accept", 6);
    await keyboard.press("Enter");
    await page.getByTestId("receipt").waitFor();
    const app = await system();
    expect(app.tests.list(projectId).map((test) => test.name)).toEqual(["Keyboard A"]);
    await keyboard.assertNoPointerUsed();
  });
});
