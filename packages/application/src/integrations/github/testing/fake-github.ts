import { createHmac, createPublicKey, createVerify, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Test-only stand-in for GitHub: a REST API subset (App JWT auth, installation tokens with repository and
 * permission scoping, check runs, issue comments, git refs/contents/pulls, manifest conversion) and a
 * signed webhook sender. Every request is recorded so tests can assert what the App did and did not do.
 */
export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  /** Which credential authenticated the request. */
  auth: "app-jwt" | "installation-token" | "none";
  installationId: string | null;
  status: number;
}
interface Fault {
  match: (request: Pick<RecordedRequest, "method" | "path">) => boolean;
  status: number;
  headers: Record<string, string>;
  times: number;
}
export interface FakeRepository {
  id: number;
  fullName: string;
  private?: boolean;
}
interface FakeInstallation {
  id: number;
  account: { login: string; type: "User" | "Organization" };
  repositories: FakeRepository[];
  permissions: Record<string, "read" | "write">;
  selection: "all" | "selected";
  deleted: boolean;
}
interface IssuedToken {
  installationId: number;
  repositoryIds: number[];
  permissions: Record<string, string>;
  expiresAt: number;
}
export interface FakeCheckRun {
  id: number;
  repository: string;
  name: string;
  head_sha: string;
  external_id: string | null;
  status: string;
  conclusion: string | null;
  details_url: string | null;
  output: { title?: string; summary?: string };
  /** Every status/conclusion this check run was ever set to. */
  history: { status: string; conclusion: string | null }[];
}
export interface FakeComment {
  id: number;
  repository: string;
  issue: number;
  body: string;
  appId: number | null;
  login: string;
}
export interface FakeGithubOptions {
  appId?: number;
  slug?: string;
  webhookSecret?: string;
  now?: () => number;
  tokenTtlMs?: number;
}
export interface DeliverOptions {
  secret?: string;
  deliveryId?: string;
  appId?: number;
  /** Sent in place of the signed body (a tampered replay). */
  alteredBody?: string;
  /** Replaces the computed signature header. */
  signature?: string;
  contentType?: string;
}
export interface DeliveryResult {
  status: number;
  body: unknown;
  deliveryId: string;
}

