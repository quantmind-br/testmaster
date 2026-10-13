import type { SweepSeed } from "./types.js";

/**
 * Seeds for the shell pages and the S5b settings pages: one project with an environment, one
 * active test, one secret reference. `projectId` is the parameter the project pages share.
 */
const seed: SweepSeed = {
  params: {
    async projectId(context) {
      const cached = context.recall("projectId");
      if (cached) return cached;
      const created = await context.client.mutate("POST", "/v1/projects", {
        name: "Sweep project",
      });
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
    },
  },
  routes: {
    async "/secrets"(context) {
      const created = await context.client.mutate("POST", "/v1/secrets", {
        name: "sweep-api-token",
        value: "sweep-secret-value-0001",
        allowedOrigins: ["https://staging.sweep.test"],
      });
      // 412 REVISION_CONFLICT means an earlier visit already stored it (the seed runs once per stack).
      if (created.status !== 201 && created.status !== 200 && created.status !== 412)
        throw new Error(`secret seed failed: ${created.status} ${created.text}`);
    },
  },
};

export default seed;
