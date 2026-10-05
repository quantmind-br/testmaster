export type SourceFormat =
  | "markdown"
  | "text"
  | "prd-json"
  | "pdf"
  | "openapi"
  | "graphql"
  | "postman";
export interface SourceDiagnostic {
  code: string;
  message: string;
  location?: string;
}
export interface SourceEvidenceRef {
  sourceRevisionId: string;
  relativePath?: string;
  contentHash: string;
  offset?: number;
  length?: number;
  page?: number;
  jsonPointer?: string;
}
export interface SourceChunk {
  id: string;
  kind: string;
  text: string;
  contentHash: string;
  evidenceRef: SourceEvidenceRef;
  lineStart?: number;
  lineEnd?: number;
  requirementLike: boolean;
}
export interface ParsedSourceRevision {
  id: string;
  workspaceId?: string;
  contentHash: string;
  mediaType: string;
  sizeBytes: number;
  parserVersion: string;
  status: "ready" | "partial" | "needs_input" | "invalid";
  parentId: string | null;
  chunks: SourceEvidenceRef[];
}
export interface SourceParseResult {
  revision: ParsedSourceRevision;
  chunks: SourceChunk[];
  diagnostics: SourceDiagnostic[];
  inventory: Record<string, unknown>;
}
export interface SourceParseInput {
  revisionId: string;
  workspaceId?: string;
  parentId?: string | null;
  relativePath?: string;
  format: SourceFormat;
  bytes: Uint8Array;
  maxBytes?: number;
  maxPages?: number;
}
