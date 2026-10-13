import type { FeatureCoverageMap, PlanStep, Requirement, TestCase } from "@testmaster/contracts";
import type { EntityDocument } from "@testmaster/persistence";
import type { DiscoveryService } from "./ai/discovery.js";
import type { RequirementsService } from "./ai/requirements.js";
import { flattenSteps, pathMatches, requestPath } from "./ai/source-insights.js";
import type { SourcesService } from "./ai/sources.js";
import { allEntities, requireEntity, type ServiceContext } from "./context.js";

const MAX_ROWS = 500;
const MAX_EVIDENCE = 20;
const OPERATION_POINTER = /^\/paths\/(.+)\/(get|put|post|delete|options|head|patch|trace)$/u;
const LIMITATIONS = [
  "Links are structural: a test is linked through a requirement it cites or an endpoint or page it exercises, not through proof that it verifies the behavior.",
  "Code discovery is static and partial; routes, endpoints and components it did not find are not listed.",
  "Only a Run that reached a verdict (passed or failed) on the test's current revision counts as evidence.",
] as const;

type Row = FeatureCoverageMap["rows"][number];
interface LinkedTest {
  test: TestCase;
  revisionId: string;
  ordinal: number;
  requirementRefs: readonly string[];
  requests: { method: string; path: string }[];
  navigations: string[];
}

const unescapePointer = (value: string) => value.replaceAll("~1", "/").replaceAll("~0", "~");

/**
 * Coverage view for a project: requirements and discovered features, the sources behind them, the
 * tests that exercise them and the Runs that count as evidence. Absence is shown as absence.
 */
export class FeatureMapService {
  constructor(
    readonly ctx: ServiceContext,
    readonly requirements: RequirementsService,
    readonly sources: SourcesService,
    readonly discovery: DiscoveryService,
  ) {}
  get(projectId: string): FeatureCoverageMap {
    this.ctx.authorize("R", projectId);
    requireEntity(this.ctx, "Project", projectId);
    const snapshot = this.requirements.snapshot(projectId);
    const tests = this.tests(projectId);
    const runsByRevision = new Map<string, EntityDocument[]>();
    for (const run of allEntities(this.ctx, "Run")) {
      const list = runsByRevision.get(String(run.revisionId)) ?? [];
      list.push(run);
      runsByRevision.set(String(run.revisionId), list);
    }
    const latest = this.discovery.list(projectId)[0];
    const detail = latest ? this.discovery.get(latest.id) : null;
    const rows: Row[] = [];
    const sourceOf = (revisionId: string): Row["sources"][number] | null => {
      const where = this.sources.locate(revisionId, projectId);
      return where
        ? {
            sourceId: where.sourceId,
            sourceName: where.sourceName,
            revisionId,
            current: where.current,
          }
        : null;
    };
    const finish = (
      row: Omit<Row, "tests" | "evidence" | "coverage">,
      linked: Map<string, { entry: LinkedTest; via: Row["tests"][number]["via"] }>,
    ): Row => {
      const evidence = [...linked.values()]
        .flatMap(({ entry }) =>
          (runsByRevision.get(entry.revisionId) ?? []).map((run) => ({
            runId: run.id,
            testId: entry.test.id,
            revisionId: entry.revisionId,
            status: String(run.status),
            outcome: run.outcome ? String(run.outcome) : null,
            valid: run.outcome === "passed" || run.outcome === "failed",
            createdAt: String(run.createdAt),
          })),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId))
        .slice(0, MAX_EVIDENCE);
      return {
        ...row,
        tests: [...linked.values()].map(({ entry, via }) => ({
          testId: entry.test.id,
          name: entry.test.name,
          revisionId: entry.revisionId,
          revisionOrdinal: entry.ordinal,
          via,
        })),
        evidence,
        coverage: !linked.size
          ? "no_tests"
          : evidence.some((item) => item.valid)
            ? "valid_run"
            : "tests_without_valid_run",
      };
    };
    const link = (
      map: Map<string, { entry: LinkedTest; via: Row["tests"][number]["via"] }>,
      entry: LinkedTest,
      via: Row["tests"][number]["via"],
    ) => {
      if (!map.has(entry.test.id)) map.set(entry.test.id, { entry, via });
    };

    const hashesWithRequirement = new Set<string>();
    const operationsByRequirement = new Map<string, string[]>();
    for (const item of snapshot.requirements as Requirement[]) {
      const endpoints: string[] = [];
      for (const ref of item.sourceRefs) {
        if (ref.contentHash) hashesWithRequirement.add(ref.contentHash);
        const match = ref.jsonPointer ? OPERATION_POINTER.exec(ref.jsonPointer) : null;
        if (match?.[1] && match[2])
          endpoints.push(`${match[2].toUpperCase()} ${unescapePointer(match[1])}`);
      }
      operationsByRequirement.set(item.id, [...new Set(endpoints)]);
      const linked = new Map<string, { entry: LinkedTest; via: Row["tests"][number]["via"] }>();
      for (const entry of tests) {
        if (entry.requirementRefs.includes(item.id)) link(linked, entry, "requirement");
        else if (endpoints.some((endpoint) => requestMatches(entry, endpoint)))
          link(linked, entry, "request");
      }
      const origins = new Map<string, Row["sources"][number]>();
      for (const ref of item.sourceRefs) {
        if (!ref.sourceRevisionId || origins.has(ref.sourceRevisionId)) continue;
        const origin = sourceOf(ref.sourceRevisionId);
        if (origin) origins.set(ref.sourceRevisionId, origin);
      }
      const key = item.extensions?.["testmaster:key"];
      rows.push(
        finish(
          {
            key: `requirement:${item.id}`,
            kind: "requirement",
            title: typeof key === "string" ? `${key}: ${item.text}` : item.text,
            requirementIds: [item.id],
            sources: [...origins.values()],
            endpoints: operationsByRequirement.get(item.id) ?? [],
            routes: [],
            files: [],
          },
          linked,
        ),
      );
    }

