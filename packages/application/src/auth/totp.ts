import { createHmac } from "node:crypto";
import { ContractError } from "@testmaster/contracts";

export interface TotpOptions {
  algorithm?: "SHA1" | "SHA256" | "SHA512";
  digits?: number;
  periodSeconds?: number;
}
export interface ClockDiagnosis {
  /** Host clock minus the target's clock; `null` when the target sent no usable `Date` header. */
  driftSeconds: number | null;
  status: "ok" | "skewed" | "unknown";
  /** Largest drift that still lands in the same or the adjacent time step. */
  toleranceSeconds: number;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Strict RFC 4648 base32; the offending input is never echoed because it is the seed. */
export function decodeBase32(value: string): Buffer {
  const text = value.replace(/[\s-]/gu, "").replace(/=+$/u, "").toUpperCase();
  if (!text.length || /[^A-Z2-7]/u.test(text))
    throw new ContractError("INVALID_ARGUMENT", "TOTP seed is not valid base32");
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const character of text) {
    accumulator = (accumulator << 5) | ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 0xff);
      bits -= 8;
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bytes.length < 10)
    throw new ContractError("INVALID_ARGUMENT", "TOTP seed is shorter than 80 bits");
  return Buffer.from(bytes);
}

/** Accepts a bare base32 seed or an `otpauth://totp/...?secret=` provisioning URI. */
export function parseSeed(value: string): { key: Buffer; options: TotpOptions } {
  const text = value.trim();
  if (!/^otpauth:\/\//iu.test(text)) return { key: decodeBase32(text), options: {} };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ContractError("INVALID_ARGUMENT", "TOTP provisioning URI is invalid");
  }
  if (url.hostname.toLowerCase() !== "totp")
    throw new ContractError("INVALID_ARGUMENT", "Only time-based OTP provisioning is supported");
  const secret = url.searchParams.get("secret");
  if (!secret) throw new ContractError("INVALID_ARGUMENT", "TOTP provisioning URI has no secret");
  const algorithm = url.searchParams.get("algorithm")?.toUpperCase();
  const digits = Number(url.searchParams.get("digits") ?? 6);
  const period = Number(url.searchParams.get("period") ?? 30);
  return {
    key: decodeBase32(secret),
    options: {
      ...(algorithm === "SHA1" || algorithm === "SHA256" || algorithm === "SHA512"
        ? { algorithm }
        : {}),
      ...(Number.isInteger(digits) && digits >= 6 && digits <= 8 ? { digits } : {}),
      ...(Number.isInteger(period) && period >= 15 && period <= 120
        ? { periodSeconds: period }
        : {}),
    },
  };
}

export function timeStep(atMs: number, periodSeconds = 30): number {
  return Math.floor(atMs / 1000 / periodSeconds);
}

/** RFC 6238 / RFC 4226 dynamic truncation. */
export function totpCode(key: Buffer, atMs: number, options: TotpOptions = {}): string {
  const digits = options.digits ?? 6;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(timeStep(atMs, options.periodSeconds)));
  const hmac = createHmac((options.algorithm ?? "SHA1").toLowerCase(), key)
    .update(counter)
    .digest();
  const offset = (hmac.at(-1) ?? 0) & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function secondsLeftInStep(atMs: number, periodSeconds = 30): number {
  return periodSeconds - (Math.floor(atMs / 1000) % periodSeconds);
}

/**
 * Compares the target's clock (HTTP `Date` header) with ours. A drift beyond one time step makes
 * every generated code wrong, so the caller reports `clock_skew` instead of retrying codes.
 */
export function diagnoseClock(
  dateHeader: string | undefined,
  hostNowMs: number,
  periodSeconds = 30,
): ClockDiagnosis {
  const tolerance = periodSeconds;
  const parsed = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  if (!Number.isFinite(parsed))
    return { driftSeconds: null, status: "unknown", toleranceSeconds: tolerance };
  const drift = Math.round((hostNowMs - parsed) / 1000);
  return {
    driftSeconds: drift,
    status: Math.abs(drift) > tolerance ? "skewed" : "ok",
    toleranceSeconds: tolerance,
  };
}
