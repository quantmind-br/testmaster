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
  /** Variable references the plan or the runner derives from plan text: `<stepId>.<capture>`, `<stepId>.handle`, and every `variableRef` the plan writes. */
  variableRefs: ReadonlySet<string>;
}
/**
 * Collects the step ids (and the ids of their cleanup requests), the capture names and the variable
 * references declared by the plan, login steps and approved agent actions in `roots`. The plan is
 * stored verbatim, so redaction must not rewrite these names inside the records that report on
 * them: the host matches step results, captures and locator evidence back to the plan by exact
 * name. A plan author cannot avoid a collision, because a short secret value such as the user name
 * `root` also occurs in ordinary words (`open_root`), and a warning that named the colliding secret
 * would let an author who may not read secrets probe its value, so the names are exempt instead.
 */
export function planIdentifiers(...roots: unknown[]): PlanIdentifiers {
  const stepIds = new Set<string>();
  const captureNames = new Set<string>();
  const variableRefs = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const node = value as {
      id?: unknown;
      operation?: unknown;
      capture?: unknown;
      input?: { capture?: unknown; resource?: unknown } | null;
      variableRef?: unknown;
      resourceRef?: unknown;
      find?: unknown;
    };
    // A cleanup entry that finds its data by lookup binds the matched id to <resourceRef>.handle.
    if (typeof node.resourceRef === "string" && node.find) {
      variableRefs.add(`${node.resourceRef}.handle`);
      stepIds.add(`cleanup-find-${node.resourceRef}`);
    }
    if (typeof node.id === "string" && typeof node.operation === "string") {
      stepIds.add(node.id);
      stepIds.add(`cleanup-${node.id}`);
      const input = node.input;
      if (Array.isArray(input?.capture))
        for (const capture of input.capture as { name?: unknown }[])
          if (typeof capture?.name === "string") variableRefs.add(`${node.id}.${capture.name}`);
      if (input?.resource) variableRefs.add(`${node.id}.handle`);
    }
    if (typeof node.variableRef === "string") variableRefs.add(node.variableRef);
    if (Array.isArray(node.capture))
      for (const capture of node.capture as { name?: unknown }[])
        if (typeof capture?.name === "string") captureNames.add(capture.name);
    for (const child of Object.values(node)) walk(child);
  };
  for (const root of roots) walk(root);
  return { stepIds, captureNames, variableRefs };
}
/** The JSON fields of runner records that hold plan identifiers, and the identifiers each may hold. */
const identifierFields = (
  identifiers: PlanIdentifiers,
): readonly (readonly [field: string, names: ReadonlySet<string>])[] => [
  ["stepId", identifiers.stepIds],
  ["variableRef", identifiers.variableRefs],
];
const identifierField = (field: string, id: string): string => `"${field}":${JSON.stringify(id)}`;
/**
 * Puts plan identifiers back into the `"stepId"` and `"variableRef"` fields of already scrubbed
 * JSON text, where `scrub` rewrote them because a secret value occurs inside the name. Only those
 * exact fields are restored: a step id or variable reference is plan text, so the field reveals
 * nothing the stored plan does not.
 */
export function restorePlanIdentifiers(
  scrubbed: string,
  identifiers: PlanIdentifiers,
  scrub: (text: string) => string,
): string {
  let output = scrubbed;
  for (const [field, names] of identifierFields(identifiers)) {
    if (!output.includes(`"${field}":`)) continue;
    for (const id of names) {
      const redacted = scrub(id);
      if (redacted !== id)
        output = output.replaceAll(identifierField(field, redacted), identifierField(field, id));
    }
  }
  return output;
}
/** Blanks the `"stepId"` and `"variableRef"` fields that name plan identifiers, so a leak scan does not flag restored names. */
export function withoutPlanIdentifierFields(text: string, identifiers: PlanIdentifiers): string {
  let output = text;
  for (const [field, names] of identifierFields(identifiers)) {
    if (!output.includes(`"${field}":`)) continue;
    for (const id of names) output = output.replaceAll(identifierField(field, id), `"${field}":""`);
  }
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
