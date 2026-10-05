export interface CodeRef {
  path: string;
  contentHash: string;
  line: number;
}
export interface CodeRoute {
  framework: string;
  method: string;
  path: string;
  handler?: string;
  ref: CodeRef;
}
export interface CodeSymbol {
  name: string;
  kind: string;
  ref: CodeRef;
}
export interface PythonCodeSummary {
  version: "1.0.0";
  files: {
    path: string;
    routes: {
      framework: "fastapi" | "flask";
      method: string;
      path: string;
      handler: string;
      line: number;
    }[];
    tests: { name: string; line: number; async: boolean }[];
    symbols: { name: string; kind: "function" | "class"; line: number }[];
  }[];
  diagnostics: { path: string; code: string; message: string }[];
}
/** Implementations execute AST-only Python inspection inside the hardened Python image. */
export interface PythonSummaryRunner {
  summarize(
    repoRoot: string,
    files: string[],
  ): Promise<
    { available: true; summary: PythonCodeSummary } | { available: false; reason: string }
  >;
}
export interface CodeSummary {
  detectorVersion: string;
  manifestHash: string;
  coverage: "partial";
  techStack: { name: string; detectorVersion: string; ref: CodeRef }[];
  entrypoints: CodeRef[];
  features: CodeSymbol[];
  fileRefs: CodeRef[];
  routes: CodeRoute[];
  endpoints: CodeRoute[];
  schemas: CodeSymbol[];
  externalServices: { url: string; ref: CodeRef }[];
  authPatterns: CodeRef[];
  testHooks: { name: string; ref: CodeRef }[];
  existingTests: CodeSymbol[];
  symbols: CodeSymbol[];
  imports: { source: string; ref: CodeRef }[];
  warnings: { path: string; code: string; message: string }[];
  scannedFiles: string[];
  skippedFiles: { path: string; reason: string }[];
}
export interface CodeSummaryOptions {
  excludes?: string[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
  pythonRunner?: PythonSummaryRunner;
}
export interface CodeDiff {
  baseSha: string;
  headSha: string;
  mergeBase: string;
  includeWorkingTree: boolean;
  dirtyHash: string | null;
  changes: { status: string; path: string; previousPath?: string }[];
  impact: {
    coverage: "partial";
    criticalSmoke: boolean;
    authTouched: boolean;
    selectedFiles: string[];
    excludedFiles: { path: string; reason: string }[];
    routes: CodeRoute[];
    components: CodeSymbol[];
    gaps: string[];
  };
  fingerprint: string;
}
