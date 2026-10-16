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
/** What an `include_router`/`mount` call or a router-passing call names: a local router, or a name to resolve across modules. */
export type PythonRouterReference = { router: number } | { name: string; call: boolean };
/** A FastAPI application, an `APIRouter`, or an `APIRouter` function parameter, declared in one file. */
export interface PythonRouter {
  id: number;
  kind: "app" | "router" | "parameter";
  name: string;
  line: number;
  /** `APIRouter(prefix=...)`: "" when absent, null when it is not a string literal or a literal constant. */
  prefix: string | null;
  /** Declared at module level, so another module can import it by name. */
  module: boolean;
}
export interface PythonCodeSummary {
  version: "1.1.0";
  files: {
    path: string;
    routes: {
      framework: "fastapi" | "flask";
      method: string;
      path: string;
      handler: string;
      line: number;
      /** FastAPI only: the id of the app or router the decorator is on; null for Flask or an ambiguous name. */
      router: number | null;
    }[];
    routers: PythonRouter[];
    /** `parent.include_router(child, prefix=...)` and `parent.mount(path, child)`; `prefix` is null when unresolved. */
    includes: {
      parent: number;
      child: PythonRouterReference;
      prefix: string | null;
      line: number;
    }[];
    /** Calls that pass a router of this file as an argument (`register_routes(router, ...)`). */
    calls: {
      callee: string;
      arguments: { router: number; index: number | null; keyword: string | null }[];
      line: number;
    }[];
    /** Module-level functions that return a router or take an `APIRouter` parameter. */
    functions: {
      name: string;
      parameters: string[];
      routerParameters: Record<string, number>;
      returns: number[];
    }[];
    /** Import bindings that composition refers to (every import of a package `__init__.py`). */
    imports: { local: string; module: string; name: string | null; level: number }[];
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
  /** Symbols kept per file (default 200); the rest are dropped and declared by `symbols_truncated`. */
  maxSymbolsPerFile?: number;
  /** Symbols kept per run (default 20000); the rest are dropped and declared by `symbols_truncated`. */
  maxSymbols?: number;
  /**
   * Repository-relative files to read. Other files are neither read nor listed; directories that
   * contain none of them are not entered. Exclusion, type and size rules still apply to each.
   */
  only?: readonly string[];
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
