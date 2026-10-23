/**
 * Test-only local Jira and Linear servers over the test CA. They record every request, serve issues
 * a test can edit, close, delete or move, and accept creations and links, so the tracker adapters
 * run unmodified against them. Reused by the J13 tracker journey; nothing here is production code.
 */
import {
  type HttpsReceiver,
  type ReceivedRequest,
  type ReceiverReply,
  startHttpsReceiver,
  type TestTls,
} from "./notifications.js";

/** An issue as a fake tracker holds it. */
export interface FakeIssue {
  key: string;
  title: string;
  /** Plain-text description; Jira serves it as an Atlassian Document Format tree. */
  text: string;
  status: string;
  closed: boolean;
  labels: string[];
  updatedAt: string;
  projectKey: string;
}
export interface FakeIssueEdit {
  key: string;
  title?: string;
  text?: string;
  status?: string;
  closed?: boolean;
  labels?: string[];
  projectKey?: string;
}
export interface FakeLink {
  url: string;
  title: string;
}
export interface FakeTracker {
  readonly kind: "jira" | "linear";
  readonly origin: string;
  readonly port: number;
  /** The Jira base URL, or the Linear GraphQL endpoint. */
  readonly url: string;
  /** The credential the fake accepts: the Jira API token or the Linear API key. */
  readonly credential: string;
  /** Every request the fake received, in order, including refused ones. */
  readonly requests: ReceivedRequest[];
  /** Creates or edits an issue; an edit moves `updatedAt` forward. */
  setIssue(edit: FakeIssueEdit): FakeIssue;
  closeIssue(key: string): void;
  /** The issue answers 404 (Jira) or "Entity not found" (Linear) from now on. */
  deleteIssue(key: string): void;
  /** The issue lives under `newKey` now; asking for the old key answers the moved issue. */
  moveIssue(key: string, newKey: string): void;
  issue(key: string): FakeIssue | undefined;
  linksOf(key: string): readonly FakeLink[];
  /** Issues that came in through the create endpoint. */
  created(): readonly FakeIssue[];
  /** While true every request answers 401. */
  rejectCredentials(reject: boolean): void;
  /** While true attaching a Run link answers 500; creating and reading issues keep working. */
  failLinks(fail: boolean): void;
  close(): Promise<void>;
}

export interface FakeJiraOptions {
  email?: string;
  apiToken?: string;
  projectKey?: string;
}
export interface FakeLinearOptions {
  apiKey?: string;
  teamId?: string;
  teamKey?: string;
}

interface Store {
  issues: Map<string, FakeIssue>;
  moved: Map<string, string>;
  links: Map<string, FakeLink[]>;
  created: FakeIssue[];
  clock: number;
  next: number;
  rejecting: boolean;
  failingLinks: boolean;
}
const epoch = Date.UTC(2026, 0, 1);
const stamp = (store: Store): string => new Date(epoch + ++store.clock * 1000).toISOString();

function newStore(): Store {
  return {
    issues: new Map(),
    moved: new Map(),
    links: new Map(),
    created: [],
    clock: 0,
    next: 100,
    rejecting: false,
    failingLinks: false,
  };
}

