import {
  type IssuePayloadValue,
  type JiraSettings,
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

const adapterVersion = "1.0.0";
const maxAdfDepth = 40;
/** Capabilities every tracker adapter declares (INT-030..033). */
export const trackerCapabilities = ["issue-import", "issue-link", "issue-create"] as const;

/** Flattens an Atlassian Document Format tree (or a plain string) to text; no node is ever executed. */
export function adfToText(node: unknown, depth = 0): string {
  if (typeof node === "string") return node;
  const item = asRecord(node);
  if (!item || depth > maxAdfDepth) return "";
  const attrs = asRecord(item.attrs);
  const inner = (): string =>
    (Array.isArray(item.content) ? item.content : [])
      .map((child: unknown) => adfToText(child, depth + 1))
      .join("");
  switch (item.type) {
    case "text":
      return typeof item.text === "string" ? item.text : "";
    case "hardBreak":
      return "\n";
    case "mention":
    case "emoji":
      return typeof attrs?.text === "string" ? attrs.text : "";
    case "inlineCard":
      return typeof attrs?.url === "string" ? attrs.url : "";
    case "rule":
      return "---\n";
    case "paragraph":
    case "heading":
    case "codeBlock":
    case "blockquote":
      return `${inner()}\n`;
    case "listItem":
      return `- ${inner().trimEnd()}\n`;
    case "tableCell":
    case "tableHeader":
      return `${inner().trimEnd()} | `;
    case "tableRow":
      return `${inner()}\n`;
    default:
      return inner();
  }
}

/** Plain text of an issue description with runs of blank lines collapsed. */
function plainText(description: unknown): string {
  return adfToText(description)
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** The ADF document a plain-text payload body is sent as: one paragraph per blank-line block. */
function adfDocument(text: string): unknown {
  const paragraphs = text
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => ({
      type: "paragraph",
      content: block
        .split("\n")
        .flatMap((line, index) => [
          ...(index > 0 ? [{ type: "hardBreak" }] : []),
          ...(line ? [{ type: "text", text: line }] : []),
        ]),
    }));
  return {
    type: "doc",
    version: 1,
    content: paragraphs.length ? paragraphs : [{ type: "paragraph", content: [] }],
  };
}

/** Jira Cloud REST v3 over the egress-policy transport. */
export function createJiraAdapter(
  settings: JiraSettings,
  apiToken: string,
  options: EgressOptions,
): TrackerAdapter {
  const base = settings.baseUrl.replace(/\/+$/u, "");
  const headers = {
    accept: "application/json",
    authorization: `Basic ${Buffer.from(`${settings.email}:${apiToken}`, "utf8").toString("base64")}`,
    "user-agent": trackerUserAgent,
  };
  const jsonHeaders = { ...headers, "content-type": "application/json" };
  const post = (path: string, body: unknown) =>
    trackerRequest(
      "POST",
      `${base}${path}`,
      jsonHeaders,
      Buffer.from(JSON.stringify(body)),
      options,
    );
  return {
    provider: "jira",
    container: settings.projectKey,
    async fetchIssue(issueKey): Promise<TrackerFetch> {
      const reply = await trackerRequest(
        "GET",
        `${base}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description,status,labels,project,updated`,
        headers,
        null,
        options,
      );
      if (reply.status === 404) return { kind: "deleted" };
      const issue = asRecord(parseJson(reply));
      const fields = asRecord(issue?.fields);
      const status = asRecord(fields?.status);
      const key = stringField(issue, "key");
      if (!isIssueKey(key))
        throw trackerFailure("UNAVAILABLE", "tracker_unavailable", "Tracker answer is malformed", {
          field: "key",
        });
      const category = asRecord(status?.statusCategory);
      return {
        issueKey: key,
        title: stringField(fields, "summary"),
        text: plainText(fields?.description),
        status: stringField(status, "name"),
        statusCategory: category?.key === "done" ? "closed" : "open",
        projectKey: stringField(asRecord(fields?.project), "key"),
        url: `${base}/browse/${key}`,
        updatedAt: stringField(fields, "updated"),
        labels: (Array.isArray(fields?.labels) ? fields.labels : []).filter(
          (label): label is string => typeof label === "string",
        ),
      } satisfies TrackerIssue;
    },
    async createIssue(payload: IssuePayloadValue) {
      const reply = requireFound(
        await post("/rest/api/3/issue", {
          fields: {
            project: { key: settings.projectKey },
            summary: payload.title,
            issuetype: { name: settings.issueType ?? "Bug" },
            description: adfDocument(payload.body),
            labels: payload.labels,
          },
        }),
        "The Jira project",
      );
      const key = stringField(asRecord(parseJson(reply)), "key");
      if (!isIssueKey(key))
        throw trackerFailure("UNAVAILABLE", "tracker_unavailable", "Tracker answer is malformed", {
          field: "key",
        });
      return { issueKey: key, url: `${base}/browse/${key}` };
    },
    async linkRun(issueKey, link) {
      requireFound(
        await post(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/remotelink`, {
          object: { url: link.url, title: link.title },
        }),
        "The Jira issue",
      );
    },
    async probe() {
      requireFound(
        await trackerRequest(
          "GET",
          `${base}/rest/api/3/project/${encodeURIComponent(settings.projectKey)}`,
          headers,
          null,
          options,
        ),
        "The Jira project",
      );
    },
  };
}

/** The `jira` integration: settings, secret binding and a read-only configuration test. */
export function createJiraProvider(
  options: EgressOptions = trackerEgress,
): IntegrationProvider<JiraSettings> {
  return {
    id: "jira",
    version: adapterVersion,
    schemaVersion: SCHEMA_VERSION,
    capabilities: trackerCapabilities,
    supportedEvents: [],
    parseSettings: (input) => {
      validate("JiraSettings", input);
      const settings = input as JiraSettings;
      assertTrackerUrl(settings.baseUrl, "baseUrl");
      return settings;
    },
    referencedSecrets: (settings) => [settings.apiTokenSecretRef],
    async sendTest(context, integration): Promise<DeliveryOutcome> {
      const { settings } = integration;
      try {
        const token = await resolveTrackerSecret(
          context.secrets,
          settings.apiTokenSecretRef,
          settings.baseUrl,
        );
        await createJiraAdapter(settings, token, options).probe();
        return { state: "delivered", detail: `Jira project ${settings.projectKey} is readable` };
      } catch (error) {
        return testOutcome(error);
      }
    },
  };
}
