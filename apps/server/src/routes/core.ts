import { Readable } from "node:stream";
import type { Application, ArtifactStream } from "@testmaster/application";
import {
  type BatchRequest,
  ContractError,
  type RunRequest,
  type TestRevisionInput,
  validateDocument,
} from "@testmaster/contracts";
import { abortOnDisconnect } from "./authoring.js";
import type { RouteContext, RouteHandler, RouteModule } from "./types.js";

interface Call extends Omit<RouteContext, "body" | "query"> {
  app: Application;
  id: string;
  body: Record<string, unknown>;
  query: Record<string, string>;
  /** Idempotency key; empty for routes that do not require one. */
  key: string;
}
const h =
  (fn: (call: Call) => unknown): RouteHandler =>
  (context) =>
    fn({
      ...context,
      app: context.service,
      id: context.params.id ?? "",
      body: (context.body ?? {}) as Record<string, unknown>,
      query: context.query as Record<string, string>,
      key: context.idempotencyKey ?? "",
    });
function singleRange(header: string | undefined): RegExpExecArray | null {
  const range = header ? /^bytes=(\d+)-(\d+)$/.exec(header) : null;
  if (header && !range)
    throw new ContractError("INVALID_ARGUMENT", "Only a single explicit byte range is supported");
  return range;
}
const handlers: Record<string, RouteHandler> = {
  "GET /health/live": h(() => ({ status: "alive" })),
  "GET /health/ready": h(async ({ app, reply, request }) => {
    const result = await app.readiness();
    return reply
      .code(result.status === "ready" ? 200 : 503)
      .send({ schemaVersion: "1.0.0", requestId: request.id, data: result, warnings: [] });
  }),
  "GET /capabilities": h(({ app }) => app.capabilities()),
  "POST /contracts/validate": h(({ body }) => validateDocument(String(body.schema), body.document)),
  "GET /projects": h(({ app, page }) => page(app.projects.list())),
  "POST /projects": h(({ app, body }) => {
    if (body.workspaceId && body.workspaceId !== app.context.workspaceId)
      throw new ContractError("FORBIDDEN", "Workspace mismatch");
    return app.projects.create({ name: body.name as string });
  }),
  "GET /projects/{id}": h(({ app, id }) => app.projects.get(id)),
  "PATCH /projects/{id}": h(({ app, id, body, ifMatch }) => {
    const { workspaceId, ...patch } = body;
    if (workspaceId && workspaceId !== app.context.workspaceId)
      throw new ContractError("FORBIDDEN", "Workspace mismatch");
    return app.projects.update(id, patch, ifMatch());
  }),
  "POST /projects/{id}/archive": h(({ app, id, ifMatch }) => app.projects.archive(id, ifMatch())),
  "GET /projects/{id}/environments": h(({ app, id, page }) => page(app.environments.list(id))),
  "POST /projects/{id}/environments": h(({ app, id, body }) =>
    app.environments.create({ projectId: id, ...body } as Parameters<
      typeof app.environments.create
    >[0]),
  ),
  "GET /environments/{id}": h(({ app, id }) => app.environments.get(id)),
  "PATCH /environments/{id}": h(({ app, id, body, ifMatch }) =>
    app.environments.update(id, body, ifMatch()),
  ),
  "DELETE /environments/{id}": h(({ app, id, ifMatch }) => app.environments.archive(id, ifMatch())),
  "POST /projects/{id}/default-environment": h(({ app, id, body, ifMatch }) =>
    app.environments.setDefault(id, body.environmentId as string, ifMatch()),
  ),
  "GET /secrets": h(({ app, page }) => page(app.secrets.list())),
  "POST /secrets": h(({ app, body, key }) => {
    if (typeof body.value !== "string")
      throw new ContractError("INVALID_ARGUMENT", "Secret value is required");
    return app.secrets.set(body.name as string, body.value, {
      allowedOrigins: body.allowedOrigins as string[],
      idempotencyKey: key,
    });
  }),
  "DELETE /secrets/{id}": h(({ app, id, key }) => app.secrets.remove(id, key)),
  "GET /projects/{id}/tests": h(({ app, id, query, page }) =>
    page(
      app.tests
        .list(id)
        .filter(
          (test) =>
            (!query.type ||
              app.revisions.get(String(test.activeRevisionId)).plan?.type === query.type) &&
            (!query.priority || test.priority === query.priority) &&
            (!query.tag || test.tags.includes(query.tag)),
        ),
    ),
  ),
  "POST /projects/{id}/tests": h(({ app, id, body, key }) => {
    const input = body as TestRevisionInput;
    if ("codeRef" in input) {
      if (input.origin !== "imported")
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Code references must retain imported provenance",
        );
      return app.codeImport
        .createTestFromReference({ projectId: id, codeRef: input.codeRef, idempotencyKey: key })
        .then((result) => result.test);
    }
    if (input.origin !== "manual")
      throw new ContractError("INVALID_ARGUMENT", "Only manual plans may be authored directly");
    return app.tests.create({
      projectId: id,
      plan: input.plan,
      ...(input.justification ? { justification: input.justification } : {}),
    });
  }),
  "GET /tests/{id}": h(({ app, id }) => app.tests.get(id)),
  "PATCH /tests/{id}": h(({ app, id, body, ifMatch }) => app.tests.update(id, body, ifMatch())),
  "DELETE /tests/{id}": h(({ app, id, ifMatch }) => app.tests.archive(id, ifMatch())),
  "GET /tests/{id}/revisions": h(({ app, id, page }) => page(app.revisions.list(id))),
  "POST /tests/{id}/revisions": h(({ app, id, body, key }) => {
    const input = body as TestRevisionInput;
    if ("codeRef" in input) {
      if (input.origin !== "imported")
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Code references must retain imported provenance",
        );
      return app.codeImport.createRevision(id, input.codeRef, input.parentId, key);
    }
    if (input.origin !== "manual")
      throw new ContractError("INVALID_ARGUMENT", "Only manual plans may be authored directly");
    return app.revisions.create(id, input.plan, input.parentId, {
      ...(input.justification ? { justification: input.justification } : {}),
    });
  }),
  "POST /tests/{id}/promote": h(({ app, id, body, ifMatch }) => {
    const current = app.tests.get(id);
    if (current.activeRevisionId !== body.expectedActiveRevisionId)
      throw new ContractError("REVISION_CONFLICT", "Active revision changed");
    const rev = app.revisions.get(body.revisionId as string);
    if (rev.testId !== id)
      throw new ContractError("INVALID_ARGUMENT", "Revision belongs to another test");
    return app.revisions.promote(rev.id, ifMatch());
  }),
  "POST /runs": h(({ app, body, key }) =>
    app.runs.admit({ ...body, origin: "api" } as RunRequest, { idempotencyKey: key }),
  ),
  "GET /runs": h(({ app, query, pageFrom }) =>
    pageFrom((position) =>
      app.runs.stream(
        {
          ...(query.testId ? { testId: query.testId } : {}),
          ...(query.batchId ? { batchId: query.batchId } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.since ? { since: query.since } : {}),
          ...(query.projectId ? { projectId: query.projectId } : {}),
        },
        position,
      ),
    ),
  ),
  "GET /runs/{id}": h(({ app, id }) => app.runs.get(id)),
  "POST /runs/{id}/cancel": h(({ app, id }) => app.runs.cancel(id)),
  "POST /runs/{id}/rerun": h(({ app, id, body, key }) =>
    app.runs.rerun(id, { ...body, idempotencyKey: key } as Parameters<typeof app.runs.rerun>[1]),
  ),
  "GET /runs/{id}/steps": h(({ app, id, query, page }) =>
    page(app.runs.steps(id, query.attemptId)),
  ),
  "GET /runs/{id}/bundle": h(({ app, id, query }) =>
    app.artifacts.get(id, query.attemptId ? { attemptId: query.attemptId } : {}),
  ),
  "POST /batches": h(({ app, body, key }) =>
    app.batches.admit(body as BatchRequest, { idempotencyKey: key }),
  ),
  "GET /batches/{id}": h(({ app, id }) => app.batches.get(id)),
  "POST /batches/{id}/cancel": h(({ app, id }) => {
    const batch = app.batches.get(id);
    return {
      batchId: id,
      members: (batch.memberRuns as string[]).map((runId) => app.runs.cancel(runId)),
    };
  }),
  "GET /artifacts/{id}": h(async ({ app, id, request, reply }) => {
    const header = request.headers.range;
    const range = singleRange(header);
    const artifact: ArtifactStream = await app.artifacts.stream(
      id,
      range ? { range: { start: Number(range[1]), end: Number(range[2]) } } : {},
    );
    const filename = `artifact-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.bin`;
    reply
      .header("ETag", `"${artifact.entry.sha256}"`)
      .header("Accept-Ranges", "bytes")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, no-store")
      .header(
        "Content-Security-Policy",
        "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      )
      .type(artifact.entry.mimeType);
    if (header)
      reply
        .code(206)
        .header("Content-Range", `bytes ${range?.[1]}-${range?.[2]}/${artifact.entry.sizeBytes}`);
    return reply.send(Readable.from(artifact.stream));
  }),
  "POST /uploads": h(({ app, body }) =>
    app.uploads.create(body as unknown as Parameters<typeof app.uploads.create>[0]),
  ),
  "PUT /uploads/{id}/bytes": h(({ app, id, body, request }) => {
    const uploadToken = request.headers["x-upload-token"] as string | undefined;
    if (!uploadToken) throw new ContractError("FORBIDDEN", "Upload token is required");
    return app.uploads.write(id, body as unknown as AsyncIterable<Uint8Array>, uploadToken);
  }),
  "POST /uploads/{id}/complete": h(({ app, id, key }) => app.uploads.complete(id, key)),
  "GET /projects/{id}/sources": h(async ({ app, id, page }) =>
    page(await app.sources.listWithOverview(id)),
  ),
  "POST /projects/{id}/sources": h(({ app, id, body, key, ifMatch }) =>
    app.sources.add({
      projectId: id,
      ...body,
      idempotencyKey: key,
      ...(body.sourceId ? { expectedVersion: ifMatch() } : {}),
    } as Parameters<typeof app.sources.add>[0]),
  ),
  "GET /sources/{id}": h(({ app, id }) => app.sources.get(id)),
  "DELETE /sources/{id}": h(({ app, id, ifMatch }) => app.sources.archive(id, ifMatch())),
  "GET /projects/{id}/requirements": h(({ app, id }) => app.requirements.snapshot(id)),
  "PATCH /projects/{id}/requirements": h(({ app, id, body, ifMatch }) =>
    app.requirements.apply(
      id,
      body.requirements as Parameters<typeof app.requirements.apply>[1],
      ifMatch(),
    ),
  ),
  "POST /projects/{id}/discovery": h(({ app, id, body, key }) => {
    if (body.projectId !== id)
      throw new ContractError("INVALID_ARGUMENT", "Project path and request differ");
    const scope = body.scope as string[];
    if (scope.length > 1 || scope.some((value) => value !== "codebase" && value !== "diff"))
      throw new ContractError("INVALID_ARGUMENT", "Discovery scope must select codebase or diff");
    const budget = body.budget;
    if (!budget || typeof budget !== "object" || Array.isArray(budget))
      throw new ContractError("INVALID_ARGUMENT", "Discovery budget must be an object");
    const settings = budget as Record<string, unknown>;
    if (
      Object.keys(settings).some((name) => !["root", "base", "head", "workingTree"].includes(name))
    )
      throw new ContractError("INVALID_ARGUMENT", "Unsupported discovery setting");
    if (
      ["root", "base", "head"].some(
        (name) => settings[name] !== undefined && typeof settings[name] !== "string",
      ) ||
      (settings.workingTree !== undefined && typeof settings.workingTree !== "boolean")
    )
      throw new ContractError("INVALID_ARGUMENT", "Invalid discovery setting");
    return app.discovery.discover({
      projectId: id,
      sourceRevisionIds: body.sourceRevisionIds as string[],
      ...(scope[0] ? { scope: scope[0] as "codebase" | "diff" } : {}),
      ...settings,
      ...(body.inputsFingerprint ? { inputsFingerprint: body.inputsFingerprint as string } : {}),
      idempotencyKey: key,
    } as Parameters<typeof app.discovery.discover>[0]);
  }),
  "GET /discovery/{id}": h(({ app, id }) => app.discovery.get(id)),
  "POST /discovery/{id}/retry": h(({ app, id, body, key }) =>
    app.discovery.retry(id, { ...body, idempotencyKey: key }),
  ),
  "POST /discovery/{id}/cancel": h(({ app, id }) => app.discovery.cancel(id)),
  "POST /projects/{id}/proposal-batches": h(({ app, id, body, key, reply }) => {
    const scope = body.scope as string[];
    if (
      new Set(scope).size !== scope.length ||
      scope.some((type) => type !== "frontend" && type !== "backend" && type !== "integration") ||
      (scope.includes("integration") && scope.length !== 1)
    )
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Proposal scope must select integration alone or distinct frontend and/or backend types",
      );
    // Both types let the model choose per requirement; none keeps the backend default.
    const type =
      scope.length === 2
        ? "auto"
        : (scope[0] as "frontend" | "backend" | "integration" | undefined);
    const refs = body.inputRefs as { sourceRevisionId?: string }[];
    const requirementIds = refs.length
      ? app.requirements
          .list(id)
          .filter((requirement) =>
            requirement.sourceRefs.some((ref) =>
              refs.some((input) => input.sourceRevisionId === ref.sourceRevisionId),
            ),
          )
          .map((requirement) => requirement.id)
      : undefined;
    // UX-018: a client that gives up closes the connection; the model call is aborted and nothing is persisted.
    return app.proposals.generate({
      projectId: id,
      idempotencyKey: key,
      signal: abortOnDisconnect(reply),
      budget: body.budget as { deadlineMs?: number },
      ...(type ? { type } : {}),
      ...(requirementIds ? { requirementIds } : {}),
    });
  }),
  "GET /proposal-batches/{id}": h(({ app, id }) => app.proposals.detail(id)),
  "PATCH /proposals/{id}": h(({ app, id, body, ifMatch }) => {
    if (body.id !== id)
      throw new ContractError("INVALID_ARGUMENT", "Proposal identity differs from path");
    const detail = app.proposals.detail(body.batchId as string);
    const existing = detail.proposals.find((proposal) => proposal.id === id);
    if (
      !existing ||
      existing.state !== body.state ||
      JSON.stringify(existing.requirementRefs) !== JSON.stringify(body.requirementRefs) ||
      JSON.stringify(existing.evidenceRefs) !== JSON.stringify(body.evidenceRefs)
    )
      throw new ContractError("INVALID_ARGUMENT", "Only proposal plan content may be edited");
    return app.proposals.edit(id, body.plan as Parameters<typeof app.proposals.edit>[1], ifMatch());
  }),
  "POST /proposal-batches/{id}/accept": h(({ app, id, body, key, ifMatch }) => {
    const expectedVersion = ifMatch();
    if (body.expectedVersion !== expectedVersion)
      throw new ContractError("REVISION_CONFLICT", "If-Match and expectedVersion differ");
    return app.proposals.accept(id, {
      proposalIds: body.proposalIds as string[],
      expectedVersion,
      idempotencyKey: key,
      ...(body.acknowledgedDuplicates
        ? { acknowledgedDuplicates: body.acknowledgedDuplicates as string[] }
        : {}),
      ...(body.reason ? { reason: body.reason as string } : {}),
    });
  }),
  "POST /proposal-batches/{id}/reject": h(({ app, id, body, key, ifMatch }) => {
    const expectedVersion = ifMatch();
    if (body.expectedVersion !== expectedVersion)
      throw new ContractError("REVISION_CONFLICT", "If-Match and expectedVersion differ");
    return app.proposals.reject(id, {
      proposalIds: body.proposalIds as string[],
      expectedVersion,
      idempotencyKey: key,
    });
  }),
  "GET /resources": h(({ app, query, page }) => page(app.resources.list(query.runId))),
  "POST /resources/{id}/cleanup": h(({ app, id, body, key, ifMatch }) =>
    app.resources.cleanup(id, {
      ...(body.approval ? { approvalId: body.approval as string } : {}),
      ownerProof: body.ownerProof,
      expectedVersion: ifMatch(),
      idempotencyKey: key,
    }),
  ),
  "GET /usage": h(({ app, query }) =>
    app.usage.get({
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.runId ? { runId: query.runId } : {}),
      ...(query.model ? { model: query.model } : {}),
      ...(query.since ? { since: query.since } : {}),
      ...(query.until ? { until: query.until } : {}),
    }),
  ),
  "POST /projects/{id}/budget": h(({ app, id, body }) =>
    app.usage.setBudget(id, body as { tokens: number }),
  ),
  "GET /revisions/{id}/code": h(({ app, id }) => {
    const revision = app.revisions.get(id);
    return app.codeExport.export(revision.testId, {
      revisionId: id,
      format: revision.runnerKind === "pytest" ? "pytest" : "playwright",
    });
  }),
  "GET /approvals": h(({ app, page }) => page(app.approvals.list())),
  "POST /approvals": h(({ app, body }) =>
    app.approvals.create(body as unknown as Parameters<typeof app.approvals.create>[0]),
  ),
  "POST /approvals/{id}/revoke": h(({ app, id }) => app.approvals.revoke(id)),
  "GET /runs/{id}/analysis": h(({ app, id }) => {
    const analysis = app.analysis.get(id);
    if (!analysis) throw new ContractError("NOT_FOUND", "Analysis does not exist", { runId: id });
    return analysis;
  }),
  "POST /runs/{id}/analysis": h(({ app, id, body }) =>
    app.analysis.analyze(id, body as Parameters<typeof app.analysis.analyze>[1]),
  ),
  "POST /runs/{id}/healing-proposals": h(({ app, id, body }) =>
    app.healing.propose(id, body as Parameters<typeof app.healing.propose>[1]),
  ),
  "GET /healing-proposals/{id}": h(({ app, id }) => app.healing.get(id)),
  "GET /healing-proposals/{id}/review": h(({ app, id }) => app.healing.review(id)),
  "POST /healing-proposals/{id}/approve": h(({ app, id, body }) =>
    app.healing.approve(id, Number(body.expectedVersion)),
  ),
  "POST /healing-proposals/{id}/reject": h(({ app, id, body }) =>
    app.healing.reject(id, String(body.reason)),
  ),
  "GET /tests/{id}/quarantine": h(({ app, id }) => {
    const record = app.quarantine.get(id);
    if (!record) throw new ContractError("NOT_FOUND", "Test is not quarantined", { testId: id });
    return record;
  }),
  "PUT /tests/{id}/quarantine": h(({ app, id, body }) =>
    app.quarantine.set(id, body as unknown as Parameters<typeof app.quarantine.set>[1]),
  ),
  "DELETE /tests/{id}/quarantine": h(({ app, id, ifMatch }) => {
    const record = app.quarantine.get(id);
    if (!record) throw new ContractError("NOT_FOUND", "Test is not quarantined", { testId: id });
    app.quarantine.remove(id, ifMatch());
    return record;
  }),
  "POST /run-comparisons": h(({ app, body }) =>
    app.comparisons.runs(
      String(body.leftRunId),
      String(body.rightRunId),
      body.page as Parameters<typeof app.comparisons.runs>[2],
    ),
  ),
  "POST /batch-comparisons": h(({ app, body }) =>
    app.comparisons.batches(
      String(body.leftBatchId),
      String(body.rightBatchId),
      body.page as Parameters<typeof app.comparisons.batches>[2],
    ),
  ),
  "POST /flake-studies": h(({ app, body, key }) =>
    app.flake.study(body as unknown as Parameters<typeof app.flake.study>[0], {
      idempotencyKey: key,
    }),
  ),
  "GET /flake-studies/{id}": h(({ app, id, query }) =>
    app.flake.report(
      id,
      query.includeStudyIds ? query.includeStudyIds.split(",").filter(Boolean) : undefined,
    ),
  ),
  "POST /execution-previews": h(({ app, body }) =>
    app.selection.preview(body as unknown as Parameters<typeof app.selection.preview>[0]),
  ),
  "POST /selective-runs": h(({ app, body, key }) =>
    app.selection.run(body as unknown as Parameters<typeof app.selection.run>[0], {
      idempotencyKey: key,
    }),
  ),
  "DELETE /artifacts/{id}": h(({ app, id }) => app.retention.requestDeletion(id)),
  "GET /deletion-operations/{id}": h(({ app, id }) => app.retention.deletionStatus(id)),
};
export const coreRoutes: RouteModule = {
  handlers,
  synchronous: [
    "POST /projects",
    "PATCH /projects/{id}",
    "POST /projects/{id}/archive",
    "POST /projects/{id}/environments",
    "PATCH /environments/{id}",
    "DELETE /environments/{id}",
    "POST /projects/{id}/default-environment",
    "POST /projects/{id}/tests",
    "PATCH /tests/{id}",
    "DELETE /tests/{id}",
    "POST /tests/{id}/revisions",
    "POST /tests/{id}/promote",
    "POST /runs/{id}/cancel",
    "POST /batches/{id}/cancel",
    "POST /approvals",
    "POST /approvals/{id}/revoke",
    "POST /uploads",
    "DELETE /sources/{id}",
    "PATCH /projects/{id}/requirements",
    "PATCH /proposals/{id}",
    "POST /discovery/{id}/cancel",
    "POST /healing-proposals/{id}/reject",
    "PUT /tests/{id}/quarantine",
    "DELETE /tests/{id}/quarantine",
    // DELETE /artifacts/{id} is idempotent by its own deletion key and opens its own transaction,
    // so it must not run inside the idempotency wrapper's transaction.
  ],
  status: {
    "POST /runs": 202,
    "POST /batches": 202,
    "POST /projects/{id}/discovery": 202,
    "POST /projects/{id}/proposal-batches": 202,
    "POST /projects": 201,
    "POST /projects/{id}/environments": 201,
    "POST /projects/{id}/tests": 201,
    "POST /tests/{id}/revisions": 201,
    "POST /uploads": 201,
  },
};
