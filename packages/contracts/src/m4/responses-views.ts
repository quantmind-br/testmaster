import { type Static, Type } from "@sinclair/typebox";
import * as P from "../primitives.js";
import { identityContracts } from "./identity.js";

/**
 * Response bodies of the auth, delivery, worker, integration, onboarding, source-history, identity
 * and authoring-view routes whose catalog schema does not match what the service really returns.
 * Every other schema of those routes was checked against its producer and is correct as it is.
 */
export const viewResponseContracts = {
  /**
   * One row of `server_tokens` for `GET /tokens` and `DELETE /tokens/{id}`. The listing is not limited
   * to API tokens: a worker enrollment token is stored with `scopes: []` (worker-pool.ts
   * `createEnrollment`; the credential is authorized by its kind, not by scopes), so the `minItems: 1`
   * of `TokenMetadata` rejects it. `TokenCreated.metadata` keeps `TokenMetadata`: an API token
   * always carries at least the read scope (`resolveIssuance`).
   */
  TokenRecord: P.Obj({
    ...identityContracts.TokenMetadata.properties,
    scopes: Type.Array(P.Enum(["R", "W", "X", "A"]), { maxItems: 4, uniqueItems: true }),
  }),
};
export type TokenRecord = Static<typeof viewResponseContracts.TokenRecord>;
