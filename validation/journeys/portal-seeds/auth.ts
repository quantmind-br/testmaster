import type { SweepSeed } from "./types.js";

const origin = "https://staging.sweep.test";

/**
 * Seeds for the authentication pages: one static bearer profile backed by a vault secret, bound to
 * the sweep project's origin. `profileId` is the parameter the profile detail page uses.
 */
const seed: SweepSeed = {
  params: {
    async profileId(context) {
      const cached = context.recall("authProfileId");
      if (cached) return cached;
      const created = await context.client.mutate("POST", "/v1/projects", {
        name: "Auth sweep project",
      });
      if (created.status !== 201)
        throw new Error(`project seed failed: ${created.status} ${created.text}`);
      const project = created.json<{ data: { id: string } }>().data.id;
      const secret = await context.client.mutate("POST", "/v1/secrets", {
        name: "sweep-auth-token",
        value: "sweep-auth-secret-value-0001",
        allowedOrigins: [origin],
      });
      if (secret.status !== 201 && secret.status !== 200)
        throw new Error(`auth secret seed failed: ${secret.status} ${secret.text}`);
      const secretId = secret.json<{ data: { id: string } }>().data.id;
      const profile = await context.client.mutate("POST", "/v1/auth-profiles", {
        projectId: project,
        name: "Sweep bearer",
        kind: "bearer",
        originBindings: [origin],
        secrets: { token: secretId },
        config: {},
      });
      if (profile.status !== 201)
        throw new Error(`auth profile seed failed: ${profile.status} ${profile.text}`);
      const id = profile.json<{ data: { id: string } }>().data.id;
      context.remember("authProfileId", id);
      return id;
    },
  },
};

export default seed;
