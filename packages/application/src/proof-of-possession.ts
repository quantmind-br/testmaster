import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { ContractError } from "@testmaster/contracts";

/** The authorization scheme of a remote caller that proves possession of its key (ADR-031). */
export const POP_SCHEME = "TM-PoP";
/**
 * A proof older or newer than this is refused. The window bounds the nonce cache a server keeps
 * to refuse replays; worker and server clocks are synchronised (ADR-030).
 */
export const POP_WINDOW_MS = 60_000;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** The caller's Ed25519 public key as its raw 32 bytes in base64url. */
export function popPublicKey(key: KeyObject): string {
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("base64url");
}

function publicKeyObject(raw: string): KeyObject | null {
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== raw) return null;
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]),
    format: "der",
    type: "spki",
  });
}

/** A fresh Ed25519 private key. */
export function createPopKey(): KeyObject {
  return generateKeyPairSync("ed25519").privateKey;
}

/**
 * The key kept at `path` (PKCS#8 PEM, mode 0600), created on first use. A file that is not an
 * Ed25519 private key is refused rather than replaced, since replacing it would lose the identity.
 */
export async function loadOrCreatePopKey(path: string): Promise<KeyObject> {
  let pem: string | null = null;
  try {
    pem = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (pem === null) {
    const key = createPopKey();
    try {
      await writeFile(path, key.export({ format: "pem", type: "pkcs8" }), {
        mode: 0o600,
        flag: "wx",
      });
      return key;
    } catch (error) {
      // Another process created it first: use that key.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      pem = await readFile(path, "utf8");
    }
  }
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new ContractError("INVALID_ARGUMENT", "The worker key file is not an Ed25519 key", {
      path,
    });
  return key;
}

interface ProofInput {
  readonly keyId: string;
  readonly method: string;
  readonly path: string;
  readonly created: number;
  readonly nonce: string;
}

const canonical = (input: ProofInput): Buffer =>
  Buffer.from(
    `tm-pop-v1\n${input.method.toUpperCase()}\n${input.path}\n${input.created}\n${input.nonce}\n${input.keyId}`,
  );

/**
 * The `TM-PoP` header value for one request: `path` is the request target (path and query) the
 * server receives. Each value carries a fresh nonce, so it authorizes that one request only.
 */
export function popAuthorization(
  key: KeyObject,
  keyId: string,
  method: string,
  path: string,
  now = Date.now(),
): string {
  const nonce = randomBytes(18).toString("base64url");
  const signature = sign(
    null,
    canonical({ keyId, method, path, created: now, nonce }),
    key,
  ).toString("base64url");
  return `${POP_SCHEME} keyId="${keyId}", created=${now}, nonce="${nonce}", signature="${signature}"`;
}

export interface PopProof {
  readonly keyId: string;
  readonly created: number;
  readonly nonce: string;
  readonly signature: string;
}

/** Parses a `TM-PoP` header value; anything malformed is null. */
export function parsePopAuthorization(header: unknown): PopProof | null {
  if (typeof header !== "string" || !header.startsWith(`${POP_SCHEME} `)) return null;
  const fields = new Map<string, string>();
  for (const part of header.slice(POP_SCHEME.length + 1).split(",")) {
    const match = /^\s*([a-zA-Z]+)=(?:"([^"]*)"|([0-9]+))\s*$/.exec(part);
    if (!match) return null;
    fields.set(match[1] as string, (match[2] ?? match[3]) as string);
  }
  const keyId = fields.get("keyId");
  const created = Number(fields.get("created"));
  const nonce = fields.get("nonce");
  const signature = fields.get("signature");
  if (!keyId || !nonce || !signature || !Number.isSafeInteger(created) || fields.size !== 4)
    return null;
  if (nonce.length < 16 || nonce.length > 64) return null;
  return { keyId, created, nonce, signature };
}

/**
 * Checks proofs for one server process: the signature, the time window and the nonce. A nonce
 * is remembered for twice the window, so a captured header cannot be presented again.
 */
export class PopVerifier {
  private readonly seen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** True when `proof` signs this request with `publicKey` and was never presented before. */
  verify(
    proof: PopProof,
    request: { readonly method: string; readonly path: string },
    publicKey: string,
  ): boolean {
    const now = this.now();
    if (Math.abs(now - proof.created) > POP_WINDOW_MS) return false;
    // Entries expire in insertion order, so pruning stops at the first live one.
    for (const [nonce, expires] of this.seen) {
      if (expires > now) break;
      this.seen.delete(nonce);
    }
    const replayKey = `${proof.keyId}\n${proof.nonce}`;
    if (this.seen.has(replayKey)) return false;
    const key = publicKeyObject(publicKey);
    if (!key) return false;
    const signature = Buffer.from(proof.signature, "base64url");
    if (signature.length !== 64) return false;
    const valid = verify(
      null,
      canonical({
        keyId: proof.keyId,
        method: request.method,
        path: request.path,
        created: proof.created,
        nonce: proof.nonce,
      }),
      key,
      signature,
    );
    if (valid) this.seen.set(replayKey, now + 2 * POP_WINDOW_MS);
    return valid;
  }
}
