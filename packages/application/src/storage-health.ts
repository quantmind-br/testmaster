import { randomBytes } from "node:crypto";
import { ContractError } from "@testmaster/contracts";
import type { ObjectStore } from "@testmaster/evidence";

/** How long a probe result answers for every caller: readiness and admission poll often. */
const PROBE_TTL_MS = 5_000;

interface Probed {
  at: number;
  ok: boolean;
  pending?: Promise<boolean>;
}
const probes = new WeakMap<ObjectStore, Probed>();

/**
 * Whether the evidence bucket accepts a write right now (OPS-037). The probe writes and deletes a
 * private object, so it also notices a credential that lost write access; an absent key proves
 * nothing, because a read-only credential cannot tell absent from forbidden. A filesystem store is
 * covered by the volume checks and always answers true here.
 */
export async function objectStoreAvailable(store: ObjectStore): Promise<boolean> {
  if (store.kind !== "s3") return true;
  const known = probes.get(store);
  if (known?.pending) return known.pending;
  if (known && Date.now() - known.at < PROBE_TTL_MS) return known.ok;
  const entry: Probed = { at: Date.now(), ok: false };
  const pending = (async () => {
    const key = `readiness/${randomBytes(12).toString("hex")}`;
    try {
      await store.put(key, "probe", { ifNoneMatch: true });
      await store.delete(key);
      return true;
    } catch {
      return false;
    }
  })().then((ok) => {
    probes.set(store, { at: Date.now(), ok });
    return ok;
  });
  probes.set(store, { ...entry, pending });
  return pending;
}

/** New evidence cannot be published while the bucket is down, and there is no fallback (OPS-037). */
export async function assertObjectStoreAvailable(store: ObjectStore): Promise<void> {
  if (await objectStoreAvailable(store)) return;
  throw new ContractError(
    "UNAVAILABLE",
    "Evidence storage is unavailable; no Run can be admitted",
    {
      reasonCode: "storage_unavailable",
    },
  );
}
