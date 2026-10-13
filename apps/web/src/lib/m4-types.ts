/**
 * Response shapes of the onboarding, source, discovery, requirement and feature-map routes. They
 * mirror `packages/contracts/src/m4/*.ts`; the portal does not depend on the contracts package, and
 * the portal journeys exercise every field below against the real server.
 */

export const onboardingSteps = [
  "mode",
  "project",
  "source",
  "target",
  "runner",
  "environment",
  "reachability",
  "generate",
  "result",
] as const;
export type OnboardingStep = (typeof onboardingSteps)[number];

export type NetworkProfile = "public" | "private" | "local-loopback";
export type Consent = "granted" | "declined";

export interface OnboardingChoices {
  mode?: "local" | "server";
  sourceIds?: string[];
  target?: {
    baseUrl: string;
    networkProfile: NetworkProfile;
    appType?: string;
    port?: number;
    prepareCommands?: string[];
  };
  environmentId?: string;
  authSecretRefs?: string[];
  consents?: { scan?: Consent; load?: Consent; security?: Consent; tunnel?: Consent };
  generation?: { mode: "proposals" | "manual" };
  resultRunId?: string;
}

export interface OnboardingState {
  projectId: string;
  principalId: string;
  version: number;
  saved: boolean;
  currentStep: OnboardingStep;
  completedSteps: OnboardingStep[];
  choices: OnboardingChoices;
  history: { at: string; step: OnboardingStep; event: string; changed: string[] }[];
  updatedAt: string | null;
  intake: {
    uploadsAllowed: boolean;
    maxSourceBytes: number;
    formats: string[];
    offline: boolean;
    modelConfigured: boolean;
  };
}

export interface PrerequisiteCheck {
  id: "runner" | "auth" | "policy" | "target";
  status: "passed" | "failed" | "not_checked";
  reasonCode: string | null;
  diagnostic: string | null;
  message: string;
  nextAction: string | null;
}
export interface PrerequisiteReport {
  projectId: string;
  checkedAt: string;
  ready: boolean;
  checks: PrerequisiteCheck[];
}

export interface SourceOverview {
  ownerId: string | null;
  revisionCount: number;
  active: {
    id: string;
    ordinal: number;
    contentHash: string;
    mediaType: string;
    sizeBytes: number;
    parserVersion: string;
    status: "ready" | "partial" | "needs_input" | "invalid";
    importedAt: string | null;
    importedBy: string | null;
  };
  origin: { kind: "local-file" | "upload"; path: string | null; state: string };
  dependents: { staleTests: number; supersededRequirementRefs: number };
  diagnostics: number;
  processedChunks: number;
}
export interface SourceListItem {
  id: string;
  projectId: string;
  role: string;
  displayName: string;
  origin: string;
  activeRevisionId: string | null;
  version: number;
  createdAt: string;
  overview: SourceOverview;
}
export interface RevisionView {
  id: string;
  ordinal: number;
  parentId: string | null;
  contentHash: string;
  mediaType: string;
  sizeBytes: number;
  parserVersion: string;
  status: SourceOverview["active"]["status"];
  active: boolean;
  importedAt: string | null;
  importedBy: string | null;
  chunkCount: number;
  chunksTruncated: boolean;
  chunks: {
    hash: string;
    kind: string;
    text: string;
    textTruncated: boolean;
    requirementLike: boolean;
  }[];
  diagnosticCount: number;
  diagnostics: { code: string; message: string; location: string | null }[];
  operationCount: number | null;
  changes: {
    comparedTo: string;
    operations: { added: string[]; removed: string[]; changed: string[] };
    chunksAdded: number;
    chunksRemoved: number;
  } | null;
}
export interface SourceHistory {
  id: string;
  version: number;
  projectId: string;
  role: string;
  displayName: string;
  createdAt: string;
  archivedAt: string | null;
  overview: SourceOverview;
  exclusions: { policy: string[]; unsupported: string[]; discovery: string[] };
  revisions: RevisionView[];
  staleTests: { testId: string; name: string; revisionId: string; reasons: string[] }[];
}

export interface DiscoverySummary {
  id: string;
  createdAt: string;
  projectId: string;
  phase: string;
  scope: "codebase" | "diff";
  baseSha: string | null;
  headSha: string | null;
  includesWorkingTree: boolean;
  status: "partial" | "needs_input" | "unreachable";
  counts: {
    scannedFiles: number;
    skippedFiles: number;
    endpoints: number;
    routes: number;
    features: number;
    warnings: number;
  };
  sourceRevisionIds: string[];
}

