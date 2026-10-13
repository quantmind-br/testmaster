import { expect, it } from "vitest";
import { decodeBase32, diagnoseClock, parseSeed, secondsLeftInStep, totpCode } from "./totp.js";

const seeds = {
  SHA1: Buffer.from("12345678901234567890"),
  SHA256: Buffer.from("12345678901234567890123456789012"),
  SHA512: Buffer.from("1234567890123456789012345678901234567890123456789012345678901234"),
} as const;
// RFC 6238 appendix B: [unix seconds, SHA1, SHA256, SHA512].
const vectors: [number, string, string, string][] = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

it("SEC-024 generates every RFC 6238 appendix B vector for SHA-1, SHA-256 and SHA-512", () => {
  for (const [seconds, sha1, sha256, sha512] of vectors) {
    const at = seconds * 1000;
    expect(totpCode(seeds.SHA1, at, { digits: 8 })).toBe(sha1);
    expect(totpCode(seeds.SHA256, at, { digits: 8, algorithm: "SHA256" })).toBe(sha256);
    expect(totpCode(seeds.SHA512, at, { digits: 8, algorithm: "SHA512" })).toBe(sha512);
  }
  // Negative control: the neighbouring time step yields a different code, so a code is only
  // valid for its own window and the vectors above are not satisfied by a constant.
  expect(totpCode(seeds.SHA1, 59_000 + 30_000, { digits: 8 })).not.toBe("94287082");
  expect(totpCode(seeds.SHA1, 59_000, { digits: 8, algorithm: "SHA256" })).not.toBe("94287082");
});

it("SEC-024 reads base32 and otpauth seeds and never echoes a rejected seed", () => {
  const base32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  expect(decodeBase32(base32).toString()).toBe("12345678901234567890");
  expect(decodeBase32("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq=").toString()).toBe(
    "12345678901234567890",
  );
  const parsed = parseSeed(
    `otpauth://totp/Reference:alice?secret=${base32}&algorithm=SHA256&digits=8&period=60&issuer=Reference`,
  );
  expect(parsed.options).toEqual({ algorithm: "SHA256", digits: 8, periodSeconds: 60 });
  expect(parsed.key.toString()).toBe("12345678901234567890");
  const leaked = "SEED-MUST-NOT-LEAK-1";
  let message = "";
  try {
    decodeBase32(leaked);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain("not valid base32");
  expect(message).not.toContain(leaked);
  expect(() => parseSeed("otpauth://hotp/x?secret=GEZDGNBV")).toThrow(/time-based/u);
  expect(() => parseSeed("otpauth://totp/x")).toThrow(/no secret/u);
});

it("SEC-024 diagnoses a clock that is more than one step away from the target instead of guessing", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  const header = (offsetSeconds: number) => new Date(now - offsetSeconds * 1000).toUTCString();
  expect(diagnoseClock(header(5), now)).toMatchObject({ status: "ok", driftSeconds: 5 });
  expect(diagnoseClock(header(-29), now).status).toBe("ok");
  const skewed = diagnoseClock(header(95), now);
  expect(skewed).toMatchObject({ status: "skewed", driftSeconds: 95, toleranceSeconds: 30 });
  expect(diagnoseClock(header(-95), now).status).toBe("skewed");
  expect(diagnoseClock(undefined, now)).toMatchObject({ status: "unknown", driftSeconds: null });
  expect(diagnoseClock("not a date", now).status).toBe("unknown");
  expect(secondsLeftInStep(59_000)).toBe(1);
  expect(secondsLeftInStep(60_000)).toBe(30);
});
