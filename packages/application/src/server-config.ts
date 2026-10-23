import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { ContractError, parseStrictJson } from "@testmaster/contracts";
import type { PostgresConfig } from "@testmaster/persistence";
import type { S3LocationConfig } from "./storage-config.js";

/**
 * Evidence bucket of the server and distributed profiles. `stagingRoot` is the local scratch of one
 * process (staging, uploads, temp): never shared between controllers. `capacityBytes` is the
 * operator's quota of the bucket; storage pressure is measured against it.
 */
export type S3StorageConfig = { kind: "s3" } & S3LocationConfig & {
    capacityBytes: number;
    stagingRoot: string;
  };
export type StorageConfig = { kind: "filesystem"; root: string } | S3StorageConfig;
/** A backup bucket: another bucket and another credential than the evidence bucket (OPS-026). */
export type S3BackupDestination = { kind: "s3" } & S3LocationConfig;

/** Deployment configuration of the multi-user server and distributed profiles (ADR-015, ADR-016, ADR-019). */
export interface ServerConfig {
  mode: "server" | "distributed";
  database: { engine: "postgres" } & PostgresConfig;
  storage: StorageConfig;
  server: {
    listen: { host: string; port: number };
    publicOrigin: string;
    trustedProxies: string[];
    origins: string[];
    /** Origin other controllers reach this one at (distributed only). */
    internalOrigin?: string;
    /** Controllers the operator expects to be live (distributed only). */
    expectedControllers?: number;
  };
  security: {
    masterKeyFile: string;
    backupKeyFile: string;
    atRestEncryption: { database: "operator-volume"; evidence: "operator-volume" };
  };
  telemetry?: { metrics: boolean; logExport: "none" | "stdout-json" };
  /**
   * Operator backups (ADR-019). `destination` may be an off-host mount; `pgDump`/`pgRestore` are argv
   * prefixes for the PostgreSQL client tools (for example a docker wrapper). The backup agent is a
   * separate process: the server refuses to start when it can read the backup key or write the
   * destination unless `allowSharedAccess` says the operator accepts one shared identity.
   */
  backup?: {
    destination: string | S3BackupDestination;
    pgDump?: string[];
    pgRestore?: string[];
    schedule?: "daily" | "disabled";
    retention?: { daily: number; weekly: number; monthly: number };
    allowSharedAccess?: boolean;
  };
}
type Json = Record<string, unknown>;
const problems = (list: string[]): never => {
  throw new ContractError("INVALID_ARGUMENT", "Server configuration is invalid", {
    issues: list,
  });
};
const object = (value: unknown, path: string, issues: string[]): Json => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
  issues.push(`${path} must be an object`);
  return {};
};
const text = (value: unknown, path: string, issues: string[]): string => {
  if (typeof value === "string" && value.length > 0 && value.length <= 4096) return value;
  issues.push(`${path} must be a non-empty string`);
  return "";
};
const optionalText = (value: unknown, path: string, issues: string[]): string | undefined =>
  value === undefined ? undefined : text(value, path, issues);
const absolute = (value: unknown, path: string, issues: string[]): string => {
  const path_ = text(value, path, issues);
  if (path_ && !isAbsolute(path_)) issues.push(`${path} must be an absolute path`);
  return path_;
};
const list = (value: unknown, path: string, issues: string[]): string[] => {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  issues.push(`${path} must be an array of strings`);
  return [];
};
const known = (value: Json, allowed: readonly string[], path: string, issues: string[]): void => {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) issues.push(`${path}.${key} is not a recognized setting`);
};
/** An IP address or an IPv4/IPv6 CIDR range. */
function validAddressRange(value: string): boolean {
  const [address, prefix, ...rest] = value.split("/");
  const family = isIP(address ?? "");
  if (!family || rest.length) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}
