import { type Static, Type } from "@sinclair/typebox";
import { entities } from "../entities.js";
import { trackerProviderIds } from "../m4/integrations.js";
import * as P from "../primitives.js";
import { IssueKey, IssuePayload } from "./issues.js";

export { IssueKey, IssuePayload };

const IntegrationId = Type.String({ pattern: `^int_${P.uuidPattern}$` });
const TrackerProvider = P.Enum(trackerProviderIds);
const TrackerUrl = Type.String({ minLength: 1, maxLength: 2048 });
/** A Jira project key or Linear team key: the prefix of every issue key it holds. */
const ContainerKey = Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,19}$" });

export const trackerContracts = {
  /** Jira Cloud REST v3; `apiTokenSecretRef` is a secret bound to the `baseUrl` origin (ADR-034). */
  JiraSettings: P.Obj({
    baseUrl: TrackerUrl,
    email: P.Name,
    apiTokenSecretRef: P.id("sec"),
    projectKey: ContainerKey,
    /** Issue type a `create` files; `Bug` when omitted. */
    issueType: Type.Optional(P.Name),
  }),
  /** Linear GraphQL; `apiKeySecretRef` is a secret bound to the `apiUrl` origin (ADR-034). */
  LinearSettings: P.Obj({
    /** `https://api.linear.app/graphql` when omitted. */
    apiUrl: Type.Optional(TrackerUrl),
    apiKeySecretRef: P.id("sec"),
    /** The Linear team id a `create` files into. */
    teamId: P.Name,
    teamKey: ContainerKey,
  }),
  IssueImportInput: P.Obj({ projectId: P.id("prj"), issueKey: IssueKey }),
  /** A ticket imported as a source (INT-030): provider, key, revision and checksum are recorded. */
  IssueImportReceipt: P.Obj({
    integrationId: IntegrationId,
    provider: TrackerProvider,
    issueKey: IssueKey,
    sourceId: P.id("src"),
    revisionId: P.id("svr"),
    /** True when the ticket text matched the active revision, so no revision was added. */
    unchanged: Type.Boolean(),
    /** The tracker's own revision marker: the issue's last update time. */
    revision: P.Name,
    checksum: P.ContentDigest,
  }),
  IssueLinkDraftInput: P.Obj({
    runId: P.id("run"),
    integrationId: IntegrationId,
    analysisId: Type.Optional(P.id("ana")),
  }),
  /** Execution sends exactly the previewed payload, acknowledged by the caller (INT-031). */
  IssueLinkExecuteInput: P.Obj({
    payloadHash: P.ContentDigest,
    acknowledge: Type.Literal(true),
  }),
  IssueLinkPreview: P.Obj({
    issueLink: entities.IssueLink,
    payload: IssuePayload,
    payloadHash: P.ContentDigest,
    destination: P.Obj({
      provider: TrackerProvider,
      kind: P.Enum(["link", "create"]),
      /** The existing issue a `link` attaches to; null for `create`. */
      issueKey: Type.Union([IssueKey, Type.Null()]),
      /** The Jira project or Linear team a `create` files into. */
      container: ContainerKey,
    }),
  }),
  IssueLinkSyncReceipt: P.Obj({
    projectId: P.id("prj"),
    checked: Type.Integer({ minimum: 0 }),
    links: Type.Array(
      P.Obj({
        id: P.id("isl"),
        syncState: P.Enum(["ok", "deleted", "conflict", "revoked"]),
        externalStatus: Type.Union([P.Name, Type.Null()]),
        externalStatusCategory: Type.Union([P.Enum(["open", "closed"]), Type.Null()]),
      }),
    ),
  }),
};
export type JiraSettings = Static<typeof trackerContracts.JiraSettings>;
export type LinearSettings = Static<typeof trackerContracts.LinearSettings>;
export type IssueImportInput = Static<typeof trackerContracts.IssueImportInput>;
export type IssueImportReceipt = Static<typeof trackerContracts.IssueImportReceipt>;
export type IssueLinkDraftInput = Static<typeof trackerContracts.IssueLinkDraftInput>;
export type IssueLinkExecuteInput = Static<typeof trackerContracts.IssueLinkExecuteInput>;
export type IssueLinkPreview = Static<typeof trackerContracts.IssueLinkPreview>;
export type IssueLinkSyncReceipt = Static<typeof trackerContracts.IssueLinkSyncReceipt>;
export type IssuePayloadValue = Static<typeof IssuePayload>;
export type IssueLink = Static<typeof entities.IssueLink>;
