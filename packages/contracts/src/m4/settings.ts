import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { entities, ServerLogSource } from "../entities.js";
import { Description, Enum, id, Name, Obj, Timestamp, Version } from "../primitives.js";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/**
 * A workspace is a demonstration workspace exactly when its quota policy is this identifier
 * (set through `PATCH /workspaces/{id}`). Gate-producing CI entry points refuse it server-side.
 */
export const demoQuotaPolicyId = "demo";

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
  /** Providers the configuration offers; allowedByProfile says whether the policy admits them. */
  ModelProviderSettings: Obj({
    projectId: id("prj"),
    providers: Type.Array(
      Obj({
        id: Name,
        /** Endpoint origin only: no path, query or credentials. */
        baseUrl: Name,
        /** True unless the endpoint is loopback. */
        remote: Type.Boolean(),
        models: Type.Array(Name),
        allowedByProfile: Type.Boolean(),
      }),
    ),
  }),
  /** `EnvironmentRevision` without `variables`, which may hold captured values. */
  EnvironmentRevisionView: Obj({
    id: id("evr"),
    createdAt: Timestamp,
    targetOrigins: entities.EnvironmentRevision.properties.targetOrigins,
    /** Extra origins admitted for page subrequests; empty when the revision predates the field. */
    additionalOrigins: Type.Array(Name),
    networkProfile: entities.EnvironmentRevision.properties.networkProfile,
    authProfileRefs: entities.EnvironmentRevision.properties.authProfileRefs,
    locale: Name,
    timezone: Name,
    production: Type.Boolean(),
    /** The opted-in server log source; null when the environment reads none. */
    serverLog: Type.Union([ServerLogSource, Type.Null()]),
  }),
};
export type SecretRotationInput = Static<typeof settingsContracts.SecretRotationInput>;
export type SecretVersionRecord = Static<typeof settingsContracts.SecretVersionRecord>;
export type ModelProviderSettings = Static<typeof settingsContracts.ModelProviderSettings>;
export type EnvironmentRevisionView = Static<typeof settingsContracts.EnvironmentRevisionView>;