function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.origin === value &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
/** The local scratch directory of one process: the evidence root, or the S3 profile's staging root. */
export function localDataDir(storage: StorageConfig): string {
  return storage.kind === "s3" ? storage.stagingRoot : storage.root;
}
const bucketName = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const locationKeys = [
  "kind",
  "endpoint",
  "region",
  "bucket",
  "prefix",
  "forcePathStyle",
  "accessKeyIdFile",
  "secretAccessKeyFile",
  "caFile",
] as const;
/** The bucket, endpoint and credential files shared by the evidence and the backup location. */
function parseS3Location(
  value: Json,
  path: string,
  extra: readonly string[],
  issues: string[],
): S3LocationConfig {
  known(value, [...locationKeys, ...extra], path, issues);
  const endpoint = text(value.endpoint, `${path}.endpoint`, issues);
  if (endpoint && !validOrigin(endpoint))
    issues.push(`${path}.endpoint must be a bare http or https origin`);
  const region = text(value.region, `${path}.region`, issues);
  const bucket = text(value.bucket, `${path}.bucket`, issues);
  if (bucket && !bucketName.test(bucket))
    issues.push(`${path}.bucket must be a valid bucket name (3-63 lowercase letters, digits, . -)`);
  const prefix = optionalText(value.prefix, `${path}.prefix`, issues);
  if (
    prefix &&
    (prefix.startsWith("/") ||
      prefix.endsWith("/") ||
      prefix.split("/").some((part) => part === ".." || part === "." || part === ""))
  )
    issues.push(`${path}.prefix must be a relative key prefix without empty or dot segments`);
  if (typeof value.forcePathStyle !== "boolean")
    issues.push(`${path}.forcePathStyle must be a boolean`);
  const accessKeyIdFile = absolute(value.accessKeyIdFile, `${path}.accessKeyIdFile`, issues);
  const secretAccessKeyFile = absolute(
    value.secretAccessKeyFile,
    `${path}.secretAccessKeyFile`,
    issues,
  );
  const caFile =
    value.caFile === undefined ? undefined : absolute(value.caFile, `${path}.caFile`, issues);
  return {
    endpoint,
    region,
    bucket,
    ...(prefix ? { prefix } : {}),
    forcePathStyle: value.forcePathStyle === true,
    accessKeyIdFile,
    secretAccessKeyFile,
    ...(caFile ? { caFile } : {}),
  };
}
const policyDenied = (message: string, reasonCode: string): never => {
  throw new ContractError("POLICY_DENIED", message, { reasonCode });
};
function backupSharesIdentity(storage: S3LocationConfig, destination: S3LocationConfig): boolean {
  const origin = (location: S3LocationConfig): string => new URL(location.endpoint).origin;
  return (
    (origin(storage) === origin(destination) && storage.bucket === destination.bucket) ||
    storage.accessKeyIdFile === destination.accessKeyIdFile ||
    storage.secretAccessKeyFile === destination.secretAccessKeyFile
  );
}
/** Validates an already parsed document; every problem is reported at once. */
export function parseServerConfig(input: unknown): ServerConfig {
  const issues: string[] = [];
  const root = object(input, "$", issues);
  known(
    root,
    ["mode", "database", "storage", "server", "security", "telemetry", "backup"],
    "$",
    issues,
  );
  if (root.mode !== "server" && root.mode !== "distributed")
    issues.push('$.mode must be "server" or "distributed"');
  const mode = root.mode === "distributed" ? "distributed" : "server";
  const db = object(root.database, "$.database", issues);
  known(db, ["engine", "url", "passwordFile", "caFile", "applicationName"], "$.database", issues);
  // OPS-001: the distributed profile is PostgreSQL only; the refusal names the policy, not the typo.
  if (mode === "distributed" && db.engine !== "postgres")
    policyDenied(
      "The distributed profile needs PostgreSQL; SQLite cannot be shared between controllers",
      "distributed_requires_postgres",
    );
  if (db.engine !== "postgres") issues.push('$.database.engine must be "postgres"');
  const url = text(db.url, "$.database.url", issues);
  try {
    const parsed = new URL(url);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol))
      issues.push("$.database.url must use the postgres scheme");
    if (parsed.password)
      issues.push("$.database.url must not contain a password; use passwordFile");
  } catch {
    if (url) issues.push("$.database.url is not a valid URL");
  }
  const passwordFile = optionalText(db.passwordFile, "$.database.passwordFile", issues);
  const caFile = optionalText(db.caFile, "$.database.caFile", issues);
  const applicationName = optionalText(db.applicationName, "$.database.applicationName", issues);
  const storage = object(root.storage, "$.storage", issues);
  if (mode === "distributed" && storage.kind === "filesystem")
    policyDenied(
      "The distributed profile needs shared S3-compatible storage; a filesystem root is not shared between controllers",
      "distributed_requires_shared_storage",
    );
  let storageConfig: StorageConfig = { kind: "filesystem", root: "" };
  if (storage.kind === "s3") {
    const location = parseS3Location(
      storage,
      "$.storage",
      ["capacityBytes", "stagingRoot"],
      issues,
    );
    const capacityBytes = storage.capacityBytes;
    if (
      typeof capacityBytes !== "number" ||
      !Number.isSafeInteger(capacityBytes) ||
      capacityBytes < 1
    )
      issues.push("$.storage.capacityBytes must be a positive integer number of bytes");
    const stagingRoot = absolute(storage.stagingRoot, "$.storage.stagingRoot", issues);
    storageConfig = {
      kind: "s3",
      ...location,
      capacityBytes: Number(capacityBytes),
      stagingRoot,
    };
  } else {
    known(storage, ["kind", "root"], "$.storage", issues);
    if (storage.kind !== "filesystem") issues.push('$.storage.kind must be "filesystem" or "s3"');
    storageConfig = { kind: "filesystem", root: absolute(storage.root, "$.storage.root", issues) };
  }
  const server = object(root.server, "$.server", issues);
  known(
    server,
    [
      "listen",
      "publicOrigin",
      "trustedProxies",
      "origins",
      "internalOrigin",
      "expectedControllers",
    ],
    "$.server",
    issues,
  );
  const listen = object(server.listen, "$.server.listen", issues);
  known(listen, ["host", "port"], "$.server.listen", issues);
  const host = text(listen.host, "$.server.listen.host", issues);
  if (host && !isIP(host) && !/^[A-Za-z0-9.-]+$/.test(host))
    issues.push("$.server.listen.host must be an address or host name");
  const port = listen.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)
    issues.push("$.server.listen.port must be an integer from 0 to 65535");
  const publicOrigin = text(server.publicOrigin, "$.server.publicOrigin", issues);
  if (publicOrigin && !publicOrigin.startsWith("https://"))
    issues.push("$.server.publicOrigin must be an https origin");
  if (publicOrigin && !validOrigin(publicOrigin))
    issues.push("$.server.publicOrigin must be a bare origin without path or credentials");
  const trustedProxies = list(server.trustedProxies, "$.server.trustedProxies", issues);
  for (const proxy of trustedProxies)
    if (!validAddressRange(proxy))
      issues.push(`$.server.trustedProxies entry ${JSON.stringify(proxy)} is not an IP or CIDR`);
  const origins = list(server.origins, "$.server.origins", issues);
  for (const origin of origins)
    if (!validOrigin(origin))
      issues.push(`$.server.origins entry ${JSON.stringify(origin)} is not a bare origin`);
  const internalOrigin = optionalText(server.internalOrigin, "$.server.internalOrigin", issues);
  if (mode === "distributed" && internalOrigin === undefined)
    issues.push("$.server.internalOrigin is required in the distributed profile");
  if (mode === "server" && internalOrigin !== undefined)
    issues.push("$.server.internalOrigin is only valid in the distributed profile");
  if (internalOrigin && !validOrigin(internalOrigin))
    issues.push("$.server.internalOrigin must be a bare http or https origin");
  const expected = server.expectedControllers;
  if (expected !== undefined) {
    if (mode !== "distributed")
      issues.push("$.server.expectedControllers is only valid in the distributed profile");
    if (
      typeof expected !== "number" ||
      !Number.isInteger(expected) ||
      expected < 1 ||
      expected > 1000
    )
      issues.push("$.server.expectedControllers must be an integer from 1 to 1000");
  }
  const security = object(root.security, "$.security", issues);
  known(security, ["masterKeyFile", "backupKeyFile", "atRestEncryption"], "$.security", issues);
  const masterKeyFile = absolute(security.masterKeyFile, "$.security.masterKeyFile", issues);
  const backupKeyFile = absolute(security.backupKeyFile, "$.security.backupKeyFile", issues);
  const attestation = object(security.atRestEncryption, "$.security.atRestEncryption", issues);
  known(attestation, ["database", "evidence"], "$.security.atRestEncryption", issues);
  if (attestation.database !== "operator-volume" || attestation.evidence !== "operator-volume")
    issues.push(
      '$.security.atRestEncryption must declare { "database": "operator-volume", "evidence": "operator-volume" }',
    );
  let telemetry: ServerConfig["telemetry"];
  if (root.telemetry !== undefined) {
    const value = object(root.telemetry, "$.telemetry", issues);
    known(value, ["metrics", "logExport"], "$.telemetry", issues);
    if (typeof value.metrics !== "boolean") issues.push("$.telemetry.metrics must be a boolean");
    if (value.logExport !== "none" && value.logExport !== "stdout-json")
      issues.push('$.telemetry.logExport must be "none" or "stdout-json"');
    telemetry = {
      metrics: value.metrics === true,
      logExport: value.logExport === "stdout-json" ? "stdout-json" : "none",
    };
  }
  let backup: ServerConfig["backup"];
  if (root.backup !== undefined) {
    const value = object(root.backup, "$.backup", issues);
    known(
      value,
      ["destination", "pgDump", "pgRestore", "schedule", "retention", "allowSharedAccess"],
      "$.backup",
      issues,
    );
    let destination: string | S3BackupDestination;
    if (value.destination && typeof value.destination === "object") {
      const found = object(value.destination, "$.backup.destination", issues);
      if (found.kind !== "s3") issues.push('$.backup.destination.kind must be "s3"');
      destination = {
        kind: "s3",
        ...parseS3Location(found, "$.backup.destination", [], issues),
      };
    } else destination = absolute(value.destination, "$.backup.destination", issues);
    const pgDump =
      value.pgDump === undefined ? undefined : list(value.pgDump, "$.backup.pgDump", issues);
    const pgRestore =
      value.pgRestore === undefined
        ? undefined
        : list(value.pgRestore, "$.backup.pgRestore", issues);
    if (pgDump?.length === 0) issues.push("$.backup.pgDump must not be empty");
    if (pgRestore?.length === 0) issues.push("$.backup.pgRestore must not be empty");
    if (value.schedule !== undefined && value.schedule !== "daily" && value.schedule !== "disabled")
      issues.push('$.backup.schedule must be "daily" or "disabled"');
    let retention: { daily: number; weekly: number; monthly: number } | undefined;
    if (value.retention !== undefined) {
      const found = object(value.retention, "$.backup.retention", issues);
      known(found, ["daily", "weekly", "monthly"], "$.backup.retention", issues);
      for (const key of ["daily", "weekly", "monthly"] as const) {
        const count = found[key];
        if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 3650)
          issues.push(`$.backup.retention.${key} must be an integer from 0 to 3650`);
      }
      retention = {
        daily: Number(found.daily),
        weekly: Number(found.weekly),
        monthly: Number(found.monthly),
      };
    }
    if (value.allowSharedAccess !== undefined && typeof value.allowSharedAccess !== "boolean")
      issues.push("$.backup.allowSharedAccess must be a boolean");
    backup = {
      destination,
      ...(pgDump ? { pgDump } : {}),
      ...(pgRestore ? { pgRestore } : {}),
      ...(value.schedule === "disabled" ? { schedule: "disabled" as const } : {}),
      ...(retention ? { retention } : {}),
      ...(value.allowSharedAccess === true ? { allowSharedAccess: true } : {}),
    };
  }
  if (issues.length) problems(issues);
  if (
    storageConfig.kind === "s3" &&
    typeof backup?.destination === "object" &&
    backupSharesIdentity(storageConfig, backup.destination)
  )
    policyDenied(
      "The backup bucket must be another bucket with another credential than the evidence storage",
      "backup_shares_storage_identity",
    );
  return {
    mode,
    database: {
      engine: "postgres",
      url,
      ...(passwordFile ? { passwordFile } : {}),
      ...(caFile ? { caFile } : {}),
      ...(applicationName ? { applicationName } : {}),
    },
    storage: storageConfig,
    server: {
      listen: { host, port: port as number },
      publicOrigin,
      trustedProxies,
      origins,
      ...(internalOrigin ? { internalOrigin } : {}),
      ...(typeof expected === "number" ? { expectedControllers: expected } : {}),
    },
    security: {
      masterKeyFile,
      backupKeyFile,
      atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
    },
    ...(telemetry ? { telemetry } : {}),
    ...(backup ? { backup } : {}),
  };
}
/**
 * Reads the deployment file. It must be a private regular file owned by the current user and is
 * never read from a project's `testmaster.config.json`.
 */
export async function readServerConfig(path: string): Promise<ServerConfig> {
  if (!isAbsolute(path))
    throw new ContractError("INVALID_ARGUMENT", "Server configuration path must be absolute");
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ContractError(
      code === "ENOENT" ? "NOT_FOUND" : "POLICY_DENIED",
      code === "ENOENT"
        ? "Server configuration file does not exist"
        : "Server configuration must be a regular file, not a symbolic link",
    );
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid?.() ||
      stat.size > 65536
    )
      throw new ContractError(
        "POLICY_DENIED",
        "Server configuration must be a private regular file (mode 0600, owned by the current user)",
      );
    return parseServerConfig(parseStrictJson(await handle.readFile(), 65536));
  } finally {
    await handle.close();
  }
}
