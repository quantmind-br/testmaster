import { randomBytes } from "node:crypto";
import { access, constants, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectStore } from "@testmaster/evidence";
import type { PersistenceDatabase } from "@testmaster/persistence";
import { masterKeyReadable, serverVaultLayout, vaultHealth } from "./secrets.js";
import { localDataDir, type ServerConfig } from "./server-config.js";
import { evidenceVolume } from "./storage-admission.js";
import { objectStoreAvailable } from "./storage-health.js";

/** A worker that has not heartbeated for this long no longer counts as present. */
export const workerPresenceWindowMs = 30_000;
/** Below this fraction of free space on the evidence volume the server stops reporting ready. */
export const storageWatermark = 0.1;

export type ProbeState = "ready" | "unavailable";
export interface ServerReadiness {
  status: ProbeState;
  components: {
    persistence: ProbeState;
    admission: ProbeState;
    schema: ProbeState;
    tenantIsolation: ProbeState;
    storage: ProbeState;
    masterKey: ProbeState;
  };
  /** Stable reason codes of every failing component, empty when ready. */
  reasons: string[];
  schema: {
    databaseVersion: number;
    supportedVersion: number;
    state: "current" | "behind" | "ahead";
  };
  /** TestMaster does not verify volume encryption; the operator attested it (ADR-019). */
  atRestEncryption: "operator_attested";
  worker: { status: "ready" | "degraded"; ready: number };
}

interface Probe {
  state: ProbeState;
  reason?: string;
}
const ok: Probe = { state: "ready" };
const failed = (reason: string): Probe => ({ state: "unavailable", reason });

function persistence(database: PersistenceDatabase): Probe {
  try {
    database.withTx(() =>
      database.run(
        "INSERT INTO operational_state(key,value) VALUES('readiness:probe',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        new Date().toISOString(),
      ),
    );
    return ok;
  } catch {
    return failed("database_unreachable");
  }
}
function admission(database: PersistenceDatabase): Probe {
  try {
    const row = database.get("SELECT value FROM operational_state WHERE key='admission'");
    return row?.value === "enabled" && database.get("SELECT id FROM workspaces LIMIT 1")
      ? ok
      : failed("admission_disabled");
  } catch {
    return failed("database_unreachable");
  }
}
async function storage(
  server: ServerConfig,
  objectStore: ObjectStore,
  database: PersistenceDatabase,
): Promise<Probe> {
  // The local directory is the evidence root, or the staging root of the S3 profile.
  const root = localDataDir(server.storage);
  const probe = join(root, `.readiness-${randomBytes(8).toString("hex")}`);
  try {
    await access(root, constants.W_OK);
    await writeFile(probe, "probe", { mode: 0o600, flag: "wx" });
  } catch {
    return failed("storage_unwritable");
  } finally {
    await rm(probe, { force: true });
  }
  // OPS-037: an unreachable bucket blocks publication; nothing falls back to the filesystem.
  if (!(await objectStoreAvailable(objectStore))) return failed("storage_unavailable");
  try {
    const capacity = server.storage.kind === "s3" ? server.storage.capacityBytes : undefined;
    const volume = await evidenceVolume(
      { dataDir: root, ...(capacity === undefined ? {} : { evidenceCapacityBytes: capacity }) },
      database,
    );
    if (1 - volume.usedFraction < storageWatermark) return failed("storage_low_space");
  } catch {
    return failed("storage_unwritable");
  }
  return ok;
}

/**
 * Readiness of the server profile (ADR-015, ADR-016, ADR-019). The API container has no Docker
 * daemon, so runner probing belongs to the worker hosts; this reports what the server owns:
 * database reachability and schema, the tenant-isolation role check, the evidence volume, the
 * master key and the presence of workers. `database` is workspace-scoped for a request and
 * unscoped for the operator CLI, which therefore sees every workspace's workers.
 */
export async function serverReadiness(input: {
  database: PersistenceDatabase;
  server: ServerConfig;
  objectStore: ObjectStore;
}): Promise<ServerReadiness> {
  const { database, server, objectStore } = input;
  const reachable = persistence(database);
  let schema: ServerReadiness["schema"] = {
    databaseVersion: 0,
    supportedVersion: 0,
    state: "current",
  };
  let schemaProbe: Probe = reachable;
  let isolation: Probe = reachable;
  let ready = 0;
  if (reachable.state === "ready") {
    try {
      schema = database.schemaCompatibility();
      schemaProbe = schema.state === "current" ? ok : failed(`schema_${schema.state}`);
      const tenancy = database.tenantIsolation();
      isolation = tenancy.roleBypassesRls
        ? failed("rls_role_bypass")
        : tenancy.unprotectedTables.length
          ? failed("rls_unprotected_tables")
          : ok;
      ready = Number(
        database.get(
          "SELECT COUNT(*) AS n FROM workers WHERE state='ready' AND last_heartbeat_at>?",
          new Date(Date.now() - workerPresenceWindowMs).toISOString(),
        )?.n ?? 0,
      );
    } catch {
      schemaProbe = isolation = failed("database_unreachable");
    }
  }
  const admissionProbe = reachable.state === "ready" ? admission(database) : reachable;
  const storageProbe = await storage(server, objectStore, database);
  const layout = serverVaultLayout(server, { store: objectStore, database });
  // With the bucket down the vault cannot round-trip a canary; the key file alone says whether the
  // key is the problem, so the outage is reported once, as storage.
  const key = (
    storageProbe.reason === "storage_unavailable"
      ? await masterKeyReadable(layout)
      : (await vaultHealth(layout).catch(() => null))?.writable
  )
    ? ok
    : failed("master_key_unavailable");
  const probes = {
    persistence: reachable,
    admission: admissionProbe,
    schema: schemaProbe,
    tenantIsolation: isolation,
    storage: storageProbe,
    masterKey: key,
  };
  const components = Object.fromEntries(
    Object.entries(probes).map(([name, probe]) => [name, probe.state]),
  ) as ServerReadiness["components"];
  const reasons = Object.values(probes).flatMap((probe) => (probe.reason ? [probe.reason] : []));
  return {
    status: reasons.length === 0 ? "ready" : "unavailable",
    components,
    reasons: [...new Set(reasons)],
    schema,
    atRestEncryption: "operator_attested",
    worker: { status: ready > 0 ? "ready" : "degraded", ready },
  };
}
