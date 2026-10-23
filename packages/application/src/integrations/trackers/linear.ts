import {
  type IssuePayloadValue,
  type LinearSettings,
  SCHEMA_VERSION,
  validate,
} from "@testmaster/contracts";
import type { EgressOptions } from "../../notifications/https.js";
import type { DeliveryOutcome, IntegrationProvider } from "../provider.js";
import {
  asRecord,
  assertTrackerUrl,
  isIssueKey,
  parseJson,
  requireFound,
  resolveTrackerSecret,
  stringField,
  type TrackerAdapter,
  type TrackerFetch,
  type TrackerIssue,
  testOutcome,
  trackerEgress,
  trackerFailure,
  trackerRequest,
  trackerUserAgent,
} from "./adapter.js";
import { trackerCapabilities } from "./jira.js";

const adapterVersion = "1.0.0";
/** Where a Linear integration talks to when it names no `apiUrl`. */
export const linearDefaultApiUrl = "https://api.linear.app/graphql";

const issueQuery = `query Issue($id: String!) { issue(id: $id) { identifier title description url updatedAt labels { nodes { name } } state { name type } team { key } } }`;
const issueCreateMutation = `mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }`;
const attachmentCreateMutation = `mutation AttachmentCreate($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }`;
const teamQuery = `query Team($id: String!) { team(id: $id) { key } }`;

interface GraphqlError {
  message: string;
  code: string;
}

/** The text a Linear issue is created with: labels are by id in Linear, so they travel as a trailer. */
function createdDescription(payload: IssuePayloadValue): string {
  return payload.labels.length
    ? `${payload.body}\n\nLabels: ${payload.labels.join(", ")}`
    : payload.body;
}

function graphqlErrors(envelope: Record<string, unknown> | null): GraphqlError[] {
  return (Array.isArray(envelope?.errors) ? envelope.errors : []).map((error: unknown) => {
    const item = asRecord(error);
    return {
      message: typeof item?.message === "string" ? item.message : "",
      code: String(asRecord(item?.extensions)?.code ?? ""),
    };
  });
}

