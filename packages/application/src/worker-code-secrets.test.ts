import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeReference } from "@testmaster/contracts";
import { afterEach, expect, it } from "vitest";
import { Application } from "./application.js";
import { codeSecretBindings } from "./attempt-session.js";
import { authBlockReasons } from "./auth/index.js";

const roots: string[] = [];
const apps: Application[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function open() {
  const root = await mkdtemp(join(tmpdir(), "tm-worker-code-secrets-"));
  roots.push(root);
  const app = await Application.open({ cwd: root, home: join(root, "home"), env: {} });
  apps.push(app);
  await app.init();
  return app;
}
const codeRef = (secretRefs?: CodeReference["secretRefs"]) =>
  ({ trustLevel: "imported", ...(secretRefs ? { secretRefs } : {}) }) as CodeReference;

it("derives the declared code secrets for the snapshot, origin check and release", async () => {
  const app = await open();
  const api = await app.secrets.set("API_KEY", "v", { ephemeral: true });
  const bindings = [{ name: "API_KEY", secretRef: api.id }];
  expect(codeSecretBindings(codeRef(bindings), app.secrets)).toEqual(bindings);
  expect(codeSecretBindings(codeRef(), app.secrets)).toEqual([]);
  expect(codeSecretBindings(undefined, app.secrets)).toEqual([]);
});

it("blocks a code test whose declared secret no longer exists as missing_secret before any child starts", async () => {
  const app = await open();
  const api = await app.secrets.set("API_KEY", "v", { ephemeral: true });
  const bindings = [
    { name: "API_KEY", secretRef: api.id },
    { name: "GONE", secretRef: "sec_00000000-0000-7000-8000-000000000000" },
  ];
  let failure: unknown;
  try {
    codeSecretBindings(codeRef(bindings), app.secrets);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    code: "PRECONDITION_FAILED",
    message: 'Secret "GONE" used by this code test does not exist',
    details: { reasonCode: "missing_secret", secretName: "GONE" },
  });
  // The worker maps this reason to a blocked Run, never to failed/assertion_mismatch.
  expect(authBlockReasons.has("missing_secret")).toBe(true);
});
