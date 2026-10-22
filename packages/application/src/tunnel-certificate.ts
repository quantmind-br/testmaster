import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
} from "node:crypto";

function length(bytes: number): Buffer {
  if (bytes < 0x80) return Buffer.from([bytes]);
  const octets: number[] = [];
  for (let rest = bytes; rest > 0; rest >>= 8) octets.unshift(rest & 0xff);
  return Buffer.from([0x80 | octets.length, ...octets]);
}
const tlv = (tag: number, ...content: Buffer[]): Buffer => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const sequence = (...content: Buffer[]) => tlv(0x30, ...content);
const ED25519 = sequence(Buffer.from("06032b6570", "hex"));
const COMMON_NAME = Buffer.from("0603550403", "hex");

function utcTime(at: Date): Buffer {
  const iso = at.toISOString();
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return tlv(0x17, Buffer.from(text, "ascii"));
}

/** An agent's session identity: a fresh Ed25519 key and a self-signed certificate for it. */
export interface TunnelIdentity {
  readonly key: KeyObject;
  readonly keyPem: string;
  readonly certificatePem: string;
  /** SHA-256 of the certificate's DER encoding, lowercase hex; workers pin it. */
  readonly certificateSha256: string;
}

/**
 * Creates the key and certificate one tunnel session uses for end-to-end TLS (ADR-031). The
 * certificate is valid from one hour before `now` (clock skew) for `lifetimeSeconds`, so it never
 * outlives the session; nothing trusts it except a worker that pins its fingerprint.
 */
export function createTunnelIdentity(lifetimeSeconds: number, now = new Date()): TunnelIdentity {
  const { privateKey } = generateKeyPairSync("ed25519");
  const name = sequence(
    tlv(0x31, sequence(COMMON_NAME, tlv(0x0c, Buffer.from("testmaster-tunnel", "utf8")))),
  );
  const serial = randomBytes(16);
  serial[0] = (serial[0] as number) & 0x7f;
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ED25519,
    name,
    sequence(
      utcTime(new Date(now.getTime() - 3_600_000)),
      utcTime(new Date(now.getTime() + lifetimeSeconds * 1000)),
    ),
    name,
    spki,
  );
  const signature = sign(null, tbs, privateKey);
  const der = sequence(tbs, ED25519, tlv(0x03, Buffer.from([0]), signature));
  const base64 = der.toString("base64").replace(/.{64}/g, "$&\n");
  return {
    key: privateKey,
    keyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    certificatePem: `-----BEGIN CERTIFICATE-----\n${base64.trimEnd()}\n-----END CERTIFICATE-----\n`,
    certificateSha256: createHash("sha256").update(der).digest("hex"),
  };
}

/** The lowercase hex SHA-256 of a peer certificate's DER bytes. */
export function certificateFingerprint(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}
