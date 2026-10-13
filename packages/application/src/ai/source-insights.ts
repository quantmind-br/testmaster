import type { PlanStep, Requirement, TestCase } from "@testmaster/contracts";
import { canonicalJson, sha256 } from "@testmaster/domain";
import type { SourceParseResult } from "@testmaster/planner";
import { allEntities, type ServiceContext } from "../context.js";

/** Files the source intake refuses outright, shown to users as the fixed exclusion policy. */
export const SOURCE_EXCLUSION_POLICY = [
  ".env, .env.*",
  ".git/",
  "node_modules/",
  ".ssh/",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "id_rsa",
  "id_ed25519",
  "credentials",
] as const;

/** One stored revision of a source, newest first in a chain. */
export interface RevisionNode {
  id: string;
  result: SourceParseResult;
}
export interface OperationDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * Declared operations keyed by a human-readable identity with a fingerprint of their definition:
 * `METHOD /path` for OpenAPI, `Kind.field` for GraphQL, `METHOD name` for Postman requests.
 */
export function operationFingerprints(result: SourceParseResult): Map<string, string> {
  const out = new Map<string, string>();
  const operations = Array.isArray(result.inventory.operations) ? result.inventory.operations : [];
  for (const raw of operations as Record<string, unknown>[]) {
    if (typeof raw.path === "string" && typeof raw.method === "string")
      out.set(`${raw.method} ${raw.path}`, sha256(canonicalJson(raw.operation ?? null)));
    else if (typeof raw.kind === "string" && Array.isArray(raw.fields))
      for (const field of raw.fields) out.set(`${raw.kind}.${String(field)}`, sha256(""));
  }
  const requests = Array.isArray(result.inventory.requests) ? result.inventory.requests : [];
  for (const raw of requests as Record<string, unknown>[]) {
    const request = (raw.request ?? {}) as { method?: unknown };
    out.set(
      `${typeof request.method === "string" ? request.method : "GET"} ${String(raw.name ?? "request")}`,
      sha256(canonicalJson(request)),
    );
  }
  return out;
}

export function diffOperations(
  from: ReadonlyMap<string, string>,
  to: ReadonlyMap<string, string>,
): OperationDiff {
  return {
    added: [...to.keys()].filter((key) => !from.has(key)).sort(),
    removed: [...from.keys()].filter((key) => !to.has(key)).sort(),
    changed: [...to.keys()].filter((key) => from.has(key) && from.get(key) !== to.get(key)).sort(),
  };
}

export function flattenSteps(steps: readonly PlanStep[]): PlanStep[] {
  return steps.flatMap((step) => [
    step,
    ...(step.operation === "frame" ? flattenSteps(step.input.childSteps) : []),
  ]);
}

/** `{param}` template segments match any literal; a test segment it could not resolve matches anything. */
export function pathMatches(template: string, path: string): boolean {
  const left = template.split("/");
  const right = path.split("/");
  return (
    left.length === right.length &&
    left.every(
      (part, index) =>
        /^\{[^}]+\}$/u.test(part) || right[index] === "{unknown}" || part === right[index],
    )
  );
}

export function requestPath(step: Extract<PlanStep, { operation: "request" }>): string {
  return `/${step.input.pathSegments
    .map((value) => ("literal" in value ? String(value.literal) : "{unknown}"))
    .join("/")}`;
}

/**
 * Active tests that may rest on something the newest revision changed or removed. Detection is
 * deliberately conservative and explains itself: it lists reasons, never a verdict.
 */
export function staleTestsFor(
  ctx: ServiceContext,
  projectId: string,
  chain: readonly RevisionNode[],
): { testId: string; name: string; revisionId: string; reasons: string[] }[] {
  const active = chain[0];
  if (!active || chain.length < 2) return [];
  const older = chain.slice(1);
  const olderIds = new Set(older.map((node) => node.id));
  const activeOperations = operationFingerprints(active.result);
  const requirements = new Map(
    (allEntities(ctx, "Requirement") as unknown as Requirement[])
      .filter((item) => item.extensions?.["testmaster:projectId"] === projectId)
      .map((item) => [item.id, item]),
  );
  const stale: { testId: string; name: string; revisionId: string; reasons: string[] }[] = [];
  for (const test of allEntities(ctx, "TestCase") as unknown as TestCase[]) {
    if (test.projectId !== projectId || test.archivedAt || !test.activeRevisionId) continue;
    const revision = ctx.entities.get("TestRevision", ctx.workspaceId, test.activeRevisionId);
    const plan = revision?.plan as { requirementRefs: string[]; steps: PlanStep[] } | null;
    if (!plan) continue;
    const reasons: string[] = [];
    const cited = new Set<string>();
    for (const ref of plan.requirementRefs)
      for (const origin of requirements.get(ref)?.sourceRefs ?? [])
        if (origin.sourceRevisionId && olderIds.has(origin.sourceRevisionId)) {
          cited.add(origin.sourceRevisionId);
          reasons.push("requirement_cites_superseded_revision");
        }
    const steps = flattenSteps(plan.steps);
    for (const step of steps)
      if (
        step.operation === "assert" &&
        step.expectation.predicate === "jsonSchema" &&
        olderIds.has(step.expectation.sourceRevisionId)
      ) {
        cited.add(step.expectation.sourceRevisionId);
        reasons.push("assertion_cites_superseded_revision");
      }
    // Compare against the oldest revision the test cites, else only the latest change.
    const basis = older.filter((node) => cited.has(node.id)).at(-1) ?? older[0];
    const changes = diffOperations(
      operationFingerprints((basis as RevisionNode).result),
      activeOperations,
    );
    for (const step of steps) {
      if (step.operation !== "request") continue;
      const path = requestPath(step);
      const touched = (keys: string[]) =>
        keys.find((key) => {
          const [method, template] = key.split(/ (.+)/u);
          return method === step.input.method && pathMatches(template ?? "", path);
        });
      const removed = touched(changes.removed);
      const changed = touched(changes.changed);
      if (removed) reasons.push(`endpoint_removed: ${removed}`);
      else if (changed) reasons.push(`endpoint_changed: ${changed}`);
    }
    if (reasons.length)
      stale.push({
        testId: test.id,
        name: test.name,
        revisionId: test.activeRevisionId,
        reasons: [...new Set(reasons)],
      });
  }
  return stale;
}
