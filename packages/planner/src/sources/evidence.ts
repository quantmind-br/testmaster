import { ContractError, type ValidationIssue } from "@testmaster/contracts";
import { canonicalJson } from "@testmaster/domain";
import type { SourceEvidenceRef } from "./types.js";

/**
 * Opaque per-request citation handles. Models cite `E<n>` instead of copying evidence objects,
 * so hashes and locators persisted with outputs always come from supplied evidence.
 */
export class EvidenceCatalog {
  private readonly byHandle = new Map<string, SourceEvidenceRef>();
  private readonly byRef = new Map<string, string>();
  constructor(refs: Iterable<SourceEvidenceRef>) {
    for (const ref of refs) {
      const key = canonicalJson(ref);
      if (this.byRef.has(key)) continue;
      const handle = `E${this.byHandle.size + 1}`;
      this.byHandle.set(handle, ref);
      this.byRef.set(key, handle);
    }
  }
  get refs(): SourceEvidenceRef[] {
    return [...this.byHandle.values()];
  }
  /** Handle for supplied evidence; unknown evidence is a programming error, not model output. */
  handle(ref: SourceEvidenceRef): string {
    const handle = this.byRef.get(canonicalJson(ref));
    if (!handle) throw new Error("Evidence is not part of this catalog");
    return handle;
  }
  handles(refs: SourceEvidenceRef[]): string[] {
    return [...new Set(refs.map((ref) => this.handle(ref)))];
  }
  /**
   * Resolves model citations; any unknown handle rejects the whole output. With `path`, the error
   * carries one issue per unknown handle (indexed in `handles`); the message never names the handle.
   */
  resolve(handles: string[], message: string, path?: string): SourceEvidenceRef[] {
    const refs = new Map<string, SourceEvidenceRef>();
    const issues: ValidationIssue[] = [];
    for (const [index, handle] of handles.entries()) {
      const ref = this.byHandle.get(handle);
      if (ref) refs.set(handle, ref);
      else if (path === undefined) throw new ContractError("INVALID_ARGUMENT", message);
      else issues.push({ path: `${path}/${index}`, rule: "evidenceGrounding", message });
    }
    if (issues.length) throw new ContractError("INVALID_ARGUMENT", message, {}, issues);
    return [...refs.values()];
  }
}
