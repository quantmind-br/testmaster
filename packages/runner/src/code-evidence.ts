import { posix } from "node:path";
import { ARTIFACT_BYTES, DOM_BYTES } from "./page-evidence.js";

/**
 * What a failed test of imported code leaves behind about its page. The `@playwright/test` shim
 * attaches these to the failing test in the Playwright process, TestMaster's reporter forwards
 * them to the harness, and the harness records them as artifacts. Only these names are read; the
 * kind alone decides the artifact's path, so a path never comes from the test process.
 */
export const FAILURE_ATTACHMENTS = {
  screenshot: {
    name: "testmaster-failure-screenshot",
    mimeType: "image/png",
    extension: "png",
    limitBytes: ARTIFACT_BYTES,
  },
  dom: {
    name: "testmaster-failure-dom",
    mimeType: "text/html",
    extension: "html",
    limitBytes: DOM_BYTES,
  },
} as const;
/** Attachment in which the shim says why it could not capture; the reporter turns it into a warn log. */
export const FAILURE_WARNING_ATTACHMENT = "testmaster-failure-warning";
/** Longest warning text the reporter forwards. */
export const FAILURE_WARNING_CHARS = 2000;
/** Reporter event carrying one captured file to the harness. */
export const FAILURE_ARTIFACT_EVENT = "failure.artifact";

export type FailureKind = keyof typeof FAILURE_ATTACHMENTS;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Test steps the reporter announces; a failure artifact belongs to one of them. */
const TEST_STEP_ID = /^imported-test-\d+$/u;

/** What the reporter receives from Playwright for one attachment. */
export interface ReportedAttachment {
  name: string;
  contentType: string;
  path?: string | undefined;
  body?: Buffer | undefined;
}
/** The file kind named by `name`, if it is one of the failure attachments. */
export function failureKind(name: string): FailureKind | undefined {
  return (Object.keys(FAILURE_ATTACHMENTS) as FailureKind[]).find(
    (kind) => FAILURE_ATTACHMENTS[kind].name === name,
  );
}
/** Why `bytes` is not a valid file of `kind`, or undefined when it is. */
function invalidBytes(kind: FailureKind, bytes: Uint8Array): string | undefined {
  const spec = FAILURE_ATTACHMENTS[kind];
  if (bytes.byteLength === 0) return "empty";
  if (bytes.byteLength > spec.limitBytes) return "over the byte limit";
  if (kind === "screenshot")
    return Buffer.from(bytes.subarray(0, PNG_SIGNATURE.length)).equals(PNG_SIGNATURE)
      ? undefined
      : "not a PNG image";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return undefined;
  } catch {
    return "not UTF-8 text";
  }
}
/**
 * Reporter side: the file an attachment carries, or why it is refused. Only bytes the test process
 * put in the attachment are used: an attachment that points at a file on disk is refused unread.
 */
export function vetAttachment(
  kind: FailureKind,
  attachment: ReportedAttachment,
): { data: string } | { refused: string } {
  const spec = FAILURE_ATTACHMENTS[kind];
  if (attachment.path !== undefined)
    return { refused: "it points at a file instead of carrying its bytes" };
  if (!Buffer.isBuffer(attachment.body)) return { refused: "it has no body" };
  if (attachment.contentType !== spec.mimeType) return { refused: "its content type is wrong" };
  const invalid = invalidBytes(kind, attachment.body);
  return invalid ? { refused: invalid } : { data: attachment.body.toString("base64") };
}

/** The harness's side of the runner: what recording a failure artifact needs from it. */
export interface EvidenceSink {
  artifact(path: string, kind: string, mimeType: string, bytes: Uint8Array): Promise<void>;
  emit(type: string, payload: unknown): Promise<void>;
  scrub(text: string): string;
}

/**
 * Records the failure artifacts the Playwright process reports, trusting nothing in them: the
 * test step must have been announced, the kind must be one of ours, the bytes must be canonical
 * base64 of a valid file within its limit, and the path is built here from the step id. A refused
 * artifact is a warn log and never changes a verdict.
 */
export class FailureEvidence {
  private readonly started = new Set<string>();
  private readonly recorded = new Map<string, string[]>();
  constructor(private readonly sink: EvidenceSink) {}
  /** Notes that the reporter announced the test step `stepId`. */
  begin(stepId: unknown): void {
    if (typeof stepId === "string" && TEST_STEP_ID.test(stepId)) this.started.add(stepId);
  }
  /** Paths of the artifacts recorded for `stepId`, to cite as evidence of the step. */
  pathsFor(stepId: string): string[] {
    return [...(this.recorded.get(stepId) ?? [])];
  }
  private async warn(message: string): Promise<void> {
    await this.sink.emit("log", {
      level: "warn",
      message: this.sink.scrub(message).slice(0, 16384),
    });
  }
  async accept(payload: unknown): Promise<void> {
    try {
      const refusal = await this.record(payload);
      if (refusal) await this.warn(`Failure evidence refused: ${refusal}`);
    } catch (error) {
      await this.warn(
        `Failure evidence unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  private async record(payload: unknown): Promise<string | undefined> {
    if (!payload || typeof payload !== "object") return "malformed message";
    const { stepId, kind, data } = payload as Record<string, unknown>;
    if (typeof stepId !== "string" || !this.started.has(stepId)) return "unknown test";
    if (typeof kind !== "string" || !Object.hasOwn(FAILURE_ATTACHMENTS, kind))
      return "unknown kind";
    const spec = FAILURE_ATTACHMENTS[kind as FailureKind];
    if (typeof data !== "string") return `${kind} has no data`;
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data) return `${kind} is not canonical base64`;
    const invalid = invalidBytes(kind as FailureKind, bytes);
    if (invalid) return `${kind} is ${invalid}`;
    const path = posix.join("browser/code", `${stepId}-failure.${spec.extension}`);
    const paths = this.recorded.get(stepId) ?? [];
    if (paths.includes(path)) return `${kind} was already recorded for the test`;
    await this.sink.artifact(path, kind, spec.mimeType, bytes);
    this.recorded.set(stepId, [...paths, path]);
    return undefined;
  }
}