function fakeFor(
  kind: FakeTracker["kind"],
  receiver: HttpsReceiver,
  store: Store,
  url: string,
  credential: string,
): FakeTracker {
  return {
    kind,
    origin: receiver.origin,
    port: receiver.port,
    url,
    credential,
    requests: receiver.requests,
    setIssue(edit) {
      const current = store.issues.get(edit.key);
      const key = edit.key;
      const issue: FakeIssue = {
        key,
        title: edit.title ?? current?.title ?? key,
        text: edit.text ?? current?.text ?? "",
        status: edit.status ?? current?.status ?? (edit.closed ? "Done" : "In Progress"),
        closed: edit.closed ?? current?.closed ?? false,
        labels: edit.labels ?? current?.labels ?? [],
        updatedAt: stamp(store),
        projectKey: edit.projectKey ?? current?.projectKey ?? key.slice(0, key.lastIndexOf("-")),
      };
      store.issues.set(key, issue);
      return issue;
    },
    closeIssue(key) {
      const issue = store.issues.get(key);
      if (!issue) throw new Error(`Unknown fake issue ${key}`);
      store.issues.set(key, { ...issue, closed: true, status: "Done", updatedAt: stamp(store) });
    },
    deleteIssue(key) {
      store.issues.delete(key);
      store.moved.delete(key);
    },
    moveIssue(key, newKey) {
      const issue = store.issues.get(key);
      if (!issue) throw new Error(`Unknown fake issue ${key}`);
      store.issues.delete(key);
      store.issues.set(newKey, {
        ...issue,
        key: newKey,
        projectKey: newKey.slice(0, newKey.lastIndexOf("-")),
        updatedAt: stamp(store),
      });
      store.moved.set(key, newKey);
    },
    issue: (key) => store.issues.get(store.moved.get(key) ?? key),
    linksOf: (key) => store.links.get(key) ?? [],
    created: () => store.created,
    rejectCredentials(reject) {
      store.rejecting = reject;
    },
    failLinks(fail) {
      store.failingLinks = fail;
    },
    close: () => receiver.close(),
  };
}

const json = (status: number, body: unknown): ReceiverReply => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const notFound: ReceiverReply = { status: 404, body: "{}" };
const unauthorized: ReceiverReply = { status: 401, body: "{}" };

function parseBody(request: ReceivedRequest): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(request.body.toString("utf8"));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** An Atlassian Document Format tree for plain text: a paragraph per blank-line block. */
function adf(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: text
      .split(/\n{2,}/u)
      .filter((block) => block.trim())
      .map((block) => ({
        type: "paragraph",
        content: block
          .split("\n")
          .flatMap((line, index) => [
            ...(index > 0 ? [{ type: "hardBreak" }] : []),
            { type: "text", text: line },
          ]),
      })),
  };
}

/** Flattens the ADF a Jira create call sends back to the plain text the fake stores. */
function adfPlain(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  const item = node as { type?: string; text?: string; content?: unknown[] };
  if (item.type === "text") return item.text ?? "";
  if (item.type === "hardBreak") return "\n";
  const inner = (item.content ?? []).map(adfPlain);
  return item.type === "doc" ? inner.join("\n\n") : inner.join("");
}

