import { ContractError } from "@testmaster/contracts";
export interface RedactedText {
  text: string;
  redacted: boolean;
}
export function scrubText(
  text: string,
  secrets: readonly string[],
  replacement = "[REDACTED]",
): RedactedText {
  let output = text;
  const values = [...new Set(secrets.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  for (const value of values) output = output.replaceAll(value, replacement);
  return { text: output, redacted: output !== text };
}

/** Shared default-pattern policy; encoded/unknown PII is not an anonymity guarantee. */
export function scrubEvidenceText(text: string, secrets: readonly string[] = []): RedactedText {
  let output = scrubText(
    text,
    secrets.flatMap((value) => [value, encodeURIComponent(value)]),
  ).text;
  output = output
    .replace(
      /\b(authorization|proxy-authorization|set-cookie|cookie)\s*:\s*[^\r\n]+/giu,
      "$1: [REDACTED]",
    )
    .replace(
      /([?&](?:token|access_token|api_key|password|secret|session)=)[^&#\s"'<>]*/giu,
      "$1[REDACTED]",
    )
    .replace(
      /("(?:password|passwd|token|access_token|api_key|secret|document|cpf|email)"\s*:\s*)"(?:[^"\\]|\\.)*"/giu,
      '$1"[REDACTED]"',
    )
    .replace(
      /\b(password|passwd|token|access_token|api_key|secret|document|cpf)\s*[=:]\s*[^\s,;&<>"']+/giu,
      "$1=[REDACTED]",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED]")
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/gu, "[REDACTED]");
  return { text: output, redacted: output !== text };
}
export function scrubBytes(
  bytes: Uint8Array,
  secrets: readonly Uint8Array[],
  replacement = Buffer.from("[REDACTED]"),
): Uint8Array {
  let output = Buffer.from(bytes);
  for (const secret of [...secrets]
    .filter((value) => value.byteLength)
    .sort((left, right) => right.byteLength - left.byteLength)) {
    const needle = Buffer.from(secret);
    const chunks: Buffer[] = [];
    let position = 0;
    let index = output.indexOf(needle, position);
    while (index !== -1) {
      chunks.push(output.subarray(position, index), replacement);
      position = index + needle.length;
      index = output.indexOf(needle, position);
    }
    chunks.push(output.subarray(position));
    output = Buffer.concat(chunks);
  }
  return output;
}
export interface TaintedValue<T> {
  value: T;
  taint: "public" | "sensitive";
  sources: readonly string[];
}
export function propagateTaint<T>(
  value: T,
  inputs: readonly TaintedValue<unknown>[],
): TaintedValue<T> {
  return {
    value,
    taint: inputs.some((input) => input.taint === "sensitive") ? "sensitive" : "public",
    sources: [...new Set(inputs.flatMap((input) => input.sources))],
  };
}
export function requirePublic<T>(value: TaintedValue<T>): T {
  if (value.taint === "sensitive")
    throw new ContractError("POLICY_DENIED", "Sensitive value cannot be published");
  return value.value;
}