    for (const feature of detail?.featureMap.features ?? []) {
      const [kind, ...rest] = feature.stableKey.split(":");
      if (kind !== "route" && kind !== "endpoint" && kind !== "component" && kind !== "desired")
        continue;
      if (kind === "desired" && hashesWithRequirement.has(rest.join(":"))) continue;
      const method = kind === "route" || kind === "endpoint" ? (rest[0] ?? "") : "";
      const path = kind === "route" || kind === "endpoint" ? rest.slice(1).join(":") : "";
      const declared = `${method} ${path}`;
      const requirementIds = (snapshot.requirements as Requirement[])
        .filter((item) =>
          (operationsByRequirement.get(item.id) ?? []).some((endpoint) =>
            endpointMatches(endpoint, declared),
          ),
        )
        .map((item) => item.id);
      const files = detail
        ? [...detail.summary.routes, ...detail.summary.endpoints]
            .filter((route) => route.method === method && route.path === path)
            .map((route) => route.ref.path)
        : [];
      const linked = new Map<string, { entry: LinkedTest; via: Row["tests"][number]["via"] }>();
      for (const entry of tests) {
        if (requirementIds.some((id) => entry.requirementRefs.includes(id)))
          link(linked, entry, "requirement");
        else if (kind === "endpoint" && requestMatches(entry, declared))
          link(linked, entry, "request");
        else if (kind === "route" && entry.navigations.some((nav) => pathMatches(path, nav)))
          link(linked, entry, "navigation");
      }
      const title =
        kind === "component"
          ? rest.slice(1).join(":") || feature.stableKey
          : kind === "desired"
            ? `Desired statement ${rest.join(":").slice(0, 8)}`
            : declared;
      rows.push(
        finish(
          {
            key: feature.stableKey,
            kind,
            title,
            requirementIds,
            sources: [],
            endpoints: feature.endpointRefs as string[],
            routes: feature.routeRefs as string[],
            files: kind === "component" ? [rest[0] ?? ""] : [...new Set(files)],
          },
          linked,
        ),
      );
    }

    const shown = rows.slice(0, MAX_ROWS);
    return {
      id: projectId,
      projectId,
      generatedAt: new Date().toISOString(),
      discovery:
        latest && detail
          ? {
              id: latest.id,
              createdAt: latest.createdAt,
              status: latest.status,
              scope: latest.scope,
              baseSha: latest.baseSha,
              headSha: latest.headSha,
            }
          : null,
      rows: shown,
      truncated: rows.length > MAX_ROWS,
      summary: {
        noTests: shown.filter((row) => row.coverage === "no_tests").length,
        testsWithoutValidRun: shown.filter((row) => row.coverage === "tests_without_valid_run")
          .length,
        validRun: shown.filter((row) => row.coverage === "valid_run").length,
      },
      limitations: [
        ...(latest
          ? []
          : ["No code discovery has run for this project, so only requirements are listed."]),
        ...LIMITATIONS,
      ],
    };
  }
  private tests(projectId: string): LinkedTest[] {
    const out: LinkedTest[] = [];
    for (const test of allEntities(this.ctx, "TestCase") as unknown as TestCase[]) {
      if (test.projectId !== projectId || test.archivedAt || !test.activeRevisionId) continue;
      const revision = this.ctx.entities.get(
        "TestRevision",
        this.ctx.workspaceId,
        test.activeRevisionId,
      );
      const plan = revision?.plan as
        | { requirementRefs: string[]; steps: PlanStep[] }
        | null
        | undefined;
      if (!revision || !plan) continue;
      const steps = flattenSteps(plan.steps);
      out.push({
        test,
        revisionId: revision.id,
        ordinal: Number(revision.ordinal ?? 1),
        requirementRefs: plan.requirementRefs,
        requests: steps.flatMap((step) =>
          step.operation === "request"
            ? [{ method: step.input.method, path: requestPath(step) }]
            : [],
        ),
        navigations: steps.flatMap((step) =>
          step.operation === "navigate" ? [step.input.path.split(/[?#]/u)[0] ?? ""] : [],
        ),
      });
    }
    return out;
  }
}

/** `GET /orders/{id}` matches a request step to `/orders/7` or to a path it could not resolve. */
function endpointMatches(left: string, right: string): boolean {
  const [leftMethod, leftPath] = left.split(/ (.+)/u);
  const [rightMethod, rightPath] = right.split(/ (.+)/u);
  return (
    leftMethod === rightMethod &&
    !!leftPath &&
    !!rightPath &&
    (pathMatches(leftPath, rightPath) || pathMatches(rightPath, leftPath))
  );
}
function requestMatches(entry: LinkedTest, endpoint: string): boolean {
  return entry.requests.some((request) =>
    endpointMatches(endpoint, `${request.method} ${request.path}`),
  );
}
