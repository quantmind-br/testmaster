import { ContractError } from "@testmaster/contracts";
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
  /** Resolves model citations; any unknown handle rejects the whole output. */
  resolve(handles: string[], message: string): SourceEvidenceRef[] {
    return [...new Set(handles)].map((handle) => {
      const ref = this.byHandle.get(handle);
      if (!ref) throw new ContractError("INVALID_ARGUMENT", message);
      return ref;
    });
  }
}
