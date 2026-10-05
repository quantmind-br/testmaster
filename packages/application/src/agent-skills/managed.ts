import { createHash } from "node:crypto";
import type { AgentSkillReason } from "./types.js";

export const AGENT_SKILL_VERSION = "1.0.0";
const END = "<!-- testmaster:end -->";
export interface ManagedSection {
  start: number;
  end: number;
  version: string;
  hash: string;
  body: Buffer;
}
export function agentSkillHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function inspectManagedSection(
  bytes: Buffer,
  wholeFile = false,
):
  | { section: ManagedSection | null; reasonCode?: never }
  | { section?: never; reasonCode: AgentSkillReason } {
  const text = bytes.toString("latin1");
  const starts = [...text.matchAll(/<!--\s*testmaster:begin\b/g)];
  const ends = [...text.matchAll(/<!--\s*testmaster:end\b/g)];
  if (starts.length > 1 || ends.length > 1) return { reasonCode: "duplicate_markers" };
  if (!starts.length && !ends.length) return { section: null };
  const match = /<!-- testmaster:begin version=([a-zA-Z0-9._-]+) hash=([a-f0-9]{64}) -->/.exec(
    text,
  );
  const endStart = text.indexOf(END);
  if (
    !match ||
    starts.length !== 1 ||
    ends.length !== 1 ||
    endStart < match.index + match[0].length
  )
    return { reasonCode: "unbalanced_markers" };
  const start = match.index;
  const end = endStart + END.length + (text[endStart + END.length] === "\n" ? 1 : 0);
  const body = bytes.subarray(start + match[0].length, endStart);
  const owned = wholeFile
    ? Buffer.concat([bytes.subarray(0, start), body, bytes.subarray(end)])
    : body;
  if (agentSkillHash(owned) !== match[2]) return { reasonCode: "managed_drift" };
  return { section: { start, end, version: match[1] as string, hash: match[2] as string, body } };
}
export function renderManagedSection(body: Buffer, version: string): Buffer {
  return Buffer.concat([
    Buffer.from(`<!-- testmaster:begin version=${version} hash=${agentSkillHash(body)} -->`),
    body,
    Buffer.from(`${END}\n`),
  ]);
}
export function renderOwnedSkill(content: Buffer, version: string): Buffer {
  return Buffer.concat([
    content,
    Buffer.from(
      `<!-- testmaster:begin version=${version} hash=${agentSkillHash(content)} -->${END}\n`,
    ),
  ]);
}