/** A Jira Cloud REST v3 fake: issue read, create, remote link and project read. */
export async function startFakeJira(
  tls: TestTls,
  options: FakeJiraOptions = {},
): Promise<FakeTracker> {
  const email = options.email ?? "bot@example.test";
  const apiToken = options.apiToken ?? "jira-api-token-canary";
  const projectKey = options.projectKey ?? "DEMO";
  const store = newStore();
  const receiver = await startHttpsReceiver(tls, "/");
  const authorization = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  receiver.behave((request) => {
    if (store.rejecting || request.headers.authorization !== authorization) return unauthorized;
    const url = new URL(request.path, receiver.origin);
    const issuePath = /^\/rest\/api\/3\/issue\/([^/]+)(\/remotelink)?$/u.exec(url.pathname);
    if (request.method === "GET" && issuePath && !issuePath[2]) {
      const requested = decodeURIComponent(issuePath[1] as string);
      const issue = store.issues.get(store.moved.get(requested) ?? requested);
      if (!issue) return notFound;
      return json(200, {
        key: issue.key,
        fields: {
          summary: issue.title,
          description: issue.text ? adf(issue.text) : null,
          status: {
            name: issue.status,
            statusCategory: { key: issue.closed ? "done" : "indeterminate" },
          },
          labels: issue.labels,
          project: { key: issue.projectKey },
          updated: issue.updatedAt,
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/rest/api/3/issue") {
      const fields = (parseBody(request).fields ?? {}) as Record<string, unknown>;
      const project = (fields.project as { key?: string } | undefined)?.key;
      if (project !== projectKey) return json(400, { errors: { project: "invalid project" } });
      const key = `${projectKey}-${store.next++}`;
      const issue: FakeIssue = {
        key,
        title: String(fields.summary ?? ""),
        text: adfPlain(fields.description),
        status: "To Do",
        closed: false,
        labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
        updatedAt: stamp(store),
        projectKey,
      };
      store.issues.set(key, issue);
      store.created.push(issue);
      return json(201, { id: String(store.next), key, self: `${receiver.origin}/issue/${key}` });
    }
    if (request.method === "POST" && issuePath?.[2]) {
      if (store.failingLinks) return json(500, {});
      const key = decodeURIComponent(issuePath[1] as string);
      if (!store.issues.has(key)) return notFound;
      const object = (parseBody(request).object ?? {}) as { url?: string; title?: string };
      store.links.set(key, [
        ...(store.links.get(key) ?? []),
        { url: String(object.url), title: String(object.title) },
      ]);
      return json(201, { id: 1 });
    }
    if (request.method === "GET" && url.pathname === `/rest/api/3/project/${projectKey}`)
      return json(200, { key: projectKey });
    return notFound;
  });
  return fakeFor("jira", receiver, store, receiver.origin, apiToken);
}

/** A Linear GraphQL fake: issue, issueCreate, attachmentCreate and team. */
export async function startFakeLinear(
  tls: TestTls,
  options: FakeLinearOptions = {},
): Promise<FakeTracker> {
  const apiKey = options.apiKey ?? "lin_api_key_canary";
  const teamId = options.teamId ?? "team-id-1";
  const teamKey = options.teamKey ?? "ENG";
  const store = newStore();
  const receiver = await startHttpsReceiver(tls, "/graphql");
  const issueAnswer = (issue: FakeIssue) => ({
    identifier: issue.key,
    title: issue.title,
    description: issue.text,
    url: `https://linear.example.test/issue/${issue.key}`,
    updatedAt: issue.updatedAt,
    labels: { nodes: issue.labels.map((name) => ({ name })) },
    state: { name: issue.status, type: issue.closed ? "completed" : "started" },
    team: { key: issue.projectKey },
  });
  receiver.behave((request) => {
    if (store.rejecting || request.headers.authorization !== apiKey) return unauthorized;
    const body = parseBody(request);
    const query = String(body.query ?? "");
    const variables = (body.variables ?? {}) as Record<string, unknown>;
    if (query.includes("issueCreate")) {
      const input = (variables.input ?? {}) as Record<string, unknown>;
      if (input.teamId !== teamId)
        return json(200, { errors: [{ message: "Team not found" }], data: null });
      const key = `${teamKey}-${store.next++}`;
      const issue: FakeIssue = {
        key,
        title: String(input.title ?? ""),
        text: String(input.description ?? ""),
        status: "Todo",
        closed: false,
        labels: [],
        updatedAt: stamp(store),
        projectKey: teamKey,
      };
      store.issues.set(key, issue);
      store.created.push(issue);
      return json(200, {
        data: {
          issueCreate: {
            success: true,
            issue: { identifier: key, url: `https://linear.example.test/issue/${key}` },
          },
        },
      });
    }
    if (query.includes("attachmentCreate")) {
      if (store.failingLinks) return json(500, { errors: [{ message: "attachments are down" }] });
      const input = (variables.input ?? {}) as Record<string, unknown>;
      const key = String(input.issueId);
      if (!store.issues.has(key))
        return json(200, { errors: [{ message: "Entity not found: Issue" }], data: null });
      store.links.set(key, [
        ...(store.links.get(key) ?? []),
        { url: String(input.url), title: String(input.title) },
      ]);
      return json(200, { data: { attachmentCreate: { success: true } } });
    }
    if (query.includes("team(")) {
      return variables.id === teamId
        ? json(200, { data: { team: { key: teamKey } } })
        : json(200, { errors: [{ message: "Entity not found: Team" }], data: null });
    }
    if (query.includes("issue(")) {
      const requested = String(variables.id);
      const issue = store.issues.get(store.moved.get(requested) ?? requested);
      return issue
        ? json(200, { data: { issue: issueAnswer(issue) } })
        : json(200, {
            errors: [
              {
                message: "Entity not found: Issue - Could not find referenced Issue.",
                extensions: { code: "INPUT_ERROR" },
              },
            ],
            data: null,
          });
    }
    return json(400, { errors: [{ message: "Unsupported query" }] });
  });
  return fakeFor("linear", receiver, store, `${receiver.origin}/graphql`, apiKey);
}
