import { ContractError } from "@testmaster/contracts";
import type { ObjectStore } from "@testmaster/evidence";

/*
 * Object keys of the workspace-scoped data besides evidence bundles. The workspace comes from the
 * authenticated context and the id from the server's own generator, never from a client string
 * (SEC-030).
 */
export const uploadKey = (workspaceId: string, uploadId: string): string =>
  `uploads/${workspaceId}/${uploadId}.bin`;
export const sourceBytesKey = (workspaceId: string, revisionId: string): string =>
  `sources/${workspaceId}/${revisionId}.bin`;

/**
 * The whole object, or `null` when it is absent. A body larger than `maxBytes` is refused, so a
 * hostile or corrupted object cannot exhaust memory.
 */
export async function readObjectBytes(
  store: ObjectStore,
  key: string,
  maxBytes: number,
): Promise<Buffer | null> {
  const info = await store.head(key);
  if (!info) return null;
  if (info.sizeBytes > maxBytes)
    throw new ContractError("PAYLOAD_TOO_LARGE", "Stored object exceeds limit", { key });
  const body = await store.get(key);
  if (!body) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const part = chunk as Uint8Array;
    total += part.length;
    if (total > maxBytes)
      throw new ContractError("PAYLOAD_TOO_LARGE", "Stored object exceeds limit", { key });
    // Chunks of the local store are borrowed buffers: copy before asking for the next one.
    chunks.push(Buffer.from(part));
  }
  return Buffer.concat(chunks);
}
