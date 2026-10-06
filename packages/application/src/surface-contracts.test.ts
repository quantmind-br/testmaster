import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContractError,
  errorRegistry,
  jsonSchema,
  Pagination,
  validate,
} from "@testmaster/contracts";
import { OutboxRepository } from "@testmaster/persistence";
import { expect, it } from "vitest";
import { Application } from "./application.js";

it("catalog-derived entity enum/limit/nullability/ID mutations agree between DTO and persistent entity boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tm-paired-contracts-"));
  const app = await Application.open({ cwd: directory, home: directory });
  let tested = 0;
  try {
    await app.init({ name: "paired", baseUrl: "http://127.0.0.1:7339" });
    for (const kind of [
      "Workspace",
      "Principal",
      "Membership",
      "Project",
      "Environment",
      "EnvironmentRevision",
    ] as const) {
      const stored = app.context.entities.page(kind, app.context.workspaceId).items[0];
      if (!stored) throw new Error(`No fixture ${kind}`);
      const documentSchema = jsonSchema(kind);
      const branch = documentSchema.properties
        ? documentSchema
        : (documentSchema.anyOf as Record<string, unknown>[])[0];
      const properties = branch?.properties as Record<string, Record<string, unknown>>;
      for (const [field, schema] of Object.entries(properties)) {
        if (!(field in stored)) continue;
        const mutations: unknown[] = [];
        if (schema.pattern) mutations.push("not-an-id");
        if (schema.maxLength) mutations.push("x".repeat(Number(schema.maxLength) + 1));
        if (
          schema.anyOf &&
          Array.isArray(schema.anyOf) &&
          schema.anyOf.some((child) => Object.hasOwn(child, "const"))
        )
          mutations.push("__unknown_enum__");
        if (
          schema.type !== "null" &&
          !(schema.anyOf as { type?: string }[] | undefined)?.some((child) => child.type === "null")
        )
          mutations.push(null);
        for (const value of mutations) {
          const candidate = { ...stored, [field]: value };
          let failure: ContractError | undefined;
          try {
            validate(kind, candidate);
          } catch (error) {
            if (!(error instanceof ContractError)) throw error;
            failure = error;
          }
          if (!failure) continue;
          expect(() => app.context.entities.insert(kind, candidate)).toThrowError(
            expect.objectContaining({ code: failure.code, details: failure.details }),
          );
          expect(app.context.entities.get(kind, app.context.workspaceId, stored.id)).toEqual(
            stored,
          );
          tested++;
        }
      }
    }
    expect(tested).toBeGreaterThan(30);
    const limit = Pagination.properties.limit;
    expect(() => validate("Pagination", { limit: Number(limit.minimum) - 1 })).toThrow(
      ContractError,
    );
    expect(() => validate("Pagination", { limit: Number(limit.maximum) + 1 })).toThrow(
      ContractError,
    );
    expect(app.context.entities.page("Project", app.context.workspaceId).items).toHaveLength(1);
    const outbox = new OutboxRepository(app.database);
    const eventProperties = jsonSchema("OutboxEvent").properties as Record<
      string,
      Record<string, unknown>
    >;
    const branches = eventProperties.deliveryState?.anyOf;
    if (!Array.isArray(branches)) throw new Error("Missing delivery state enum");
    const states = branches.map((branch: { const: string }) => branch.const);
    for (const deliveryState of states) {
      const event = app.database.withTx(() =>
        outbox.append(app.context.workspaceId, "paired", "contract.fixture", { deliveryState }),
      );
      const row = app.database.get("SELECT * FROM outbox WHERE id=?", event.id);
      if (!row) throw new Error("Missing committed event");
      const dto = {
        id: event.id,
        workspaceId: app.context.workspaceId,
        aggregateId: "paired",
        seq: event.seq,
        type: "contract.fixture",
        payloadRef: String(row.payload_ref),
        deliveryState,
      };
      validate("OutboxEvent", dto);
      validate("OutboxEvent", JSON.parse(JSON.stringify(dto)));
      expect(() => validate("OutboxEvent", { ...dto, deliveryState: "fabricated" })).toThrow(
        ContractError,
      );
      expect(JSON.parse(String(row.data_json))).toEqual({ deliveryState });
    }
    for (const [code, metadata] of Object.entries(errorRegistry)) {
      validate("ErrorEnvelope", {
        schemaVersion: "1.0.0",
        requestId: "paired",
        error: {
          code,
          message: code,
          retryable: metadata.retryable !== false,
          details: {},
          nextActions: [],
        },
      });
    }
  } finally {
    app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
