import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistenceDatabase } from "@testmaster/persistence";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  CONTROLLER_LIVE_MS,
  liveControllers,
  newControllerIdentity,
  pruneControllerState,
  registerController,
  stopController,
} from "./controller-instances.js";
import {
  acquireLease,
  assertLease,
  LeaseLostError,
  readLease,
  releaseLease,
  renewLease,
} from "./controller-leases.js";
import {
  createPopKey,
  POP_WINDOW_MS,
  PopVerifier,
  parsePopAuthorization,
  popAuthorization,
  popPublicKey,
} from "./proof-of-possession.js";

let root: string;
/** Two connections to one database stand for two controller processes. */
let first: PersistenceDatabase;
let second: PersistenceDatabase;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tm-leases-"));
  first = await PersistenceDatabase.open(join(root, "shared.db"));
  second = await PersistenceDatabase.open(join(root, "shared.db"));
});
afterEach(async () => {
  first.close();
  second.close();
  await rm(root, { recursive: true, force: true });
});

const T0 = Date.parse("2026-06-01T10:00:00.000Z");

it("grants a lease to one holder at a time and lets the holder renew it", () => {
  expect(acquireLease(first, "scheduler", "ctl_a", 30_000, T0)).toEqual({ fence: 1 });
  expect(acquireLease(second, "scheduler", "ctl_b", 30_000, T0 + 1000)).toBeNull();
  // Asking again as the holder keeps the fence, so an in-flight tick is not fenced out by its own renewal.
  expect(acquireLease(first, "scheduler", "ctl_a", 30_000, T0 + 2000)).toEqual({ fence: 1 });
  expect(renewLease(first, "scheduler", "ctl_a", 1, 30_000, T0 + 3000)).toBe(true);
  expect(readLease(second, "scheduler")).toMatchObject({ holder: "ctl_a", fence: 1 });
  expect(renewLease(second, "scheduler", "ctl_b", 1, 30_000, T0 + 3000)).toBe(false);
});

it("lets a survivor take an expired lease with a higher fence and fences the old holder out", () => {
  acquireLease(first, "scheduler", "ctl_a", 30_000, T0);
  expect(acquireLease(second, "scheduler", "ctl_b", 30_000, T0 + 29_999)).toBeNull();
  expect(acquireLease(second, "scheduler", "ctl_b", 30_000, T0 + 30_001)).toEqual({ fence: 2 });
  expect(() => assertLease(first, "scheduler", "ctl_a", 1)).toThrow(LeaseLostError);
  expect(() => assertLease(second, "scheduler", "ctl_b", 2)).not.toThrow();
  // The deposed holder can neither renew nor reacquire while the new term is live.
  expect(renewLease(first, "scheduler", "ctl_a", 1, 30_000, T0 + 31_000)).toBe(false);
  expect(acquireLease(first, "scheduler", "ctl_a", 30_000, T0 + 31_000)).toBeNull();
});

it("hands a released lease over at once and never reuses a fence", () => {
  acquireLease(first, "alerts", "ctl_a", 30_000, T0);
  releaseLease(first, "alerts", "ctl_a", 1);
  expect(acquireLease(second, "alerts", "ctl_b", 30_000, T0 + 1)).toEqual({ fence: 2 });
  // A release by a holder that was already replaced changes nothing.
  releaseLease(first, "alerts", "ctl_a", 1);
  expect(readLease(first, "alerts")).toMatchObject({ holder: "ctl_b", fence: 2 });
});

it("keeps leases of different loops independent", () => {
  acquireLease(first, "alerts", "ctl_a", 30_000, T0);
  expect(acquireLease(second, "retention-purge", "ctl_b", 30_000, T0)).toEqual({ fence: 1 });
});

it("stopping a controller releases its leases and drops it from the live set", () => {
  const a = newControllerIdentity({ internalOrigin: "http://10.0.0.1:7000" });
  const b = newControllerIdentity({ internalOrigin: "http://10.0.0.2:7000" });
  registerController(first, a, T0);
  registerController(second, b, T0);
  acquireLease(first, "scheduler", a.id, 30_000, T0);
  expect(
    liveControllers(first, T0 + 1000)
      .map((controller) => controller.id)
      .sort(),
  ).toEqual([a.id, b.id].sort());
  stopController(first, a.id, T0 + 2000);
  expect(liveControllers(second, T0 + 3000).map((controller) => controller.id)).toEqual([b.id]);
  expect(acquireLease(second, "scheduler", b.id, 30_000, T0 + 3000)).toEqual({ fence: 2 });
});

it("treats a controller whose heartbeat is older than the live window as gone", () => {
  const a = newControllerIdentity();
  registerController(first, a, T0);
  expect(liveControllers(first, T0 + CONTROLLER_LIVE_MS - 1)).toHaveLength(1);
  expect(liveControllers(first, T0 + CONTROLLER_LIVE_MS + 1)).toHaveLength(0);
});

it("prunes expired nonces but keeps live ones", () => {
  first.run(
    "INSERT INTO worker_proof_nonces(key,expires_at) VALUES('old',?),('fresh',?)",
    new Date(T0 - 1000).toISOString(),
    new Date(T0 + 1000).toISOString(),
  );
  pruneControllerState(first, T0);
  expect(first.all("SELECT key FROM worker_proof_nonces").map((row) => row.key)).toEqual(["fresh"]);
});

it("refuses a proof replayed to another controller that shares the database", () => {
  const key = createPopKey();
  const header = popAuthorization(key, "wrk_key", "POST", "/v1/worker/heartbeat", T0);
  const proof = parsePopAuthorization(header);
  if (!proof) throw new Error("proof did not parse");
  const request = { method: "POST", path: "/v1/worker/heartbeat" };
  const publicKey = popPublicKey(key);
  const onFirst = new PopVerifier(first, () => T0);
  const onSecond = new PopVerifier(second, () => T0 + 1000);
  expect(onFirst.verify(proof, request, publicKey)).toBe(true);
  expect(onSecond.verify(proof, request, publicKey)).toBe(false);
  expect(onFirst.verify(proof, request, publicKey)).toBe(false);
  // A different request signed with the same key still passes: the nonce is per proof.
  const other = parsePopAuthorization(
    popAuthorization(key, "wrk_key", "POST", "/v1/worker/heartbeat", T0),
  );
  if (!other) throw new Error("proof did not parse");
  expect(onSecond.verify(other, request, publicKey)).toBe(true);
});

it("does not spend a nonce on a bad signature or a stale proof", () => {
  const key = createPopKey();
  const stranger = createPopKey();
  const proof = parsePopAuthorization(popAuthorization(key, "wrk_key", "GET", "/v1/x", T0));
  if (!proof) throw new Error("proof did not parse");
  const request = { method: "GET", path: "/v1/x" };
  const verifier = new PopVerifier(first, () => T0);
  expect(verifier.verify(proof, request, popPublicKey(stranger))).toBe(false);
  expect(first.all("SELECT key FROM worker_proof_nonces")).toEqual([]);
  expect(
    new PopVerifier(first, () => T0 + POP_WINDOW_MS + 1).verify(proof, request, popPublicKey(key)),
  ).toBe(false);
  expect(first.all("SELECT key FROM worker_proof_nonces")).toEqual([]);
  expect(verifier.verify(proof, request, popPublicKey(key))).toBe(true);
});