interface CodeRef {
  path: string;
  line: number;
}
interface CodeRoute {
  framework: string;
  method: string;
  path: string;
  ref: CodeRef;
}
export interface DiscoveryDetail {
  job: { id: string; phase: string; createdAt: string };
  codeSnapshot: {
    baseSha: string | null;
    headSha: string | null;
    excludes: string[];
    skippedFiles?: { path: string; reason: string }[];
  };
  summary: {
    coverage: string;
    techStack: { name: string }[];
    routes: CodeRoute[];
    endpoints: CodeRoute[];
    scannedFiles: string[];
    skippedFiles: { path: string; reason: string }[];
    warnings: { path: string; code: string; message: string }[];
  };
  diff: {
    baseSha: string;
    headSha: string;
    mergeBase: string;
    includeWorkingTree: boolean;
    changes: { status: string; path: string; previousPath?: string }[];
    impact: {
      criticalSmoke: boolean;
      authTouched: boolean;
      selectedFiles: string[];
      excludedFiles: { path: string; reason: string }[];
      gaps: string[];
    };
  } | null;
  featureMap: {
    features: { id: string; stableKey: string; routeRefs: string[]; endpointRefs: string[] }[];
    status: string;
  };
  status: DiscoverySummary["status"];
  warnings: string[];
}

export interface Origin {
  sourceRevisionId: string;
  sourceId: string | null;
  sourceName: string | null;
  revisionOrdinal: number | null;
  current: boolean;
  revisionHash: string | null;
  spanHash: string | null;
  ref: {
    relativePath?: string;
    offset?: number;
    length?: number;
    page?: number;
    jsonPointer?: string;
  };
  excerpt: string | null;
}
export interface RequirementChange {
  at: string;
  kind: string;
  actorId: string;
  requirementId: string | null;
  requirementKey: string | null;
  before: string | null;
  after: string | null;
  note: string | null;
  sourceRevisionIds: string[];
}
export interface RequirementReview {
  id: string;
  projectId: string;
  version: number;
  fingerprint: string;
  requirements: {
    id: string;
    version: number;
    key: string | null;
    text: string;
    acceptanceCriteria: string[];
    originKind: string;
    confidence: number | null;
    approval: string | null;
    reason: string | null;
    origins: Origin[];
    conflictIds: string[];
    supersededOrigin: boolean;
  }[];
  conflicts: {
    id: string;
    reason: string;
    requirementIds: string[];
    origins: Origin[];
    resolution: { selectedRequirementId: string; reason: string; actorId: string } | null;
  }[];
  openQuestions: string[];
  changes: RequirementChange[];
}

export type Coverage = "no_tests" | "tests_without_valid_run" | "valid_run";
export interface FeatureCoverageMap {
  id: string;
  projectId: string;
  generatedAt: string;
  discovery: {
    id: string;
    createdAt: string;
    status: string;
    scope: string;
    baseSha: string | null;
    headSha: string | null;
  } | null;
  rows: {
    key: string;
    kind: "requirement" | "endpoint" | "route" | "component" | "desired";
    title: string;
    requirementIds: string[];
    sources: {
      sourceId: string | null;
      sourceName: string | null;
      revisionId: string;
      current: boolean;
    }[];
    endpoints: string[];
    routes: string[];
    files: string[];
    tests: {
      testId: string;
      name: string;
      revisionId: string;
      revisionOrdinal: number;
      via: string;
    }[];
    evidence: {
      runId: string;
      testId: string;
      revisionId: string;
      status: string;
      outcome: string | null;
      valid: boolean;
      createdAt: string;
    }[];
    coverage: Coverage;
  }[];
  truncated: boolean;
  summary: { noTests: number; testsWithoutValidRun: number; validRun: number };
  limitations: string[];
}

export interface ProjectRef {
  id: string;
  name: string;
  slug: string;
  defaultEnvironmentId: string | null;
}
export interface EnvironmentRef {
  id: string;
  name: string;
  archivedAt: string | null;
}
export interface SecretRef {
  id: string;
  name?: string;
  provider?: string;
  locator?: string;
  revokedAt: string | null;
}
