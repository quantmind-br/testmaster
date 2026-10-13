import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { ContractError } from "@testmaster/contracts";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;
const cost = { N: 32768, r: 8, p: 1 } as const;
const maxMemory = 128 * 1024 * 1024;
export const passwordPolicy = { minLength: 12, maxLength: 256 } as const;
/** `login` is globally unique across workspaces (ADR-017). */
export const loginPattern = /^[a-z0-9][a-z0-9._@-]{2,63}$/;

export function assertPasswordAcceptable(password: string): void {
  if (password.length < passwordPolicy.minLength || password.length > passwordPolicy.maxLength)
    throw new ContractError(
      "INVALID_ARGUMENT",
      `Password must have ${passwordPolicy.minLength} to ${passwordPolicy.maxLength} characters`,
    );
}
/** `scrypt$N$r$p$<salt b64>$<key b64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(32);
  const key = await scryptAsync(password, salt, 64, { ...cost, maxmem: maxMemory });
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}
/** Constant-time check; a malformed or oversized stored hash never verifies. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key, ...rest] = stored.split("$");
  if (scheme !== "scrypt" || rest.length || !salt || !key) return false;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (
    !Number.isInteger(params.N) ||
    params.N < 2 ||
    params.N > 1 << 20 ||
    (params.N & (params.N - 1)) !== 0 ||
    params.r !== cost.r ||
    params.p !== cost.p
  )
    return false;
  const expected = Buffer.from(key, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, {
    ...params,
    maxmem: maxMemory,
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
let dummyHash: Promise<string> | undefined;
/** Burns the same work as a real verification so an unknown login is not distinguishable by time. */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(password, await dummyHash);
}
export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export const randomToken = (): string => randomBytes(32).toString("base64url");