/** Linear GraphQL over the egress-policy transport. */
export function createLinearAdapter(
  settings: LinearSettings,
  apiKey: string,
  options: EgressOptions,
): TrackerAdapter {
  const endpoint = settings.apiUrl ?? linearDefaultApiUrl;
  const headers = {
    accept: "application/json",
    authorization: apiKey,
    "content-type": "application/json",
    "user-agent": trackerUserAgent,
  };
  /** One GraphQL call; errors are returned so a caller can tell a missing issue from a failure. */
  async function call(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ data: Record<string, unknown> | null; errors: GraphqlError[] }> {
    const reply = requireFound(
      await trackerRequest(
        "POST",
        endpoint,
        headers,
        Buffer.from(JSON.stringify({ query, variables })),
        options,
        [400],
      ),
      "The Linear API",
    );
    const envelope = asRecord(parseJson(reply));
    const errors = graphqlErrors(envelope);
    if (errors.some((error) => /authentication/iu.test(`${error.code} ${error.message}`)))
      throw trackerFailure("FORBIDDEN", "credential_rejected", "Tracker rejected the credential");
    if (reply.status !== 200 && !errors.length)
      throw trackerFailure("UNAVAILABLE", "tracker_unavailable", "Tracker refused the request", {
        status: reply.status,
      });
    return { data: asRecord(envelope?.data), errors };
  }
  /** A failed GraphQL answer that is not a missing entity. */
  function failed(errors: readonly GraphqlError[]): never {
    throw trackerFailure("UNAVAILABLE", "tracker_unavailable", "Tracker refused the request", {
      graphqlErrors: errors.length,
    });
  }
  return {
    provider: "linear",
    container: settings.teamKey,
    async fetchIssue(issueKey): Promise<TrackerFetch> {
      const { data, errors } = await call(issueQuery, { id: issueKey });
      if (errors.length) {
        if (errors.every((error) => /not found/iu.test(error.message))) return { kind: "deleted" };
        failed(errors);
      }
      const issue = asRecord(data?.issue);
      if (!issue) return { kind: "deleted" };
      const identifier = stringField(issue, "identifier");
      if (!isIssueKey(identifier))
        throw trackerFailure("UNAVAILABLE", "tracker_unavailable", "Tracker answer is malformed", {
          field: "identifier",
        });
      const state = asRecord(issue.state);
      const nodes = asRecord(issue.labels)?.nodes;
      return {
        issueKey: identifier,
        title: stringField(issue, "title"),
        text: typeof issue.description === "string" ? issue.description.trim() : "",
        status: stringField(state, "name"),
        statusCategory:
          state?.type === "completed" || state?.type === "canceled" ? "closed" : "open",
        projectKey: stringField(asRecord(issue.team), "key"),
        url: stringField(issue, "url"),
        updatedAt: stringField(issue, "updatedAt"),
        labels: (Array.isArray(nodes) ? nodes : [])
          .map((node: unknown) => asRecord(node)?.name)
          .filter((name): name is string => typeof name === "string"),
      } satisfies TrackerIssue;
    },
    async createIssue(payload: IssuePayloadValue) {
      const { data, errors } = await call(issueCreateMutation, {
        input: {
          teamId: settings.teamId,
          title: payload.title,
          description: createdDescription(payload),
        },
      });
      if (errors.length) failed(errors);
      const created = asRecord(data?.issueCreate);
      const issue = asRecord(created?.issue);
      const identifier = stringField(issue, "identifier");
      if (created?.success !== true || !isIssueKey(identifier))
        throw trackerFailure(
          "UNAVAILABLE",
          "tracker_unavailable",
          "Tracker did not create the issue",
        );
      return { issueKey: identifier, url: stringField(issue, "url") };
    },
    async linkRun(issueKey, link) {
      const { data, errors } = await call(attachmentCreateMutation, {
        input: { issueId: issueKey, title: link.title, url: link.url },
      });
      if (errors.length) failed(errors);
      if (asRecord(data?.attachmentCreate)?.success !== true)
        throw trackerFailure(
          "UNAVAILABLE",
          "tracker_unavailable",
          "Tracker did not attach the link",
        );
    },
    async probe() {
      const { data, errors } = await call(teamQuery, { id: settings.teamId });
      if (errors.length) failed(errors);
      if (asRecord(data?.team)?.key !== settings.teamKey)
        throw trackerFailure(
          "UNAVAILABLE",
          "container_mismatch",
          "The Linear team does not match the configured team key",
        );
    },
  };
}

/** The `linear` integration: settings, secret binding and a read-only configuration test. */
export function createLinearProvider(
  options: EgressOptions = trackerEgress,
): IntegrationProvider<LinearSettings> {
  return {
    id: "linear",
    version: adapterVersion,
    schemaVersion: SCHEMA_VERSION,
    capabilities: trackerCapabilities,
    supportedEvents: [],
    parseSettings: (input) => {
      validate("LinearSettings", input);
      const settings = input as LinearSettings;
      if (settings.apiUrl !== undefined) assertTrackerUrl(settings.apiUrl, "apiUrl");
      return settings;
    },
    referencedSecrets: (settings) => [settings.apiKeySecretRef],
    async sendTest(context, integration): Promise<DeliveryOutcome> {
      const { settings } = integration;
      try {
        const key = await resolveTrackerSecret(
          context.secrets,
          settings.apiKeySecretRef,
          settings.apiUrl ?? linearDefaultApiUrl,
        );
        await createLinearAdapter(settings, key, options).probe();
        return { state: "delivered", detail: `Linear team ${settings.teamKey} is readable` };
      } catch (error) {
        return testOutcome(error);
      }
    },
  };
}
