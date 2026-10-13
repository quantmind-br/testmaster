import type * as ChildProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { type AuthLab, defaults, httpFormConfig, openLab } from "../../test/auth-lab.js";
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
async function otpLab(otp: Record<string, unknown> = {}, withSeed = true) {
  const current = await openLab();
  labs.push(current);
  current.site.control.requireOtp = true;
  const username = await current.secret("otp-user", defaults.username);
  const password = await current.secret("otp-pass", defaults.password);
  const totpSeed = await current.secret("otp-seed", defaults.totpSeed);
  const profile = await current.profile({
    name: "otp",
    kind: "form",
    config: {
      ...httpFormConfig(current.site, {
        fields: { username: "username", password: "password", otp: "otp" },
      }),
      otp,
    },
    secrets: { username, password, ...(withSeed ? { totpSeed } : {}) },
  });
  const env = current.environment("otp-env", [profile.id]);
  const load = () => current.app.authProfiles.profile(profile.id) as StoredAuthProfile;
  const ensure = () =>
    current.app.authProfiles.engine.ensure(
      load(),
      current.app.authProfiles.environment(env.id).environment,
      { interactive: false, explicit: true },
    );
  return { current, profile, env, ensure, seed: defaults.totpSeed };
}

it("REQ-018 SEC-024 generates the one-time password from the vault seed next to its use and never exposes the seed", async () => {
  const { current, profile, env } = await otpLab();
  const receipt = await current.app.authProfiles.testLogin(profile.id, env.id);
  expect(receipt).toMatchObject({ outcome: "authenticated", credentialRoles: ["session"] });
  const login = current.site.requests.find((request) => request.path === "/api/login");
  const sentCode = String(JSON.parse(login?.body ?? "{}").otp);
  expect(sentCode).toMatch(/^\d{6}$/u);
  expect(current.site.totpNow()).toBeDefined();
  const view = JSON.stringify([receipt, current.app.authProfiles.get(profile.id)]);
  expect(view).not.toContain(defaults.totpSeed);
  expect(view).not.toContain(sentCode);
  const audit = JSON.stringify(current.app.database.all("SELECT * FROM audit_events"));
  expect(audit).not.toContain(defaults.totpSeed);
  expect(audit).not.toContain(sentCode);
  // Negative control: the target really requires the code (a login without it is refused).
  const withoutCode = await fetch(`${current.site.url}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: defaults.username, password: defaults.password }),
  });
  expect(withoutCode.status).toBe(401);
});

it("SEC-024 diagnoses a skewed clock instead of trying neighbouring codes", async () => {
  const { current, ensure } = await otpLab();
  current.site.control.clockOffsetSeconds = 120;
  current.site.control.otpWindow = 0;
  await expect(ensure()).rejects.toMatchObject({
    details: { reasonCode: "manual_auth_required", authFailure: "clock_skew" },
  });
  expect(current.site.counters.loginFailures).toBe(1);
  expect(current.site.requests.filter((request) => request.path === "/api/login")).toHaveLength(1);
  // Positive control: with the clocks aligned the same profile signs in.
  current.site.control.clockOffsetSeconds = 0;
  await expect(ensure()).resolves.toMatchObject({ roles: ["session"] });
});

it("M4-03 SEC-024 an expired code is rejected once, counted, and the profile locks instead of brute forcing", async () => {
  const { current, profile, ensure } = await otpLab({ maxFailures: 2, windowSeconds: 600 });
  // The target's code window is one step behind ours but its clock looks right, so it is not skew.
  current.site.control.otpWindow = 0;
  current.site.control.failToken = false;
  current.site.control.clockOffsetSeconds = 30; // exactly one step: wrong code, drift still within tolerance
  await expect(ensure()).rejects.toMatchObject({
    details: { authFailure: "otp_rejected" },
  });
  await expect(ensure()).rejects.toMatchObject({
    details: { authFailure: "otp_rejected" },
  });
  const failures = current.site.counters.loginFailures;
  expect(failures).toBe(2);
  expect(current.app.authProfiles.get(profile.id).session).toMatchObject({ state: "locked" });
  expect(current.app.authProfiles.get(profile.id).session.otpLockedUntil).toBeTruthy();
  // Locked: further attempts never reach the target, even with a correct clock.
  current.site.control.clockOffsetSeconds = 0;
  await expect(ensure()).rejects.toMatchObject({ details: { authFailure: "otp_locked" } });
  expect(current.site.counters.loginFailures).toBe(failures);
  expect(current.site.requests.filter((request) => request.path === "/api/login")).toHaveLength(2);
});

it("SEC-024 without a seed or a human supplied code no login is attempted", async () => {
  const { current, ensure } = await otpLab({}, false);
  await expect(ensure()).rejects.toMatchObject({
    details: { reasonCode: "manual_auth_required", authFailure: "otp_unavailable" },
  });
  expect(current.site.requests.filter((request) => request.path === "/api/login")).toHaveLength(0);
});

it("SEC-024 a human-supplied one-time code is used once and then discarded", async () => {
  const { current, profile, env } = await otpLab({}, false);
  const code = current.site.totpNow();
  await current.app.secrets.writeManaged(profile.managedSecrets.otp as string, code);
  const receipt = await current.app.authProfiles.testLogin(profile.id, env.id);
  expect(receipt.outcome).toBe("authenticated");
  const sent = current.site.requests.filter((request) => request.path === "/api/login");
  expect(JSON.parse(sent[0]?.body ?? "{}").otp).toBe(code);
  expect(current.app.secrets.get(profile.managedSecrets.otp as string).provider).toBe("managed");
  // The code is gone, so a second login is refused locally instead of replaying it.
  const again = await current.app.authProfiles.testLogin(profile.id, env.id);
  expect(again).toMatchObject({ outcome: "failed" });
  expect(again.detail).toContain("otp_unavailable");
  expect(current.site.requests.filter((request) => request.path === "/api/login")).toHaveLength(1);
});
