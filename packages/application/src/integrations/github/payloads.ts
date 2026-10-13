import { ContractError } from "@testmaster/contracts";

const sha = /^[0-9a-f]{40}$/u;
type Obj = Record<string, unknown>;
const fail = (field: string): never => {
  throw new ContractError("INVALID_ARGUMENT", "GitHub webhook payload is invalid", {
    reason: "invalid_payload",
    field,
  });
};
const obj = (value: unknown, field: string): Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : fail(field);
const text = (value: unknown, field: string, max = 300): string =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : fail(field);
const optText = (value: unknown, field: string, max = 2000): string | null =>
  value === null || value === undefined ? null : text(value, field, max);
const bool = (value: unknown, field: string): boolean =>
  typeof value === "boolean" ? value : fail(field);
const id = (value: unknown, field: string): string => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return fail(field);
};
const hash = (value: unknown, field: string): string =>
  typeof value === "string" && sha.test(value) ? value : fail(field);
const array = (value: unknown, field: string): unknown[] =>
  Array.isArray(value) && value.length <= 5000 ? value : fail(field);

export interface RepositoryRef {
  id: string;
  fullName: string;
  private: boolean;
}
function repository(value: unknown, field: string): RepositoryRef {
  const input = obj(value, field);
  const fullName = text(input.full_name, `${field}.full_name`, 140);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(fullName)) fail(`${field}.full_name`);
  return {
    id: id(input.id, `${field}.id`),
    fullName,
    private: input.private === undefined ? false : bool(input.private, `${field}.private`),
  };
}
const installationId = (root: Obj): string => id(obj(root.installation, "installation").id, "installation.id");

export interface InstallationEvent {
  kind: "installation";
  action: string;
  installationId: string;
  accountLogin: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  permissions: Record<string, string>;
  events: string[];
  repositories: RepositoryRef[];
}
export interface InstallationRepositoriesEvent {
  kind: "installation_repositories";
  action: string;
  installationId: string;
  repositorySelection: "all" | "selected";
  added: RepositoryRef[];
  removed: RepositoryRef[];
}
export interface PullRequestEvent {
  kind: "pull_request";
  action: string;
  installationId: string;
  repository: RepositoryRef;
  number: number;
  headSha: string;
  baseSha: string;
  mergeSha: string | null;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  /** True when the head lives in another repository, or in none (a deleted fork). */
  fork: boolean;
  headRepository: string | null;
  headRef: string;
}
export interface DeploymentStatusEvent {
  kind: "deployment_status";
  action: string;
  installationId: string;
  repository: RepositoryRef;
  deploymentId: string;
  sha: string;
  environment: string;
  state: string;
  url: string | null;
}
export interface PushEvent {
  kind: "push";
  action: string;
  installationId: string;
  repository: RepositoryRef;
  after: string;
  ref: string;
}
export interface CheckRunEvent {
  kind: "check_run";
  action: string;
  installationId: string;
  repository: RepositoryRef;
  headSha: string;
  name: string;
}
export type GithubEvent =
  | InstallationEvent
  | InstallationRepositoriesEvent
  | PullRequestEvent
  | DeploymentStatusEvent
  | PushEvent
  | CheckRunEvent;

function selection(value: unknown): "all" | "selected" {
  return value === "all" || value === "selected" ? value : fail("repository_selection");
}
/** Strict, bounded parsing of the events the App subscribes to; anything else is not parsed at all. */
export function parseGithubEvent(eventType: string, body: unknown): GithubEvent | null {
  const root = obj(body, "payload");
  const action = root.action === undefined ? "" : text(root.action, "action", 60);
  switch (eventType) {
    case "installation": {
      const installation = obj(root.installation, "installation");
      const account = obj(installation.account, "installation.account");
      const type = account.type;
      if (type !== "User" && type !== "Organization") fail("installation.account.type");
      return {
        kind: "installation",
        action,
        installationId: id(installation.id, "installation.id"),
        accountLogin: text(account.login, "installation.account.login", 100),
        accountType: type as "User" | "Organization",
        repositorySelection: selection(installation.repository_selection),
        permissions: Object.fromEntries(
          Object.entries(obj(installation.permissions ?? {}, "installation.permissions")).map(
            ([key, value]) => [key, text(value, `installation.permissions.${key}`, 20)],
          ),
        ),
        events: array(installation.events ?? [], "installation.events").map((event, index) =>
          text(event, `installation.events.${index}`, 60),
        ),
        repositories: array(root.repositories ?? [], "repositories").map((entry, index) =>
          repository(entry, `repositories.${index}`),
        ),
      };
    }
    case "installation_repositories":
      return {
        kind: "installation_repositories",
        action,
        installationId: installationId(root),
        repositorySelection: selection(root.repository_selection),
        added: array(root.repositories_added ?? [], "repositories_added").map((entry, index) =>
          repository(entry, `repositories_added.${index}`),
        ),
        removed: array(root.repositories_removed ?? [], "repositories_removed").map(
          (entry, index) => repository(entry, `repositories_removed.${index}`),
        ),
      };
    case "pull_request": {
      const pull = obj(root.pull_request, "pull_request");
      const head = obj(pull.head, "pull_request.head");
      const base = obj(pull.base, "pull_request.base");
      const baseRepository = repository(base.repo, "pull_request.base.repo");
      const headRepository =
        head.repo === null || head.repo === undefined
          ? null
          : repository(head.repo, "pull_request.head.repo");
      const number = pull.number;
      if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
        fail("pull_request.number");
      const state = pull.state;
      if (state !== "open" && state !== "closed") fail("pull_request.state");
      return {
        kind: "pull_request",
        action,
        installationId: installationId(root),
        repository: baseRepository,
        number: number as number,
        headSha: hash(head.sha, "pull_request.head.sha"),
        baseSha: hash(base.sha, "pull_request.base.sha"),
        mergeSha:
          pull.merge_commit_sha === null || pull.merge_commit_sha === undefined
            ? null
            : hash(pull.merge_commit_sha, "pull_request.merge_commit_sha"),
        draft: pull.draft === undefined ? false : bool(pull.draft, "pull_request.draft"),
        state: state as "open" | "closed",
        merged: pull.merged === undefined ? false : bool(pull.merged, "pull_request.merged"),
        fork: !headRepository || headRepository.fullName !== baseRepository.fullName,
        headRepository: headRepository?.fullName ?? null,
        headRef: text(head.ref, "pull_request.head.ref", 250),
      };
    }
    case "deployment_status": {
      const status = obj(root.deployment_status, "deployment_status");
      const deployment = obj(root.deployment, "deployment");
      return {
        kind: "deployment_status",
        action,
        installationId: installationId(root),
        repository: repository(root.repository, "repository"),
        deploymentId: id(deployment.id, "deployment.id"),
        sha: hash(deployment.sha, "deployment.sha"),
        environment: text(deployment.environment ?? status.environment, "environment", 100),
        state: text(status.state, "deployment_status.state", 40),
        url: optText(status.environment_url, "environment_url") ?? optText(status.target_url, "target_url"),
      };
    }
    case "push":
      return {
        kind: "push",
        action,
        installationId: installationId(root),
        repository: repository(root.repository, "repository"),
        after: hash(root.after, "after"),
        ref: text(root.ref, "ref", 250),
      };
    case "check_run": {
      const run = obj(root.check_run, "check_run");
      return {
        kind: "check_run",
        action,
        installationId: installationId(root),
        repository: repository(root.repository, "repository"),
        headSha: hash(run.head_sha, "check_run.head_sha"),
        name: text(run.name, "check_run.name", 200),
      };
    }
    default:
      return null;
  }
}
