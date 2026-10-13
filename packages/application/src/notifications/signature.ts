import { createHmac, timingSafeEqual } from "node:crypto";
import { NOTIFICATION_REPLAY_TOLERANCE_SECONDS } from "@testmaster/contracts";

/**
 * `TestMaster-Signature: t=<ts>,v1=<hex HMAC-SHA256(secret, "<ts>.<deliveryId>.<raw body>")>` (ADR-021).
 * During a rotation window the previous secret signs too, so the header carries two `v1=` values.
 */
export function signNotification(
  secrets: readonly string[],
  timestampSeconds: number,
  deliveryId: string,
  body: Buffer,
): string {
  const signed = Buffer.concat([Buffer.from(`${timestampSeconds}.${deliveryId}.`, "utf8"), body]);
  return [
    `t=${timestampSeconds}`,
    ...secrets.map((secret) => `v1=${createHmac("sha256", secret).update(signed).digest("hex")}`),
  ].join(",");
}

export type NotificationVerification =
  | { valid: true; timestamp: number }
  | {
      valid: false;
      reason:
        | "missing_signature"
        | "malformed_signature"
        | "stale_timestamp"
        | "signature_mismatch";
    };

/**
 * Reference consumer: validates the original bytes, rejects tampering and stale timestamps. A
 * consumer dedupes on the delivery ID (`TestMaster-Delivery-Id`) after this check passes.
 */
export function verifyNotification(input: {
  header: string | undefined;
  deliveryId: string;
  body: Buffer;
  secrets: readonly string[];
  now: Date;
  toleranceSeconds?: number;
}): NotificationVerification {
  if (!input.header) return { valid: false, reason: "missing_signature" };
  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const part of input.header.split(",")) {
    const [key, value] = [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)];
    if (key === "t" && /^[0-9]{1,12}$/u.test(value)) timestamp = Number(value);
    else if (key === "v1" && /^[0-9a-f]{64}$/u.test(value)) candidates.push(value);
  }
  if (timestamp === null || !candidates.length)
    return { valid: false, reason: "malformed_signature" };
  const tolerance = input.toleranceSeconds ?? NOTIFICATION_REPLAY_TOLERANCE_SECONDS;
  if (Math.abs(input.now.getTime() / 1000 - timestamp) > tolerance)
    return { valid: false, reason: "stale_timestamp" };
  const signed = Buffer.concat([
    Buffer.from(`${timestamp}.${input.deliveryId}.`, "utf8"),
    input.body,
  ]);
  for (const secret of input.secrets) {
    const expected = createHmac("sha256", secret).update(signed).digest();
    for (const candidate of candidates)
      if (timingSafeEqual(expected, Buffer.from(candidate, "hex")))
        return { valid: true, timestamp };
  }
  return { valid: false, reason: "signature_mismatch" };
}

/** Header set a webhook receiver sees for one delivery (names as documented in ADR-021). */
export function notificationHeaders(input: {
  eventId: string;
  deliveryId: string;
  timestampSeconds: number;
  signature: string;
}): Record<string, string> {
  return {
    "TestMaster-Event-Id": input.eventId,
    "TestMaster-Delivery-Id": input.deliveryId,
    "TestMaster-Timestamp": String(input.timestampSeconds),
    "TestMaster-Signature": input.signature,
  };
}
