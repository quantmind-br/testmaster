import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { entities } from "../entities.js";
import { Description, Enum, id, Name, Obj, Timestamp, Version } from "../primitives.js";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/**
 * A workspace is a demonstration workspace exactly when its quota policy is this identifier
 * (set through `PATCH /workspaces/{id}`). Gate-producing CI entry points refuse it server-side.
 */
export const demoQuotaPolicyId = "demo";

/** Data classes a project may share with a model provider, with what each one sends. */
export const modelDataClasses = [
  "documents",
  "code_summary",
  "dom",
  "requirements",
  "plans",
  "execution_evidence",
] as const;
export type ModelDataClass = (typeof modelDataClasses)[number];
export const modelDataClassDescriptions: Readonly<Record<ModelDataClass, string>> = {
  documents: "Uploaded product documents and requirement text",
  code_summary: "Summaries of repository code",
  dom: "Page DOM snapshots captured during discovery",
  requirements: "Normalized requirements",
  plans: "Test plans",
  execution_evidence:
    "Run evidence such as steps, console and network summaries (secrets redacted)",
};
const ModelDataClassId = Enum(modelDataClasses);

export const settingsContracts = {
  /** The new secret value; it is never returned by any route. */
  SecretRotationInput: Obj({ value: Type.String() }),
  /** One secret lifecycle event derived from the audit trail; never carries a value or its hash. */
  SecretVersionRecord: Obj({
    id: id("aud"),
    createdAt: Timestamp,
    version: Version,
    event: Enum(["created", "rotated", "revoked"]),
    actor: Name,
    requestId: Name,
  }),
  ModelConsentInput: Obj({
    dataClasses: Type.Array(ModelDataClassId, { minItems: 1, uniqueItems: true }),
    allowUnknownCost: Type.Optional(Type.Boolean()),
  }),
  ModelConsentSettings: Obj({
    projectId: id("prj"),
    dataClasses: Type.Array(Obj({ id: ModelDataClassId, description: Description })),
    providers: Type.Array(
      Obj({
        id: Name,
        /** Endpoint origin only: no path, query or credentials. */
        baseUrl: Name,
        /** True unless the endpoint is loopback. */
        remote: Type.Boolean(),
        models: Type.Array(Name),
        allowedByProfile: Type.Boolean(),
        consent: nullable(
          Obj({
            dataClasses: Type.Array(Name),
            allowUnknownCost: Type.Boolean(),
            grantedBy: Name,
            grantedAt: Timestamp,
            revokedAt: nullable(Timestamp),
          }),
        ),
      }),
    ),
  }),
  /** `EnvironmentRevision` without `variables`, which may hold captured values. */
  EnvironmentRevisionView: Obj({
    id: id("evr"),
    createdAt: Timestamp,
    targetOrigins: entities.EnvironmentRevision.properties.targetOrigins,
    networkProfile: entities.EnvironmentRevision.properties.networkProfile,
    authProfileRefs: entities.EnvironmentRevision.properties.authProfileRefs,
    locale: Name,
    timezone: Name,
    production: Type.Boolean(),
  }),
};
export type SecretRotationInput = Static<typeof settingsContracts.SecretRotationInput>;
export type SecretVersionRecord = Static<typeof settingsContracts.SecretVersionRecord>;
export type ModelConsentInput = Static<typeof settingsContracts.ModelConsentInput>;
export type ModelConsentSettings = Static<typeof settingsContracts.ModelConsentSettings>;
export type EnvironmentRevisionView = Static<typeof settingsContracts.EnvironmentRevisionView>;
