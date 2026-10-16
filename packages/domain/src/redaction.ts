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

/** Identifiers the frozen plan declares; they are plan text, not target or secret data. */
export interface PlanIdentifiers {
  stepIds: ReadonlySet<string>;
  captureNames: ReadonlySet<string>;
}
/**
 * Collects the step ids (and the ids of their cleanup requests) and the capture names declared by
 * the plan, login steps and approved agent actions in `roots`. The plan is stored verbatim, so
 * redaction must not rewrite these names inside the records that report on them: the host matches
 * step results, captures and locator evidence back to the plan by exact name.
 */
export function planIdentifiers(...roots: unknown[]): PlanIdentifiers {
  const stepIds = new Set<string>();
  const captureNames = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const node = value as { id?: unknown; operation?: unknown; capture?: unknown };
    if (typeof node.id === "string" && typeof node.operation === "string") {
      stepIds.add(node.id);
      stepIds.add(`cleanup-${node.id}`);
    }
    if (Array.isArray(node.capture))
      for (const capture of node.capture as { name?: unknown }[])
        if (typeof capture?.name === "string") captureNames.add(capture.name);
    for (const child of Object.values(node)) walk(child);
  };
  for (const root of roots) walk(root);
  return { stepIds, captureNames };
}
const stepIdField = (id: string): string => `"stepId":${JSON.stringify(id)}`;
/**
 * Puts plan step ids back into the `"stepId"` fields of already scrubbed JSON text, where `scrub`
 * rewrote them because a secret value occurs inside the id. Only that exact field is restored: a
 * step id is plan text, so the field reveals nothing the stored plan does not.
 */
export function restoreStepIds(
  scrubbed: string,
  stepIds: ReadonlySet<string>,
  scrub: (text: string) => string,
): string {
  if (!scrubbed.includes('"stepId":')) return scrubbed;
  let output = scrubbed;
  for (const id of stepIds) {
    const redacted = scrub(id);
    if (redacted !== id) output = output.replaceAll(stepIdField(redacted), stepIdField(id));
  }
  return output;
}
/** Blanks the `"stepId"` fields that name plan steps, so a leak scan does not flag restored ids. */
export function withoutStepIdFields(text: string, stepIds: ReadonlySet<string>): string {
  if (!text.includes('"stepId":')) return text;
  let output = text;
  for (const id of stepIds) output = output.replaceAll(stepIdField(id), '"stepId":""');
  return output;
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

const secretVariableName = /secret|token|password|credential|api_key/iu;
/** Shorter values are flags and counters (`true`, `false`, `1`), never credentials. */
const minimumSecretLength = 8;
/**
 * Values of the environment variables that look like credentials, for scrubbing evidence. A flag
 * such as `INSPECTOR_MASK_SECRETS=true` or `REQUIRE_API_KEY=false` is not a credential: treating it
 * as one would redact every JSON `true`/`false` in the evidence.
 */
export function environmentSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ...new Set(
      Object.entries(env).flatMap(([name, value]) =>
        secretVariableName.test(name) && value !== undefined && value.length >= minimumSecretLength
          ? [value]
          : [],
      ),
    ),
  ];
}
const sensitiveStringProperty =
  /^(?:password|passwd|token|access_token|api_key|secret|document|cpf|email)$/iu;
/**
 * Deep-scrubs the strings of a JSON-compatible value (keys and values) with `scrubEvidenceText`
 * and redacts string values of the sensitive property names that `scrubEvidenceText` redacts in
 * JSON text. Numbers, booleans and null are never touched, so the result stays valid JSON
 * whatever the secrets are; `undefined` properties are dropped as `JSON.stringify` does.
 */
export function scrubEvidenceValue<T>(value: T, secrets: readonly string[] = []): T {
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return scrubEvidenceText(item, secrets).text;
    if (Array.isArray(item)) return item.map((entry) => visit(entry === undefined ? null : entry));
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).flatMap(([key, entry]) =>
          entry === undefined
            ? []
            : [
                [
                  scrubEvidenceText(key, secrets).text,
                  typeof entry === "string" && sensitiveStringProperty.test(key)
                    ? "[REDACTED]"
                    : visit(entry),
                ],
              ],
        ),
      );
    return item;
  };
  return visit(value) as T;
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
