import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { asOwner } from "../m4-portal-support.js";
import type { SweepContext, SweepSeed } from "./types.js";

/**
 * Sweep data for the S4a pages (onboarding, sources, discovery, requirements, feature map): a
 * source with two revisions, one discovery and a saved onboarding state, all in the project the
 * project pages share.
 */
const openapi = (paths: Record<string, unknown>) =>
  JSON.stringify({ openapi: "3.1.0", info: { title: "Sweep", version: "1" }, paths });
const ok = { responses: { "200": { description: "ok" } } };

async function projectOf(context: SweepContext): Promise<string> {
  const cached = context.recall("projectId");
  if (cached) return cached;
  const created = await context.client.mutate("POST", "/v1/projects", { name: "Sweep project" });
  if (created.status !== 201)
    throw new Error(`project seed failed: ${created.status} ${created.text}`);
  const id = created.json<{ data: { id: string } }>().data.id;
  context.remember("projectId", id);
  const environment = await context.client.mutate("POST", `/v1/projects/${id}/environments`, {
    name: "Staging",
    baseUrl: "https://staging.sweep.test",
    networkProfile: "public",
    production: false,
  });
  if (environment.status !== 201)
    throw new Error(`environment seed failed: ${environment.status} ${environment.text}`);
  return id;
}

/** Idempotent: creates the shared data once per sweep run and remembers the ids. */
async function seed(context: SweepContext): Promise<{ projectId: string; sourceId: string }> {
  const projectId = await projectOf(context);
  const cached = context.recall("s4a:sourceId");
  if (cached) return { projectId, sourceId: cached };
  const app = await asOwner(context.stack);
  const file = join(context.stack.cwd, "sweep-openapi.json");
  await writeFile(file, openapi({ "/health": { get: ok }, "/legacy": { get: ok } }));
  const first = await app.sources.add({
    projectId,
    role: "api-spec",
    path: "sweep-openapi.json",
    format: "openapi",
  });
  await writeFile(file, openapi({ "/health": { get: ok }, "/orders": { post: ok } }));
  await app.sources.add({
    projectId,
    role: "api-spec",
    path: "sweep-openapi.json",
    format: "openapi",
    sourceId: first.source.id,
    expectedVersion: Number(first.source.version),
  });
  const discovery = await app.discovery.discover({ projectId });
  context.remember("s4a:sourceId", first.source.id);
  context.remember("s4a:discoveryId", discovery.job.id);
  return { projectId, sourceId: first.source.id };
}

const sweepSeed: SweepSeed = {
  params: {
    async sourceId(context) {
      return (await seed(context)).sourceId;
    },
    async discoveryId(context) {
      await seed(context);
      const id = context.recall("s4a:discoveryId");
      if (!id) throw new Error("discovery seed did not run");
      return id;
    },
  },
  routes: {
    async "/projects/:projectId/sources"(context) {
      await seed(context);
    },
    async "/projects/:projectId/discovery"(context) {
      await seed(context);
    },
  },
  journeySteps: {
    /** The wizard with saved progress at the target step and a source already selected. */
    async onboarding(context) {
      const { projectId, sourceId } = await seed(context);
      const url = `/v1/projects/${projectId}/onboarding`;
      const current = await context.client.request("GET", url);
      const saved = await context.client.mutate(
        "PUT",
        url,
        {
          currentStep: "target",
          completedSteps: ["mode", "project", "source"],
          choices: {
            mode: "server",
            sourceIds: [sourceId],
            target: { baseUrl: "https://staging.sweep.test", networkProfile: "public" },
          },
        },
        { "if-match": String(current.headers.etag) },
      );
      if (saved.status !== 200)
        throw new Error(`onboarding seed failed: ${saved.status} ${saved.text}`);
      return `/projects/${projectId}/onboarding`;
    },
  },
};

export default sweepSeed;