const permissionByRoute = (method: string, route: string): [string, "read" | "write"] | null => {
  const write = method !== "GET";
  if (/\/check-runs|\/check-run/u.test(route)) return ["checks", write ? "write" : "read"];
  if (/\/issues\//u.test(route)) return ["pull_requests", write ? "write" : "read"];
  if (/\/pulls/u.test(route)) return ["pull_requests", write ? "write" : "read"];
  if (/\/git\/|\/contents\//u.test(route)) return ["contents", write ? "write" : "read"];
  return null;
};

export class FakeGithub {
  readonly requests: RecordedRequest[] = [];
  readonly checkRuns: FakeCheckRun[] = [];
  readonly comments: FakeComment[] = [];
  readonly createdRefs: { repository: string; ref: string; sha: string }[] = [];
  readonly writtenFiles: { repository: string; path: string; branch: string }[] = [];
  readonly createdPulls: { repository: string; number: number; head: string; base: string; draft: boolean }[] = [];
  readonly appId: number;
  readonly slug: string;
  readonly privateKeyPem: string;
  readonly webhookSecret: string;
  readonly installations = new Map<number, FakeInstallation>();
  readonly branchHeads = new Map<string, string>();
  private readonly publicKeyPem: string;
  private readonly tokens = new Map<string, IssuedToken>();
  private readonly faults: Fault[] = [];
  private readonly manifestCodes = new Map<string, boolean>();
  private readonly clock: () => number;
  private readonly tokenTtlMs: number;
  private nextId = 1000;
  private constructor(
    private readonly server: Server,
    options: FakeGithubOptions,
  ) {
    this.appId = options.appId ?? 424242;
    this.slug = options.slug ?? "testmaster-fake";
    this.webhookSecret = options.webhookSecret ?? randomBytes(24).toString("hex");
    this.clock = options.now ?? Date.now;
    this.tokenTtlMs = options.tokenTtlMs ?? 3_600_000;
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    this.publicKeyPem = createPublicKey(pair.publicKey).export({ type: "spki", format: "pem" }).toString();
  }
  static async start(options: FakeGithubOptions = {}): Promise<FakeGithub> {
    const server = createServer();
    const fake = new FakeGithub(server, options);
    server.on("request", (request, response) => {
      void fake.handle(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return fake;
  }
  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ------------------------------------------------------------------ world state
  install(input: {
    id: number;
    account?: string;
    accountType?: "User" | "Organization";
    repositories: FakeRepository[];
    permissions?: Record<string, "read" | "write">;
    selection?: "all" | "selected";
  }): FakeInstallation {
    const installation: FakeInstallation = {
      id: input.id,
      account: { login: input.account ?? "acme", type: input.accountType ?? "Organization" },
      repositories: input.repositories,
      permissions: input.permissions ?? {
        metadata: "read",
        contents: "read",
        checks: "write",
        pull_requests: "write",
        deployments: "read",
      },
      selection: input.selection ?? "selected",
      deleted: false,
    };
    this.installations.set(input.id, installation);
    return installation;
  }
  uninstall(id: number): void {
    const installation = this.installations.get(id);
    if (installation) installation.deleted = true;
  }
  /** Makes the next matching request fail with this status (e.g. 429, 403, 502). */
  failNext(
    match: string | ((request: Pick<RecordedRequest, "method" | "path">) => boolean),
    status: number,
    headers: Record<string, string> = {},
    times = 1,
  ): void {
    this.faults.push({
      match: typeof match === "string" ? (request) => `${request.method} ${request.path}`.includes(match) : match,
      status,
      headers,
      times,
    });
  }
  clearFaults(): void {
    this.faults.length = 0;
  }
  registerManifestCode(code: string): void {
    this.manifestCodes.set(code, true);
  }
  addComment(input: { repository: string; issue: number; body: string; appId?: number | null; login?: string }): FakeComment {
    const comment = {
      id: ++this.nextId,
      repository: input.repository,
      issue: input.issue,
      body: input.body,
      appId: input.appId ?? null,
      login: input.login ?? "someone",
    };
    this.comments.push(comment);
    return comment;
  }
  checksFor(repository: string, sha: string): FakeCheckRun[] {
    return this.checkRuns.filter((check) => check.repository === repository && check.head_sha === sha);
  }
  requestsMatching(method: string, pattern: RegExp): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method && pattern.test(request.path));
  }
  /** Writes that were authenticated by the App JWT instead of an installation token (there must be none). */
  jwtWrites(): RecordedRequest[] {
    return this.requests.filter((request) => request.auth === "app-jwt" && request.method !== "GET" && !/\/access_tokens$/u.test(request.path));
  }

  // ------------------------------------------------------------------ webhooks
  /** Signs `payload` like GitHub and posts it to a TestMaster webhook endpoint. */
  async deliver(url: string, event: string, payload: unknown, options: DeliverOptions = {}): Promise<DeliveryResult> {
    const deliveryId = options.deliveryId ?? randomUUID();
    const raw = JSON.stringify(payload);
    const signature =
      options.signature ?? `sha256=${createHmac("sha256", options.secret ?? this.webhookSecret).update(raw).digest("hex")}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": options.contentType ?? "application/json",
        "x-github-event": event,
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": signature,
        "x-github-hook-installation-target-id": String(options.appId ?? this.appId),
        "user-agent": "GitHub-Hookshot/fake",
      },
      body: options.alteredBody ?? raw,
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: response.status, body, deliveryId };
  }
  repositoryPayload(repository: FakeRepository): Record<string, unknown> {
    return { id: repository.id, full_name: repository.fullName, private: repository.private ?? false };
  }
  installationPayload(
    action: "created" | "deleted" | "suspend" | "unsuspend",
    installation: FakeInstallation,
  ): Record<string, unknown> {
    return {
      action,
      installation: {
        id: installation.id,
        account: installation.account,
        repository_selection: installation.selection,
        permissions: installation.permissions,
        events: ["pull_request", "deployment_status"],
      },
      repositories: installation.repositories.map((entry) => this.repositoryPayload(entry)),
    };
  }
  installationRepositoriesPayload(
    installation: FakeInstallation,
    added: FakeRepository[],
    removed: FakeRepository[],
  ): Record<string, unknown> {
    return {
      action: added.length ? "added" : "removed",
      installation: { id: installation.id },
      repository_selection: installation.selection,
      repositories_added: added.map((entry) => this.repositoryPayload(entry)),
      repositories_removed: removed.map((entry) => this.repositoryPayload(entry)),
    };
  }
  pullRequestPayload(input: {
    installationId: number;
    repository: FakeRepository;
    number: number;
    headSha: string;
    baseSha?: string;
    action?: string;
    draft?: boolean;
    fork?: { fullName: string; id?: number };
    state?: "open" | "closed";
    mergeSha?: string | null;
    title?: string;
    headRef?: string;
  }): Record<string, unknown> {
    const headRepository = input.fork
      ? { id: input.fork.id ?? 9_000_001, full_name: input.fork.fullName, private: false }
      : this.repositoryPayload(input.repository);
    return {
      action: input.action ?? "opened",
      installation: { id: input.installationId },
      repository: this.repositoryPayload(input.repository),
      pull_request: {
        number: input.number,
        state: input.state ?? "open",
        draft: input.draft ?? false,
        title: input.title ?? `Pull request ${input.number}`,
        merge_commit_sha: input.mergeSha ?? null,
        head: { sha: input.headSha, ref: input.headRef ?? "feature", repo: headRepository },
        base: { sha: input.baseSha ?? "b".repeat(40), ref: "main", repo: this.repositoryPayload(input.repository) },
      },
    };
  }
  deploymentStatusPayload(input: {
    installationId: number;
    repository: FakeRepository;
    deploymentId: number;
    sha: string;
    environment?: string;
    state?: string;
    url?: string | null;
  }): Record<string, unknown> {
    return {
      action: "created",
      installation: { id: input.installationId },
      repository: this.repositoryPayload(input.repository),
      deployment: { id: input.deploymentId, sha: input.sha, environment: input.environment ?? "Preview" },
      deployment_status: {
        state: input.state ?? "success",
        environment: input.environment ?? "Preview",
        ...(input.url === null ? {} : { environment_url: input.url ?? "https://preview.example.test" }),
      },
    };
  }

  // ------------------------------------------------------------------ REST handling
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url ?? "/", "http://fake");
    const method = request.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value ?? "")]),
    );
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    const record: RecordedRequest = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      body,
      auth: "none",
      installationId: null,
      status: 0,
    };
    this.requests.push(record);
    const reply = (status: number, payload: unknown, extra: Record<string, string> = {}): void => {
      record.status = status;
      response.writeHead(status, { "content-type": "application/json", ...extra });
      response.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    const fault = this.faults.find((candidate) => candidate.times > 0 && candidate.match(record));
    if (fault) {
      fault.times--;
      reply(fault.status, { message: "injected fault" }, fault.headers);
      return;
    }
    try {
      this.route(record, reply);
    } catch (error) {
      reply(500, { message: String(error) });
    }
  }
  private bearer(record: RecordedRequest): string | null {
    const header = record.headers.authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : null;
  }
  private verifyJwt(token: string): boolean {
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) return false;
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    if (!verifier.verify(this.publicKeyPem, Buffer.from(signature, "base64url"))) return false;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iat: number; exp: number; iss: string };
    const nowSeconds = Math.floor(this.clock() / 1000);
    return claims.iss === String(this.appId) && claims.iat <= nowSeconds && claims.exp > nowSeconds && claims.exp - claims.iat <= 600;
  }
  private route(record: RecordedRequest, reply: (status: number, payload: unknown, headers?: Record<string, string>) => void): void {
    const { method, path } = record;
    const token = this.bearer(record);
    const body = (record.body ?? {}) as Record<string, unknown>;
    // ---- App-level, JWT-authenticated
    let match = /^\/app-manifests\/([^/]+)\/conversions$/u.exec(path);
    if (method === "POST" && match) {
      const code = decodeURIComponent(match[1] ?? "");
      if (!this.manifestCodes.get(code)) return reply(404, { message: "Not Found" });
      this.manifestCodes.delete(code);
      return reply(201, {
        id: this.appId,
        slug: this.slug,
        name: this.slug,
        pem: this.privateKeyPem,
        webhook_secret: this.webhookSecret,
        client_id: "Iv1.fake",
        client_secret: randomBytes(16).toString("hex"),
      });
    }
    if (method === "GET" && path === "/app") {
      if (!token || !this.verifyJwt(token)) return reply(401, { message: "Bad credentials" });
      record.auth = "app-jwt";
      return reply(200, { id: this.appId, slug: this.slug, name: this.slug });
    }
    match = /^\/app\/installations\/(\d+)\/access_tokens$/u.exec(path);
    if (method === "POST" && match) {
      if (!token || !this.verifyJwt(token)) return reply(401, { message: "Bad credentials" });
      record.auth = "app-jwt";
      const installation = this.installations.get(Number(match[1]));
      record.installationId = match[1] ?? null;
      if (!installation || installation.deleted) return reply(404, { message: "Not Found" });
      const repositoryIds = (Array.isArray(body.repository_ids) ? body.repository_ids : installation.repositories.map((entry) => entry.id)) as number[];
      if (repositoryIds.some((id) => !installation.repositories.some((entry) => entry.id === id)))
        return reply(422, { message: "repository not accessible" });
      const requested = (body.permissions ?? installation.permissions) as Record<string, string>;
      const order = ["read", "write"];
      for (const [name, level] of Object.entries(requested))
        if (order.indexOf(installation.permissions[name] ?? "none") < order.indexOf(level))
          return reply(422, { message: `permission ${name}:${level} not granted to the installation` });
      const value = `ghs_${randomBytes(20).toString("hex")}`;
      const expiresAt = this.clock() + this.tokenTtlMs;
      this.tokens.set(value, { installationId: installation.id, repositoryIds, permissions: requested, expiresAt });
      return reply(201, {
        token: value,
        expires_at: new Date(expiresAt).toISOString(),
        permissions: requested,
        repository_selection: "selected",
      });
    }
    // ---- repository routes, installation-token authenticated
    match = /^\/repos\/([^/]+\/[^/]+)\/(.+)$/u.exec(path);
    if (!match) return reply(404, { message: "Not Found" });
    const issued = token ? this.tokens.get(token) : undefined;
    if (!issued || issued.expiresAt <= this.clock()) return reply(401, { message: "Bad credentials" });
    record.auth = "installation-token";
    record.installationId = String(issued.installationId);
    const installation = this.installations.get(issued.installationId);
    if (!installation || installation.deleted) return reply(401, { message: "Bad credentials" });
    const fullName = match[1] ?? "";
    const rest = `/${match[2] ?? ""}`;
    const repository = installation.repositories.find((entry) => entry.fullName === fullName);
    if (!repository || !issued.repositoryIds.includes(repository.id)) return reply(404, { message: "Not Found" });
    const needed = permissionByRoute(method, rest);
    if (needed) {
      const have = issued.permissions[needed[0]];
      if (!have || (needed[1] === "write" && have !== "write"))
        return reply(403, { message: "Resource not accessible by integration" });
    }
    return this.repositoryRoute(record, reply, fullName, rest, body);
  }
  private repositoryRoute(
    record: RecordedRequest,
    reply: (status: number, payload: unknown, headers?: Record<string, string>) => void,
    fullName: string,
    rest: string,
    body: Record<string, unknown>,
  ): void {
    const { method } = record;
    let match = /^\/commits\/([0-9a-f]{40})\/check-runs$/u.exec(rest);
    if (method === "GET" && match) {
      const name = record.query.check_name;
      const runs = this.checksFor(fullName, match[1] ?? "").filter((check) => !name || check.name === name);
      return reply(200, { total_count: runs.length, check_runs: runs.map((run) => this.checkView(run)) });
    }
    if (method === "POST" && rest === "/check-runs") {
      const status = String(body.status ?? "queued");
      const conclusion = (body.conclusion as string | undefined) ?? null;
      if (!["queued", "in_progress", "completed"].includes(status) || (status === "completed" && !conclusion))
        return reply(422, { message: "Invalid check run" });
      const run: FakeCheckRun = {
        id: ++this.nextId,
        repository: fullName,
        name: String(body.name),
        head_sha: String(body.head_sha),
        external_id: (body.external_id as string | undefined) ?? null,
        status,
        conclusion,
        details_url: (body.details_url as string | undefined) ?? null,
        output: (body.output ?? {}) as FakeCheckRun["output"],
        history: [{ status, conclusion }],
      };
      this.checkRuns.push(run);
      return reply(201, this.checkView(run));
    }
    match = /^\/check-runs\/(\d+)$/u.exec(rest);
    if (method === "PATCH" && match) {
      const run = this.checkRuns.find((candidate) => candidate.id === Number(match?.[1]) && candidate.repository === fullName);
      if (!run) return reply(404, { message: "Not Found" });
      const status = String(body.status ?? run.status);
      const conclusion = (body.conclusion as string | undefined) ?? run.conclusion;
      if (status === "completed" && !conclusion) return reply(422, { message: "Invalid check run" });
      run.status = status;
      run.conclusion = conclusion;
      if (body.output) run.output = body.output as FakeCheckRun["output"];
      if (body.details_url) run.details_url = String(body.details_url);
      run.history.push({ status, conclusion });
      return reply(200, this.checkView(run));
    }
    match = /^\/issues\/(\d+)\/comments$/u.exec(rest);
    if (match) {
      const issue = Number(match[1]);
      if (method === "GET") {
        const page = Number(record.query.page ?? 1);
        const perPage = Number(record.query.per_page ?? 30);
        const all = this.comments.filter((comment) => comment.repository === fullName && comment.issue === issue);
        return reply(200, all.slice((page - 1) * perPage, page * perPage).map((comment) => this.commentView(comment)));
      }
      if (method === "POST") {
        const comment = this.addComment({ repository: fullName, issue, body: String(body.body), appId: this.appId, login: `${this.slug}[bot]` });
        return reply(201, this.commentView(comment));
      }
    }
    match = /^\/issues\/comments\/(\d+)$/u.exec(rest);
    if (method === "PATCH" && match) {
      const comment = this.comments.find((candidate) => candidate.id === Number(match?.[1]) && candidate.repository === fullName);
      if (!comment) return reply(404, { message: "Not Found" });
      if (comment.appId !== this.appId) return reply(403, { message: "Resource not accessible by integration" });
      comment.body = String(body.body);
      return reply(200, this.commentView(comment));
    }
    match = /^\/git\/ref\/heads\/(.+)$/u.exec(rest);
    if (method === "GET" && match) {
      const sha = this.branchHeads.get(`${fullName}:${match[1]}`);
      return sha ? reply(200, { ref: `refs/heads/${match[1]}`, object: { sha } }) : reply(404, { message: "Not Found" });
    }
    if (method === "POST" && rest === "/git/refs") {
      const ref = String(body.ref);
      const branch = ref.replace(/^refs\/heads\//u, "");
      if (this.branchHeads.has(`${fullName}:${branch}`)) return reply(422, { message: "Reference already exists" });
      this.branchHeads.set(`${fullName}:${branch}`, String(body.sha));
      this.createdRefs.push({ repository: fullName, ref, sha: String(body.sha) });
      return reply(201, { ref, object: { sha: body.sha } });
    }
    match = /^\/contents\/(.+)$/u.exec(rest);
    if (method === "PUT" && match) {
      this.writtenFiles.push({ repository: fullName, path: decodeURIComponent(match[1] ?? ""), branch: String(body.branch) });
      return reply(201, { content: { path: match[1] } });
    }
    if (method === "POST" && rest === "/pulls") {
      const number = this.createdPulls.length + 100;
      this.createdPulls.push({ repository: fullName, number, head: String(body.head), base: String(body.base), draft: body.draft === true });
      return reply(201, { number, html_url: `https://github.example/${fullName}/pull/${number}` });
    }
    return reply(404, { message: "Not Found" });
  }
  private checkView(run: FakeCheckRun): Record<string, unknown> {
    return {
      id: run.id,
      name: run.name,
      head_sha: run.head_sha,
      external_id: run.external_id,
      status: run.status,
      conclusion: run.conclusion,
      details_url: run.details_url,
      output: run.output,
      app: { id: this.appId },
    };
  }
  private commentView(comment: FakeComment): Record<string, unknown> {
    return {
      id: comment.id,
      body: comment.body,
      user: { login: comment.login },
      performed_via_github_app: comment.appId === null ? null : { id: comment.appId },
    };
  }
}
