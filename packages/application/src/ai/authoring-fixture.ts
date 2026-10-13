import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutablePlan } from "@testmaster/contracts";
import { completion, testProvider } from "../../../model-gateway/src/test-support.js";
import { Application } from "../application.js";
import { scaffoldPlan } from "../authoring.js";

/** A real application over a local fake OpenAI-compatible provider; no paid model call is ever made. */
export class AuthoringFixture {
  readonly payloads: Record<string, unknown>[] = [];
  completions = 0;
  private output: unknown = {};
  private hold: Promise<void> | null = null;
  private arrival: PromiseWithResolvers<void> | null = null;
  private constructor(
    readonly app: Application,
    readonly projectId: string,
    readonly root: string,
    private readonly server: Server,
  ) {}
  static async open(): Promise<AuthoringFixture> {
    const root = await mkdtemp(join(tmpdir(), "tm-s4b-"));
    const home = join(root, "home");
    await mkdir(join(home, ".config/testmaster"), { recursive: true });
    let self: AuthoringFixture | null = null;
    const server = createServer(async (request, response) => {
      if (request.url === "/v1/models") {
        response.end(JSON.stringify({ data: [{ id: "model" }] }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      if (!self) return;
      self.payloads.push(payload);
      self.completions++;
      self.arrival?.resolve();
      if (self.hold) await self.hold;
      if (response.destroyed) return;
      const reconciliation = (payload.messages as { content: string }[]).some((message) =>
        message.content.includes("Compare the normalized statements"),
      );
      const current = self.output as { conflicts?: unknown };
      response.end(
        JSON.stringify({
          ...completion,
          choices: [
            {
              message: {
                content: JSON.stringify(
                  reconciliation
                    ? { conflicts: current.conflicts ?? [], openQuestions: [] }
                    : current,
                ),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
    });
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
    const app = await Application.open({ cwd: root, home, env: { HOME: home } });
    const initialized = await app.init();
    self = new AuthoringFixture(app, initialized.projectId, root, server);
    return self;
  }
  async close(): Promise<void> {
    this.app.close();
    if (this.server.listening) await this.stopModel();
    await rm(this.root, { recursive: true, force: true });
    delete process.env.FAKE_KEY;
  }
  /** Simulates an unavailable model provider: later completions fail to connect. */
  async stopModel(): Promise<void> {
    this.server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    this.server.close(() => closed.resolve());
    await closed.promise;
  }
  setOutput(value: unknown): void {
    this.output = value;
  }
  /** Resolves when the next completion request reaches the provider. */
  completionArrived(): Promise<void> {
    this.arrival = Promise.withResolvers<void>();
    return this.arrival.promise;
  }
  /** Makes every completion wait until the returned function is called. */
  holdResponses(): () => void {
    const gate = Promise.withResolvers<void>();
    this.hold = gate.promise;
    return () => {
      gate.resolve();
      this.hold = null;
    };
  }
  /** Normalizes and approves one requirement per key from a PRD file. */
  async approvedRequirements(keys: readonly string[]) {
    await writeFile(
      join(this.root, "prd.md"),
      `# Health\nThe health endpoint must report ok. ${keys.join(" ")}`,
    );
    const source = await this.app.sources.add({
      projectId: this.projectId,
      role: "prd",
      path: join(this.root, "prd.md"),
      format: "markdown",
    });
    this.app.model.grantConsent(
      this.projectId,
      "fake",
      ["documents", "requirements", "plans"],
      true,
    );
    this.setOutput({
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
    const normalized = await this.app.requirements.normalize({
      projectId: this.projectId,
      sourceRevisionIds: [source.revision.id],
    });
    for (const requirement of normalized.requirements)
      this.app.requirements.approve(requirement.id, requirement.version ?? 1);
    return { source, requirements: normalized.requirements };
  }
  /** A backend plan for one requirement; `tweak` customizes it before it is offered as the model answer. */
  planFor(requirementId: string, name: string, tweak?: (plan: ExecutablePlan) => void) {
    const plan = scaffoldPlan("backend");
    plan.name = name;
    plan.requirementRefs = [requirementId];
    tweak?.(plan);
    return {
      plan,
      requirementRefs: [requirementId],
      evidenceIds: ["E1"],
      warnings: [] as string[],
    };
  }
  /** Approves `keys`, answers generation with one proposal each and returns the stored batch. */
  async generatedBatch(keys: readonly string[] = ["A", "B", "C"]) {
    const { requirements, source } = await this.approvedRequirements(keys);
    this.setOutput({
      proposals: requirements.map((requirement, index) =>
        this.planFor(requirement.id, `Scenario ${keys[index]}`),
      ),
    });
    const batch = await this.app.proposals.generate({ projectId: this.projectId });
    const detail = this.app.proposals.detail(batch.id);
    // Stored order is not creation order; callers address proposals A, B, C by name.
    const proposals = [...detail.proposals].sort((a, b) => a.plan.name.localeCompare(b.plan.name));
    return { requirements, source, batch: detail.batch, proposals };
  }
}
