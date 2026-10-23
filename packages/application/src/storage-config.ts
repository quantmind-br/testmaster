import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { ContractError } from "@testmaster/contracts";
import { FileObjectStore, type ObjectStore, S3ObjectStore } from "@testmaster/evidence";
import type { StorageConfig } from "./server-config.js";

/**
 * Where one S3-compatible bucket lives and which credential files open it. The evidence bucket
 * and the backup bucket use different locations and different credentials (OPS-026, SEC-030).
 */
export interface S3LocationConfig {
  endpoint: string;
  region: string;
  bucket: string;
  prefix?: string;
  forcePathStyle: boolean;
  /** Absolute path of a private file holding the access key id. */
  accessKeyIdFile: string;
  /** Absolute path of a private file holding the secret access key. */
  secretAccessKeyFile: string;
  /** Absolute path of a PEM bundle that signs the endpoint's certificate. */
  caFile?: string;
}

const maxCredentialBytes = 4096;
const maxCaBytes = 1024 * 1024;

/** A private regular file owned by the current user, like every other secret file of the profile. */
async function readPrivateFile(
  path: string,
  label: string,
  limit: number,
  private_: boolean,
): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ContractError(
      code === "ENOENT" ? "NOT_FOUND" : "PRECONDITION_FAILED",
      `${label} is not readable`,
      { reasonCode: "key_file_unavailable", errno: code },
    );
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size === 0 ||
      info.size > limit ||
      (private_ && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    )
      throw new ContractError(
        "PRECONDITION_FAILED",
        private_
          ? `${label} must be a non-empty regular file with mode 0600 owned by the current user`
          : `${label} must be a non-empty regular file`,
        { reasonCode: "key_file_invalid" },
      );
    return (await handle.readFile("utf8")).trim();
  } finally {
    await handle.close();
  }
}

/** Opens the bucket named by `location`; credential files must be private (no group/world access). */
export async function openS3Store(location: S3LocationConfig): Promise<S3ObjectStore> {
  const [accessKeyId, secretAccessKey, caPem] = await Promise.all([
    readPrivateFile(location.accessKeyIdFile, "S3 access key id file", maxCredentialBytes, true),
    readPrivateFile(
      location.secretAccessKeyFile,
      "S3 secret access key file",
      maxCredentialBytes,
      true,
    ),
    location.caFile
      ? readPrivateFile(location.caFile, "S3 CA file", maxCaBytes, false)
      : Promise.resolve(undefined),
  ]);
  return new S3ObjectStore({
    endpoint: location.endpoint,
    region: location.region,
    bucket: location.bucket,
    ...(location.prefix ? { prefix: location.prefix } : {}),
    forcePathStyle: location.forcePathStyle,
    accessKeyId,
    secretAccessKey,
    ...(caPem ? { caPem } : {}),
  });
}

/** The store the deployment's evidence lives in: its bucket, or its filesystem root. */
export async function openEvidenceStore(storage: StorageConfig): Promise<ObjectStore> {
  return storage.kind === "s3" ? openS3Store(storage) : new FileObjectStore(storage.root);
}
/** Releases the connections of a store from `openEvidenceStore`. */
export function closeObjectStore(store: ObjectStore): void {
  if (store instanceof S3ObjectStore) store.close();
}
