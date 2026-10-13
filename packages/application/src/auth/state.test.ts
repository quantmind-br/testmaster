import type * as ChildProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { type AuthLab, openLab } from "../../test/auth-lab.js";
import { AuthProfilesService } from "./profiles.js";
import type { StoredAuthProfile } from "./types.js";

// Hermetic: the encrypted file vault, never the host keyring.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: vi.fn(() => {
    throw Object.assign(new Error("Unavailable"), { code: "ENOENT" });
  }),
}));
const labs: AuthLab[] = [];
afterEach(async () => {
  for (const lab of labs.splice(0)) await lab.close();
});

const startedAt = Date.parse("2026-10-14T12:00:00Z");
/** A profile service whose clock the test drives, over the same database and vault as the app. */
async function stateLab() {
  const current = await openLab();
  labs.push(current);
  let now = startedAt;
  const stepUps: string[] = [];
  const service = new AuthProfilesService(current.app.context, {
    secrets: current.app.secrets,
    clock: () => now,
    stepUp: async (password, operation) => {
      if (password !== "step-up-password") throw new Error("Invalid credentials");
      stepUps.push(operation);
    },
  });
  const profile = await current.profile({
    name: "manual-state",
    kind: "manual",
    config: { challenge: { kind: "captcha", resolution: "storage-state" } },
    secrets: {},
  });
  const env = current.environment("state-env", [profile.id]);
  const environment = service.environment(env.id).environment;
  const state = (cookie = "tm-secret-cookie-value", domain = "127.0.0.1") =>
    JSON.stringify({
      cookies: [
        {
          name: "session",
          value: cookie,
          domain,
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    });
  const supply = async (text: string, name = `state-${Math.random()}`) =>
    await current.secret(name, text);
  const load = () => service.profile(profile.id) as StoredAuthProfile;
  return {
    current,
    service,
    profile,
    environment,
    load,
    state,
    supply,
    stepUps,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    now: () => now,
  };
}

it("SEC-022 imports a storage state encrypted at rest as a managed secret with an explicit TTL", async () => {
  const lab = await stateLab();
  const inputRef = await lab.supply(lab.state());
  const view = await lab.service.importState(lab.profile.id, { inputRef, ttlSeconds: 600 });
  const credential = view.session.credentials.find((entry) => entry.role === "storageState");
  expect(credential?.expiresAt).toBe(new Date(lab.now() + 600_000).toISOString());
  expect(view.session.state).toBe("authenticated");
  // The vault holds it, the view never does, and the human-supplied input is consumed.
  expect(JSON.stringify(view)).not.toContain("tm-secret-cookie-value");
  const stateSecret = lab.current.app.secrets.get(
    lab.profile.managedSecrets.storageState as string,
  );
  expect(stateSecret.provider).not.toBe("managed");
  expect(stateSecret.managedBy).toBe(lab.profile.id);
  expect(lab.current.app.secrets.get(inputRef).revokedAt).toBeTruthy();
  // The Attempt receives the state by secret reference, never inline.
  const prepared = await lab.service.prepare({
    run: { id: "run_x", origin: "cli", requestedBy: "usr_x" },
    attemptId: "att_x",
    environment: lab.environment,
    signal: new AbortController().signal,
    deadlineAt: lab.now() + 60_000,
    interactive: false,
  });
  expect(prepared.runnerAuth).toEqual({ storageState: { secretRef: stateSecret.id } });
  expect(prepared.secretIds).toContain(stateSecret.id);
  expect(JSON.stringify(prepared)).not.toContain("tm-secret-cookie-value");
});

it("SEC-022 refuses storage states that are malformed, oversized or bound to another origin", async () => {
  const lab = await stateLab();
  const refuse = async (text: string, message: RegExp) =>
    await expect(
      lab.service.importState(lab.profile.id, { inputRef: await lab.supply(text) }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", message: expect.stringMatching(message) });
  await refuse("not json", /not valid JSON/u);
  await refuse(JSON.stringify({ cookies: [] }), /cookies and origins/u);
  await refuse(lab.state("v", "evil.example"), /outside the bound origins/u);
  await refuse(
    JSON.stringify({
      cookies: [],
      origins: [{ origin: "https://evil.example", localStorage: [] }],
    }),
    /origin outside the bound origins/u,
  );
  // A captured state beyond the vault's secret limit is refused before it is stored.
  expect(() =>
    lab.service.validateStorageState(
      lab.load(),
      JSON.stringify({ cookies: [], origins: [], pad: "x".repeat(70_000) }),
    ),
  ).toThrow(/size limit/u);
  expect(lab.service.get(lab.profile.id).session.credentials).toEqual([]);
  // Positive control: the same shape bound to the profile's origin is accepted.
  await expect(
    lab.service.importState(lab.profile.id, { inputRef: await lab.supply(lab.state()) }),
  ).resolves.toMatchObject({ session: { state: "authenticated" } });
});

it("SEC-022 an expired storage state is never reused and asks for re-authentication instead of looping", async () => {
  const lab = await stateLab();
  await lab.service.importState(lab.profile.id, {
    inputRef: await lab.supply(lab.state()),
    ttlSeconds: 600,
  });
  const ensure = () =>
    lab.service.engine.ensure(lab.load(), lab.environment, { interactive: false });
  await expect(ensure()).resolves.toMatchObject({ roles: ["storageState"] });
  lab.advance(541_000); // inside the 60 s refresh skew of the expiry
  await expect(ensure()).rejects.toMatchObject({
    details: {
      reasonCode: "manual_auth_required",
      authFailure: "state_expired",
      checkpointRequired: true,
      kind: "captcha",
    },
  });
  lab.advance(3_600_000);
  await expect(ensure()).rejects.toMatchObject({ details: { authFailure: "state_expired" } });
  // A fresh human-supplied state re-arms the profile.
  await lab.service.importState(lab.profile.id, {
    inputRef: await lab.supply(lab.state("second-cookie")),
    ttlSeconds: 600,
  });
  await expect(ensure()).resolves.toMatchObject({ roles: ["storageState"] });
});

it("SEC-022 exporting a storage state needs the step-up password, is audited, and caps the state's own lifetime", async () => {
  const lab = await stateLab();
  await lab.service.importState(lab.profile.id, {
    inputRef: await lab.supply(lab.state("exported-cookie")),
    ttlSeconds: 3600,
  });
  // The in-process local CLI has no credential to re-enter; every other caller does.
  const remote = new AuthProfilesService(
    {
      ...lab.current.app.context,
      actor: { principalId: "usr_remote", credentialKind: "api", credentialId: "tok" },
    },
    {
      secrets: lab.current.app.secrets,
      clock: () => lab.now(),
      stepUp: async (password) => {
        if (password !== "step-up-password") throw new Error("Invalid credentials");
      },
    },
  );
  await expect(remote.exportState(lab.profile.id, { password: "wrong" })).rejects.toThrow(
    /Invalid credentials/u,
  );
  const exported = await remote.exportState(lab.profile.id, {
    password: "step-up-password",
    ttlSeconds: 120,
  });
  expect(exported.storageState).toContain("exported-cookie");
  expect(exported.exportExpiresAt).toBe(new Date(lab.now() + 120_000).toISOString());
  expect(exported.expiresAt).toBe(new Date(lab.now() + 3_600_000).toISOString());
  // The stored state now expires with the export, so a leaked copy has a short life.
  const after = lab.service
    .get(lab.profile.id)
    .session.credentials.find((entry) => entry.role === "storageState");
  expect(after?.expiresAt).toBe(exported.exportExpiresAt);
  const audit = JSON.stringify(
    lab.current.app.database.all("SELECT action,resource_id FROM audit_events"),
  );
  expect(audit).toContain("auth.export_state");
  expect(audit).not.toContain("exported-cookie");
  lab.advance(121_000);
  await expect(
    remote.exportState(lab.profile.id, { password: "step-up-password" }),
  ).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
});

it("SEC-022 revoking a session deletes the stored storage state", async () => {
  const lab = await stateLab();
  await lab.service.importState(lab.profile.id, { inputRef: await lab.supply(lab.state()) });
  const secretId = lab.profile.managedSecrets.storageState as string;
  expect(lab.current.app.secrets.get(secretId).provider).not.toBe("managed");
  const revoked = await lab.service.revokeSession(lab.profile.id);
  expect(revoked.session).toMatchObject({ state: "revoked", credentials: [] });
  expect(lab.current.app.secrets.get(secretId).revokedAt).toBeTruthy();
  await expect(lab.service.exportState(lab.profile.id, { password: "x" })).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
});
