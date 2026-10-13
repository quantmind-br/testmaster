import {
  access,
  chmod,
  constants,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContractError,
  capabilityRegistry,
  columnGrantAction,
  type EnvironmentRevision,
  type Membership,
  type RbacColumn,
  type Role,
  type Run,
  rbacColumns,
  rbacMatrix,
  scopeColumn,
  type TestCase,
  validate,
} from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import {
  type EntityDocument,
  EntityRepository,
  PersistenceDatabase,
} from "@testmaster/persistence";
import {
  type DockerCommand,
  DockerExecutor,
  dockerCommand,
  type ImageLock,
  verifyImageLock,
} from "@testmaster/sandbox";
import { AgentSkillsService } from "./agent-skills/service.js";
import { AgentModeService } from "./ai/agent-mode.js";
import { AnalysisService } from "./ai/analysis.js";
import { CodeExportService } from "./ai/code-export.js";
import { CodeGenerationService } from "./ai/code-generation.js";
import { CodeImportService } from "./ai/code-import.js";
import { DiscoveryService } from "./ai/discovery.js";
import { ExploreService } from "./ai/explore.js";
import { HealingService } from "./ai/healing.js";
import { ModelService } from "./ai/model.js";
import { ProposalsService } from "./ai/proposals.js";
import { RequirementsService } from "./ai/requirements.js";
import { SourcesService, UploadsService } from "./ai/sources.js";
import { UsageService } from "./ai/usage.js";
import { ApprovalsService } from "./approvals.js";
import { ArtifactsService, ReportsService } from "./artifacts.js";
import { AuditService, auditSecurity } from "./audit.js";
import {
  EnvironmentsService,
  ProjectsService,
  RevisionsService,
  TestsService,
} from "./authoring.js";
import { BackupsService } from "./backups.js";
import { CiService } from "./ci.js";
import { ComparisonsService } from "./comparisons.js";
import {
  exportEffectiveConfig,
  type ResolveConfigOptions,
  type ResolvedConfig,
  resolveConfig,
} from "./config.js";
import { entity, type RunActor, type Scope, type ServiceContext } from "./context.js";
import { ControllerRegistry } from "./controllers.js";
import { DeliveryService } from "./delivery.js";
import { FlakeService } from "./flake.js";
import { IdentityService } from "./identity.js";
import { correlationId } from "./observability.js";
import { QuarantineService } from "./quarantine.js";
import { revokedImageIds, revokeImage } from "./release.js";
import { ResourcesService } from "./resources.js";
import { RetentionService } from "./retention.js";
import { BatchesService, RunsService } from "./runs.js";
import { measureRuntimeIdentities } from "./runtime-identity.js";
import { isValidTimeZone, nodeSupport } from "./runtime-support.js";
import { SecretsService } from "./secrets.js";
import { SelectionService } from "./selection.js";
import type { ServerConfig } from "./server-config.js";
import { filesystemRoot } from "./server-config.js";
import {
  MembersService,
  OperatorService,
  systemPrincipalId,
  TokensService,
  WorkspacesService,
} from "./team.js";
import type { TokenData, TokenKind } from "./tokens.js";
import { WorkerService } from "./worker.js";

const columnScope: Readonly<Record<RbacColumn, Scope>> = {
  read: "R",
  write: "W",
  execute: "X",
  secret: "W",
  export: "R",
  admin: "A",
};
export interface PermissionGrant {
  resourceType: string;
  actions: ("read" | "write" | "execute" | "admin" | "approve" | "raw" | "export" | "delete")[];
  projectIds: string[];
  environmentIds: string[];
  expiresAt: string | null;
  grantedBy: string;
  deny?: boolean;
}
export interface AuthorizationIdentity {
  principalId: string;
  scopes: Scope[];
  grants?: PermissionGrant[];
  /** Capability-token ceiling carried across delegation; absent for local session identities. */
  expiresAt?: string;
}
/** `system` is a workspace's controller principal; the other kinds are bearer tokens or cookies. */
export type CredentialKind = TokenKind | "session" | "system";
/** Identity resolved from a token or cookie; it carries the workspace it is bound to. */
export interface AuthenticatedIdentity extends AuthorizationIdentity {
  workspaceId: string;
  credential: { kind: CredentialKind; id: string };
}
export interface ApplicationOptions extends ResolveConfigOptions {
  identity?: AuthorizationIdentity;
  correlationId?: string;
  imageLockPath?: string;
  dockerCommand?: DockerCommand;
  /** Opens the PostgreSQL server profile (ADR-016) instead of the local SQLite file. */
  server?: ServerConfig;
}
interface SharedRuntime {
  controllers: ControllerRegistry;
  controllerScope?: Application;
}
export class Application {
  readonly context: ServiceContext;
  readonly projects: ProjectsService;
  readonly environments: EnvironmentsService;
  readonly tests: TestsService;
  readonly revisions: RevisionsService;
  readonly approvals: ApprovalsService;
  readonly secrets: SecretsService;
  readonly runs: RunsService;
  readonly batches: BatchesService;
  readonly comparisons: ComparisonsService;
  readonly flake: FlakeService;
  readonly quarantine: QuarantineService;
  readonly worker: WorkerService;
  readonly artifacts: ArtifactsService;
  readonly reports: ReportsService;
  readonly ci: CiService;
  readonly delivery: DeliveryService;
  readonly agentSkills: AgentSkillsService;
  readonly model: ModelService;
  readonly analysis: AnalysisService;
  readonly healing: HealingService;
  readonly uploads: UploadsService;
  readonly sources: SourcesService;
  readonly discovery: DiscoveryService;
  readonly requirements: RequirementsService;
  readonly proposals: ProposalsService;
  readonly usage: UsageService;
  readonly explore: ExploreService;
  readonly agentMode: AgentModeService;
  readonly codeImport: CodeImportService;
  readonly codeExport: CodeExportService;
  readonly codeGeneration: CodeGenerationService;
  readonly resources: ResourcesService;
  readonly audit: AuditService;
  readonly selection: SelectionService;
  readonly database: PersistenceDatabase;
  readonly identityService: IdentityService;
  readonly workspaces: WorkspacesService;
  readonly members: MembersService;
  readonly tokens: TokensService;
  /** Host-trust bootstrap and recovery; callers are trusted by controlling the deployment. */
  readonly operator: OperatorService;
  /** Background loops run by `server start`; shared by every scoped instance. */
  readonly controllers: ControllerRegistry;
  readonly seccompPath = fileURLToPath(
    new URL("../../../containers/seccomp_profile.json", import.meta.url),
  );
  private verifiedImages: ImageLock | null = null;
  private constructor(
    readonly config: ResolvedConfig,
    private readonly root: PersistenceDatabase,
    readonly identity?: AuthorizationIdentity | AuthenticatedIdentity,
    readonly correlation = correlationId(),
    private readonly lockPath = fileURLToPath(
      new URL("../../../containers/images.lock.json", import.meta.url),
    ),
    readonly dockerCommand?: DockerCommand,
    /** Workspace this instance is bound to; `null` spans all (controllers) or the lone SQLite one. */
    private readonly bound: string | null = null,
    private readonly shared: SharedRuntime = { controllers: new ControllerRegistry() },
    readonly serverConfig?: ServerConfig,
  ) {
    const database = root.forWorkspace(bound ?? "*");
    this.database = database;
    this.controllers = shared.controllers;
    // Only the local profile (no deployment configuration) may infer its workspace and principal.
    const implicit = bound === null && !serverConfig;
    const workspaceId =
      bound ??
      (implicit
        ? database.get("SELECT id FROM workspaces ORDER BY created_at LIMIT 1")?.id
        : undefined);
    const principal =
      !identity && workspaceId
        ? database.get(
            "SELECT id FROM principals WHERE workspace_id=? AND kind='human' AND disabled_at IS NULL ORDER BY created_at LIMIT 1",
            workspaceId,
          )
        : undefined;
    this.context = {
      database,
      entities: new EntityRepository(database),
      workspaceId: String(workspaceId ?? ""),
      principalId: identity?.principalId ?? String(principal?.id ?? ""),
      correlationId: correlation,
      // Read live: `init()` assigns the principal after construction.
      get actor(): RunActor {
        return {
          principalId: this.principalId,
          credentialKind: identity && "credential" in identity ? identity.credential.kind : null,
          credentialId: identity && "credential" in identity ? identity.credential.id : null,
        };
      },
      reauthorizeActor: (actor, projectId) => this.reauthorizeActor(actor, projectId),
      authorize: (scope, projectId) => this.authorize(scope, projectId),
      authorizeColumn: (column, projectId) => this.authorizeColumn(column, projectId),
      authorizeRaw: (projectId, environmentId) => {
        this.authorize("R", projectId);
        const role = this.requireMember(projectId);
        const matching = (identity?.grants ?? []).filter(
          (grant) =>
            ["Artifact", "artifacts", "*"].includes(grant.resourceType) &&
            grant.actions.includes("raw") &&
            (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now()) &&
            (!grant.projectIds.length || grant.projectIds.includes(projectId)) &&
            (!grant.environmentIds.length || grant.environmentIds.includes(environmentId)),
        );
        if (
          rbacMatrix[role].export === "deny" ||
          matching.some((grant) => grant.deny) ||
          (identity ? !matching.some((grant) => !grant.deny) : rbacMatrix[role].admin !== "allow")
        )
          throw new ContractError("FORBIDDEN", "Raw evidence requires artifacts:raw permission");
      },
      authorizeNamed: (action, resourceType, projectId, environmentId) =>
        this.authorizeNamed(action, resourceType, projectId, environmentId ?? null),
    };
    this.audit = new AuditService(this.context, config.cwd);
    this.projects = new ProjectsService(this.context);
    this.environments = new EnvironmentsService(this.context);
    this.tests = new TestsService(this.context);
    this.revisions = new RevisionsService(this.context);
    this.approvals = new ApprovalsService(this.context, config);
    this.secrets = new SecretsService(this.context, config);
    this.runs = new RunsService(this.context, {
      config,
      admittedImages: () => this.verifiedImages,
      verifyEvidence: async (id) => {
        await this.artifacts.get(id);
      },
      preflight: (unsafe, executor) => this.preflight(unsafe, executor),
      liveWorker: () => this.worker.live(),
      analysisStatus: (runId) => this.analysis.analysisStatus(runId),
      verifyApproval: (run, test, env) =>
        this.approvals.verify(
          run as unknown as Run,
          test as unknown as TestCase,
          env as unknown as EnvironmentRevision,
        ),
    });
    this.batches = new BatchesService(this.context, this.runs);
    this.retention = new RetentionService(this.context, config);
    this.worker = new WorkerService(this.context, {
      config,
      images: () => this.images(),
      seccompPath: this.seccompPath,
      secrets: this.secrets,
      runs: this.runs,
      retention: this.retention,
      analysis: { settlePending: () => this.analysis.settlePending() },
      healing: { settlePending: () => this.healing.settlePending() },
      ...(this.dockerCommand ? { dockerCommand: this.dockerCommand } : {}),
    });
    this.comparisons = new ComparisonsService(this.context, this.runs, this.batches);
    this.flake = new FlakeService(this.context, this.runs, this.batches, this.worker);
    this.quarantine = new QuarantineService(this.context);
    this.selection = new SelectionService(this.context, this.runs, this.batches, this.quarantine);
    this.artifacts = new ArtifactsService(this.context, config, this.runs);
    this.backups = new BackupsService(this.context, config, this.secrets);
    this.agentSkills = new AgentSkillsService(this.context, config.cwd);
    this.model = new ModelService(this.context, config);
    this.uploads = new UploadsService(this.context, config);
    this.sources = new SourcesService(this.context, config, this.uploads);
    this.discovery = new DiscoveryService(this.context, config, this.sources);
    this.analysis = new AnalysisService(this.context, this.model, this.artifacts, this.discovery);
    this.healing = new HealingService(
      this.context,
      this.model,
      this.runs,
      this.artifacts,
      this.analysis,
    );
    this.reports = new ReportsService(
      this.context,
      config,
      this.runs,
      this.artifacts,
      this.analysis,
    );
    this.ci = new CiService(
      this.selection,
      this.batches,
      this.runs,
      this.worker,
      this.reports,
      this.artifacts,
    );
    this.delivery = new DeliveryService(this.context);
    this.requirements = new RequirementsService(this.context, this.model, this.sources);
    this.proposals = new ProposalsService(this.context, this.model, this.requirements);
    this.usage = new UsageService(this.context);
    this.explore = new ExploreService(this.context, config);
    this.agentMode = new AgentModeService(this.context, config);
    this.codeImport = new CodeImportService(this.context, config);
    this.codeExport = new CodeExportService(this.context, config);
    this.codeGeneration = new CodeGenerationService(this.context, config);
    this.resources = new ResourcesService(this.context, {
      config,
      runs: this.runs,
      approvals: this.approvals,
      secrets: this.secrets,
      images: () => this.images(),
      seccompPath: this.seccompPath,
    });
    this.identityService = new IdentityService(
      this.context,
      root.forWorkspace("*"),
      identity && "credential" in identity && identity.credential.kind === "session"
        ? identity.credential.id
        : null,
    );
    this.workspaces = new WorkspacesService(
      this.context,
      root.forWorkspace("*"),
      identity && "credential" in identity ? identity.credential : null,
    );
    this.members = new MembersService(this.context);
    this.tokens = new TokensService(this.context, () => this);
    this.operator = new OperatorService(root.forWorkspace("*"));
  }
  readonly backups: BackupsService;
  readonly retention: RetentionService;
  static async open(options: ApplicationOptions = {}): Promise<Application> {
    const resolved = await resolveConfig(options);
    // The server profile keeps evidence under its configured root, not the project directory.
    const config = options.server
      ? { ...resolved, dataDir: filesystemRoot(options.server.storage) }
      : resolved;
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    await chmod(config.dataDir, 0o700);
    // PostgreSQL is never migrated implicitly (ADR-015): a schema that is behind is refused.
    const database = options.server
      ? PersistenceDatabase.openPostgres(options.server.database)
      : await PersistenceDatabase.open(join(config.dataDir, "testmaster.db"));
    if (options.server)
      try {
        database.assertCurrent();
      } catch (error) {
        database.close();
        throw error;
      }
    return new Application(
      config,
      database,
      options.identity,
      correlationId(options.correlationId),
      options.imageLockPath,
      options.dockerCommand,
      null,
      undefined,
      options.server,
    );
  }
  close(): void {
    this.root.close();
  }
  /**
   * Request-scoped services bound to the identity's workspace. Without a `workspaceId` (a plain
   * local identity) the single SQLite workspace is used; PostgreSQL refuses to guess.
   */
  forIdentity(
    identity: AuthorizationIdentity | AuthenticatedIdentity,
    correlation = this.correlation,
  ): Application {
    return new Application(
      this.config,
      this.root,
      identity,
      correlationId(correlation),
      this.lockPath,
      this.dockerCommand,
      "workspaceId" in identity ? identity.workspaceId : null,
      this.shared,
      this.serverConfig,
    );
  }
  /** Spans every workspace; for controller loops, migrations, backups and signed webhook intake. */
  controllerScope(): Application {
    if (this.bound === null && !this.identity) return this;
    this.shared.controllerScope ??= new Application(
      this.config,
      this.root,
      undefined,
      correlationId(),
      this.lockPath,
      this.dockerCommand,
      null,
      this.shared,
      this.serverConfig,
    );
    return this.shared.controllerScope;
  }
  /** Acts inside one workspace as its credential-less controller principal. */
  forWorkspaceSystem(workspaceId: string, correlation = this.correlation): Application {
    return this.forIdentity(
      {
        principalId: systemPrincipalId(this.root, workspaceId),
        scopes: ["R", "W", "X", "A"],
        workspaceId,
        credential: { kind: "system", id: `system:${workspaceId}` },
      },
      correlation,
    );
  }
  /** The authenticated caller, their workspace and what their role and grants allow. */
  me(): {
    principal: EntityDocument;
    workspace: EntityDocument;
    membership: EntityDocument;
    permissions: Record<RbacColumn, boolean>;
  } {
    this.context.authorize("R");
    const row = this.database.get(
      "SELECT id FROM memberships WHERE workspace_id=? AND principal_id=?",
      this.context.workspaceId,
      this.context.principalId,
    );
    const found = {
      principal: this.context.entities.get(
        "Principal",
        this.context.workspaceId,
        this.context.principalId,
      ),
      workspace: this.context.entities.get(
        "Workspace",
        this.context.workspaceId,
        this.context.workspaceId,
      ),
      membership: this.context.entities.get(
        "Membership",
        this.context.workspaceId,
        String(row?.id),
      ),
    };
    if (!found.principal || !found.workspace || !found.membership)
      throw new ContractError("UNAUTHENTICATED", "Principal is unavailable");
    const role = this.requireMember();
    const permissions = Object.fromEntries(
      rbacColumns.map((column) => [
        column,
        (!this.identity || this.identity.scopes.includes(columnScope[column])) &&
          this.decide(column, role, undefined, ["*"]).allowed,
      ]),
    ) as Record<RbacColumn, boolean>;
    return {
      principal: found.principal,
      workspace: found.workspace,
      membership: found.membership,
      permissions,
    };
  }
  private authorize(scope: Scope, projectId?: string): void {
    try {
      this.authorizePermission(scope, projectId);
    } catch (error) {
      if (this.context.workspaceId)
        auditSecurity(
          this.context,
          "authorization",
          projectId ?? this.context.workspaceId,
          "denied",
        );
      throw error;
    }
  }
  /** Presence, principal state, membership and project restrictions; returns the member's role. */
  private requireMember(projectId?: string): Role {
    if (!this.context.workspaceId || !this.context.principalId) {
      if (this.serverConfig)
        throw new ContractError("UNAUTHENTICATED", "Authentication is required");
      throw new ContractError("PRECONDITION_FAILED", "Initialize this repository first", {
        nextActions: ["init"],
      });
    }
    const principal = this.context.entities.get(
      "Principal",
      this.context.workspaceId,
      this.context.principalId,
    );
    if (!principal || principal.disabledAt)
      throw new ContractError("UNAUTHENTICATED", "Principal is unavailable");
    const membership = this.database.get(
      "SELECT data_json,role FROM memberships WHERE workspace_id=? AND principal_id=?",
      this.context.workspaceId,
      this.context.principalId,
    );
    if (!membership) throw new ContractError("FORBIDDEN", "Workspace membership is required");
    const member = validate<Membership>("Membership", JSON.parse(String(membership.data_json)));
    if (
      projectId &&
      member.projectRestrictions.length &&
      !member.projectRestrictions.includes(projectId)
    )
      throw new ContractError("FORBIDDEN", "Project is outside membership restrictions");
    return String(membership.role) as Role;
  }
  /**
   * Applies one RBAC column (ADR-017): `allow` is a role default, `deny` can never be widened by a
   * grant, `grant-only` needs a matching non-denied grant. A deny grant always wins.
   */
  private decide(
    column: RbacColumn,
    role: Role,
    projectId: string | undefined,
    resourceTypes: readonly string[],
    environmentId?: string | null,
  ): { allowed: boolean; granted: boolean; grants: number } {
    const grants = this.identity?.grants ?? [];
    for (const grant of grants) validate("PermissionGrant", grant);
    const action = columnGrantAction[column] as PermissionGrant["actions"][number];
    const matching = grants.filter(
      (grant) =>
        resourceTypes.includes(grant.resourceType) &&
        grant.actions.includes(action) &&
        (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now()) &&
        (!projectId || !grant.projectIds.length || grant.projectIds.includes(projectId)) &&
        (environmentId === undefined ||
          !grant.environmentIds.length ||
          (environmentId !== null && grant.environmentIds.includes(environmentId))),
    );
    const granted = matching.some((grant) => !grant.deny);
    const value = rbacMatrix[role][column];
    const allowed =
      !matching.some((grant) => grant.deny) &&
      (value === "allow" || (value === "grant-only" && granted));
    return { allowed, granted, grants: grants.length };
  }
  private authorizePermission(scope: Scope, projectId?: string): void {
    const role = this.requireMember(projectId);
    if (this.identity && !this.identity.scopes.includes(scope))
      throw new ContractError("FORBIDDEN", "Session scope is insufficient", { scope });
    const decision = this.decide(scopeColumn[scope], role, projectId, ["*"]);
    if (!decision.allowed) {
      if (decision.grants)
        auditSecurity(this.context, "grant", projectId ?? this.context.workspaceId, "denied");
      throw new ContractError("FORBIDDEN", "Action is not authorized", { scope });
    }
    if (decision.granted)
      auditSecurity(this.context, "grant", projectId ?? this.context.workspaceId, "allowed");
  }
  /** The `secret` and `export` columns apply on top of the write and read scopes (ADR-017). */
  private authorizeColumn(column: "secret" | "export", projectId?: string): void {
    try {
      const role = this.requireMember(projectId);
      if (this.identity && !this.identity.scopes.includes(columnScope[column]))
        throw new ContractError("FORBIDDEN", "Session scope is insufficient", { scope: column });
      const decision = this.decide(column, role, projectId, ["*", "SecretReference", "secrets"]);
      if (!decision.allowed) {
        if (decision.grants)
          auditSecurity(this.context, "grant", projectId ?? this.context.workspaceId, "denied");
        throw new ContractError("FORBIDDEN", "Action is not authorized", { scope: column });
      }
    } catch (error) {
      if (this.context.workspaceId)
        auditSecurity(
          this.context,
          "authorization",
          projectId ?? this.context.workspaceId,
          "denied",
        );
      throw error;
    }
  }
  /**
   * Named authority is never implied by generic W/X. Role defaults apply only without a bearer
   * identity; remote identities need a matching unexpired, non-denied resource grant that also
   * matches `resourceType`. The matrix still caps what a grant can widen.
   */
  /**
   * Re-evaluates the execute permission of the principal that admitted a Run, with the grants and
   * scopes their credential carries today. A revoked credential, removed member or demoted role fails.
   */
  private reauthorizeActor(actor: RunActor, projectId: string): boolean {
    const workspaceId = this.context.workspaceId;
    let scopes: Scope[] = ["R", "W", "X", "A"];
    let grants: PermissionGrant[] = [];
    if (actor.credentialKind === "session") {
      const row = this.database.get(
        "SELECT revoked_at FROM sessions WHERE workspace_id=? AND id=?",
        workspaceId,
        actor.credentialId,
      );
      if (!row || row.revoked_at) return false;
    } else if (actor.credentialKind && actor.credentialKind !== "system") {
      const row = this.database.get(
        "SELECT data_json,revoked_at FROM server_tokens WHERE workspace_id=? AND id=?",
        workspaceId,
        actor.credentialId,
      );
      if (!row || row.revoked_at) return false;
      const data = JSON.parse(String(row.data_json)) as TokenData;
      scopes = data.scopes;
      grants = data.grants;
    }
    const current = this.forIdentity({
      principalId: actor.principalId,
      scopes,
      grants,
      workspaceId,
      credential: { kind: "system", id: actor.credentialId ?? "reauthorize" },
    });
    try {
      current.context.authorize("X", projectId);
      return true;
    } catch (error) {
      if (error instanceof ContractError) return false;
      throw error;
    }
  }
  private authorizeNamed(
    action: "approve" | "delete",
    resourceType: "HealingProposal" | "Artifact",
    projectId: string,
    environmentId: string | null,
  ): void {
    try {
      this.authorizePermission("R", projectId);
      const principal = this.context.entities.get(
        "Principal",
        this.context.workspaceId,
        this.context.principalId,
      );
      if (action === "approve" && principal?.kind !== "human")
        throw new ContractError("FORBIDDEN", "Approval requires an enabled human principal");
      const role = this.requireMember(projectId);
      const aliases: Record<typeof resourceType, string[]> = {
        HealingProposal: ["HealingProposal", "healing", "*"],
        Artifact: ["Artifact", "artifacts", "*"],
      };
      const column: RbacColumn = action === "approve" ? "write" : "admin";
      const decision = this.decide(column, role, projectId, aliases[resourceType], environmentId);
      const allowed = this.identity
        ? decision.allowed && decision.granted
        : rbacMatrix[role][column] === "allow";
      if (!decision.allowed || !allowed)
        throw new ContractError("FORBIDDEN", "Action is not authorized", {
          scope: `${resourceType === "HealingProposal" ? "healing" : "artifacts"}:${action}`,
        });
      auditSecurity(this.context, "grant", projectId, "allowed");
    } catch (error) {
      if (this.context.workspaceId)
        auditSecurity(this.context, "authorization", projectId, "denied");
      throw error;
    }
  }
  async init(options: { name?: string; baseUrl?: string; overwrite?: boolean } = {}): Promise<{
    workspaceId: string;
    principalId: string;
    projectId: string;
    environmentId: string;
    sessionOnly: boolean;
    notice?: string;
  }> {
    if (this.serverConfig)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "The server profile is initialized with `testmaster server bootstrap`",
      );
    if (this.context.workspaceId) {
      this.context.authorize("W");
      const project = this.projects.list()[0];
      const environment = this.environments.list(project?.id)[0];
      return {
        workspaceId: this.context.workspaceId,
        principalId: this.context.principalId,
        projectId: project?.id ?? "",
        environmentId: environment?.id ?? "",
        sessionOnly: false,
      };
    }
    const workspaceId = uuidV7IdGenerator.next("ws");
    const principalId = uuidV7IdGenerator.next("usr");
    this.context.workspaceId = workspaceId;
    this.context.principalId = principalId;
    this.database.withTx(() => {
      this.context.entities.insert("Workspace", {
        id: workspaceId,
        workspaceId,
        name: options.name ?? "Local workspace",
        mode: "single-user",
        settingsVersion: 1,
        quotaPolicyId: "local",
      });
      this.context.entities.insert("Principal", {
        id: principalId,
        workspaceId,
        kind: "human",
        displayName: "Local developer",
        disabledAt: null,
      });
      this.context.entities.insert(
        "Membership",
        entity(this.context, "mem", { principalId, role: "org_owner", projectRestrictions: [] }),
      );
    });
    const config = this.config.effectiveConfig.config;
    const project = this.projects.create({
      name: options.name ?? config.project?.name ?? "Local project",
    });
    const environment = this.environments.create({
      projectId: project.id,
      name: "local",
      baseUrl: options.baseUrl ?? config.environment?.baseUrl ?? "http://127.0.0.1:3000",
      networkProfile: config.environment?.networkProfile ?? "local-loopback",
      locale: config.environment?.locale ?? "pt-BR",
      timezone: config.environment?.timezone ?? "America/Sao_Paulo",
    });
    this.environments.setDefault(project.id, environment.id, project.version ?? 1);
    config.project = { name: String(project.name), id: project.id };
    const path = join(this.config.cwd, "testmaster.config.json");
    let exists = false;
    try {
      const existing = await lstat(path);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
        throw new ContractError("POLICY_DENIED", "Configuration overwrite target is unsafe");
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (exists && !options.overwrite) {
      /* Existing effective configuration is intentionally preserved. */
    } else
      await writeFile(path, JSON.stringify(config, null, 2), {
        mode: 0o600,
        flag: options.overwrite ? "w" : "wx",
      });
    let sessionOnly = false;
    try {
      const home = await lstat(this.config.home);
      if ((home.mode & 0o222) === 0) throw new Error("read_only_home");
      const dir = join(this.config.home, ".config", "testmaster");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      const profile = join(dir, "profiles.json");
      try {
        await lstat(profile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await writeFile(
          profile,
          JSON.stringify({
            defaultProfile: "local",
            profiles: { local: { config: { schemaVersion: "1.0.0" } } },
          }),
          { mode: 0o600, flag: "wx" },
        );
      }
    } catch {
      sessionOnly = true;
    }
    return {
      workspaceId,
      principalId,
      projectId: project.id,
      environmentId: environment.id,
      sessionOnly,
      ...(sessionOnly ? { notice: "User profile cannot be persisted; session-only setup" } : {}),
    };
  }
  async preflight(
    unsafeLocal = false,
    executor: string = this.config.effectiveConfig.config.execution?.executor ?? "docker",
  ): Promise<void> {
    if (
      this.database.get("SELECT value FROM operational_state WHERE key='admission'")?.value !==
      "enabled"
    )
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Database admission is suspended pending restore review",
      );
    try {
      await access(this.config.dataDir, constants.W_OK);
    } catch {
      throw new ContractError("PRECONDITION_FAILED", "Data directory is not writable", {
        reasonCode: "storage_not_writable",
      });
    }
    const storage = await statfs(this.config.dataDir);
    const used = 1 - Number(storage.bavail) / Number(storage.blocks);
    if (used >= 0.9)
      throw new ContractError("QUOTA_EXCEEDED", "Storage admission suspended at high watermark", {
        reasonCode: "storage_high_watermark",
        usedFraction: used,
        usedPercent: Math.floor(used * 100 + 1e-9),
        path: "<data-dir>",
        options: [
          "testmaster worker reconcile runs eligible retention GC",
          "free space on the data-directory volume outside TestMaster",
          "expand the volume; retention is not shortened automatically",
        ],
      });
    if (executor === "process") {
      if (!unsafeLocal || !this.config.profilePolicy.security.allowUnsafeProcessExecution)
        throw new ContractError(
          "POLICY_DENIED",
          "Unsafe process execution requires flag and user policy",
        );
      return;
    }
    if (executor !== "docker")
      throw new ContractError("CAPABILITY_UNAVAILABLE", "Executor is unavailable", {
        capability: executor,
        milestone: "M5",
      });
    const docker = await new DockerExecutor().doctor();
    if (!docker.available)
      throw new ContractError("POLICY_DENIED", "Hardened Docker sandbox is unavailable", {
        reasonCode: "security_precondition_failed",
        control: "docker",
        diagnostics: docker.diagnostics,
      });
    try {
      const images = await this.images();
      await measureRuntimeIdentities(images, this.seccompPath);
    } catch {
      throw new ContractError("POLICY_DENIED", "Runner image lock or seccomp verification failed", {
        reasonCode: "security_precondition_failed",
        control: "runner_images",
      });
    }
  }
  async images(): Promise<ImageLock> {
    const lock = await verifyImageLock(
      this.lockPath,
      async (imageId) => {
        const result = await dockerCommand(
          ["image", "inspect", imageId, "--format", "{{.Id}}"],
          10000,
        );
        if (result.code !== 0)
          throw new ContractError("POLICY_DENIED", "Pinned runner image is unavailable");
        return result.stdout.toString().trim();
      },
      undefined,
      revokedImageIds(this.database),
    );
    this.verifiedImages = lock;
    return lock;
  }
  /** Durably revokes an image ID: no lock, rollback or restore can make it usable again. */
  revokeImage(imageId: string, reason: string) {
    this.context.authorize("A");
    auditSecurity(this.context, "image.revoke", imageId, "requested");
    const result = revokeImage(this.database, imageId, reason);
    auditSecurity(this.context, "image.revoke", imageId, "allowed");
    return result;
  }
  revokedImages(): string[] {
    this.context.authorize("R");
    return [...revokedImageIds(this.database)].sort();
  }
  async readiness() {
    let persistence = false;
    try {
      const status = this.database.status();
      this.database.withTx(() =>
        this.database.run(
          "INSERT INTO operational_state(key,value) VALUES('readiness:probe',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          new Date().toISOString(),
        ),
      );
      persistence = status.pending.length === 0;
    } catch {}
    let policy = false;
    try {
      const admission = this.database.get(
        "SELECT value FROM operational_state WHERE key='admission'",
      );
      policy =
        admission?.value === "enabled" &&
        Boolean(this.database.get("SELECT id FROM workspaces LIMIT 1"));
    } catch {}
    const runtime = await new DockerExecutor().doctor();
    const runners: Record<string, { status: "ready" | "unavailable" }> = {};
    for (const [runner, image] of [
      ["http", "testmaster-runner"],
      ["playwright", "testmaster-runner"],
      ["python", "testmaster-runner-python"],
    ] as const) {
      let ready = runtime.available;
      if (ready) {
        try {
          const lock = await verifyImageLock(
            this.lockPath,
            async (id) => {
              const result = await dockerCommand(
                ["image", "inspect", id, "--format", "{{.Id}}"],
                10000,
              );
              if (result.code !== 0) throw new Error("Image unavailable");
              return result.stdout.toString().trim();
            },
            [image],
            revokedImageIds(this.database),
          );
          if (runner === "playwright") ready = await this.probeBrowserSandbox(lock[image].imageId);
        } catch {
          ready = false;
        }
      }
      runners[runner] = { status: ready ? "ready" : "unavailable" };
    }
    return {
      status: persistence && policy ? "ready" : "unavailable",
      components: {
        persistence: persistence ? "ready" : "unavailable",
        admission: policy ? "ready" : "unavailable",
      },
      worker: {
        status: Object.values(runners).every((runner) => runner.status === "ready")
          ? "ready"
          : "degraded",
        runners,
      },
    };
  }
  /** Starts Chromium with its own sandbox inside the hardened browser container; true when it launches. */
  private async probeBrowserSandbox(imageId: string): Promise<boolean> {
    const probe = await mkdtemp(join(tmpdir(), "tm-ready-"));
    try {
      await mkdir(join(probe, "input"));
      await mkdir(join(probe, "sockets"));
      const attempt = {
        attemptId: uuidV7IdGenerator.next("att"),
        runId: uuidV7IdGenerator.next("run"),
        kind: "browser" as const,
        imageId,
        inputDir: join(probe, "input"),
        socketsDir: join(probe, "sockets"),
        seccompPath: this.seccompPath,
      };
      const browser = await new DockerExecutor().doctor(attempt);
      if (!browser.available) return false;
      const launched = await new DockerExecutor().execute({
        ...attempt,
        attemptId: uuidV7IdGenerator.next("att"),
        runId: uuidV7IdGenerator.next("run"),
        entrypoint: ["node"],
        command: [
          "--input-type=module",
          "-e",
          "import {chromium} from 'playwright-core'; const browser=await chromium.launch({headless:true,chromiumSandbox:true}); await browser.close();",
        ],
        attemptTimeoutMs: 10000,
        cancellationGraceMs: 0,
      });
      return launched.code === 0;
    } finally {
      await rm(probe, { recursive: true, force: true });
    }
  }
  /**
   * Preflight report. `blocking` names the checks that refuse execution; `recommendations` are
   * advisory (WARN) and never change `status`.
   */
  async doctor(options: { target?: string; nodeVersion?: string } = {}) {
    const node = nodeSupport(options.nodeVersion ?? process.versions.node);
    let lock: ImageLock | null = null;
    let images = "PASS";
    try {
      lock = await this.images();
    } catch {
      images = "FAIL";
    }
    const probeDir = await mkdtemp(join(tmpdir(), "tm-doctor-"));
    await mkdir(join(probeDir, "input"));
    await mkdir(join(probeDir, "sockets"));
    const runtime = await new DockerExecutor().doctor(
      lock
        ? {
            attemptId: uuidV7IdGenerator.next("att"),
            runId: uuidV7IdGenerator.next("run"),
            kind: "browser",
            imageId: lock["testmaster-runner"].imageId,
            inputDir: join(probeDir, "input"),
            socketsDir: join(probeDir, "sockets"),
            seccompPath: this.seccompPath,
          }
        : undefined,
    );
    await rm(probeDir, { recursive: true, force: true });
    let storage = "PASS";
    let availableBytes: number | null = null;
    try {
      const fs = await statfs(this.config.dataDir);
      availableBytes = Number(fs.bavail) * Number(fs.bsize);
      if (availableBytes < 1073741824) storage = "WARN";
    } catch {
      storage = "FAIL";
    }
    let writablePaths: { status: string; pendingCreate?: boolean; diagnostics?: string[] } = {
      status: "PASS",
    };
    try {
      try {
        await access(this.config.dataDir, constants.W_OK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await access(dirname(this.config.dataDir), constants.W_OK);
        writablePaths = { status: "PASS", pendingCreate: true };
      }
    } catch {
      writablePaths = { status: "FAIL", diagnostics: ["data_dir_not_writable"] };
    }
    let database: {
      status: string;
      schemaVersion?: number;
      journalMode?: string;
      diagnostics?: string[];
    };
    try {
      const migrations = this.database.status();
      // The journal mode is a SQLite property; PostgreSQL durability is the server's concern.
      const journalMode =
        this.database.engine === "sqlite"
          ? String(this.database.get("PRAGMA journal_mode")?.journal_mode)
          : undefined;
      const journalHealthy = journalMode === undefined || journalMode === "wal";
      database = {
        status: migrations.pending.length === 0 && journalHealthy ? "PASS" : "FAIL",
        schemaVersion: migrations.currentVersion,
        ...(journalMode === undefined ? {} : { journalMode }),
        ...(migrations.pending.length
          ? { diagnostics: ["migrations_pending"] }
          : journalHealthy
            ? {}
            : { diagnostics: ["database_unavailable"] }),
      };
    } catch {
      database = { status: "FAIL", diagnostics: ["database_unavailable"] };
    }
    const configuredTimezone = this.config.effectiveConfig.config.environment?.timezone;
    const timezone = {
      status:
        configuredTimezone !== undefined && isValidTimeZone(configuredTimezone) ? "PASS" : "WARN",
      configured: configuredTimezone ?? null,
      host: new Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(configuredTimezone !== undefined && isValidTimeZone(configuredTimezone)
        ? {}
        : { diagnostics: ["timezone_not_iana"] }),
    };
    let network: {
      status: string;
      nonLoopbackEnvironmentRevisions?: number;
      telemetry: "enabled" | "disabled";
      diagnostics?: string[];
    } = {
      status: "NOT_CHECKED",
      telemetry:
        this.config.effectiveConfig.config.telemetry?.enabled === true ? "enabled" : "disabled",
    };
    try {
      const revisions = Number(
        this.database.get(
          "SELECT COUNT(*) AS n FROM environment_revisions WHERE network_profile<>'local-loopback'",
        )?.n,
      );
      network = {
        ...network,
        status: revisions > 0 ? "WARN" : "PASS",
        nonLoopbackEnvironmentRevisions: revisions,
        ...(revisions > 0 ? { diagnostics: ["non_loopback_network_profile"] } : {}),
      };
    } catch {
      /* The database check already reports an unreadable store. */
    }
    let browserSandbox: { status: string; diagnostics?: string[]; reason?: string } = {
      status: "NOT_CHECKED",
      reason: "Docker runtime or image lock is unavailable",
    };
    if (lock && runtime.available) {
      let launched = false;
      try {
        launched = await this.probeBrowserSandbox(lock["testmaster-runner"].imageId);
      } catch {
        launched = false;
      }
      browserSandbox = launched
        ? { status: "PASS" }
        : { status: "WARN", diagnostics: ["browser_sandbox_unavailable"] };
    }
    const secrets = await this.secrets.health();
    let target: { status: string; diagnostics?: string[] } = { status: "NOT_CHECKED" };
    if (options.target) {
      const url = new URL(options.target);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Target must be an HTTP URL without credentials",
        );
      try {
        const response = await fetch(url, {
          method: "HEAD",
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
        });
        target = { status: response.status < 500 ? "PASS" : "WARN" };
      } catch {
        target = { status: "FAIL", diagnostics: ["target_unreachable"] };
      }
    }
    const checks = {
      node: {
        status: node.supported ? "PASS" : "FAIL",
        required: node.required,
        actual: node.actual,
      },
      runtime: { status: runtime.available ? "PASS" : "FAIL", ...runtime },
      images: { status: images },
      storage: { status: storage, availableBytes },
      writablePaths,
      database,
      timezone,
      network,
      browserSandbox,
      secrets: { status: secrets.writable ? "PASS" : "WARN", ...secrets },
      config: { status: "PASS", effectiveConfig: exportEffectiveConfig(this.config) },
      target,
      model: this.config.modelProviders.some(
        (provider) =>
          this.config.profilePolicy.allowedModelProviders.includes(provider.id) &&
          provider.models.length,
      )
        ? { status: "NOT_CHECKED", reason: "Model is configured; replay does not contact it" }
        : { status: "ABSENT", diagnostics: ["model_not_configured"], requiredForReplay: false },
    };
    const blocking = (
      ["node", "runtime", "images", "storage", "writablePaths", "database", "target"] as const
    ).filter((name) => checks[name].status === "FAIL");
    const recommendations = [
      ...(storage === "WARN" ? ["Less than 1 GiB is free on the data-directory volume."] : []),
      ...(timezone.status === "WARN"
        ? ["Set environment.timezone to an IANA name such as UTC or America/Sao_Paulo."]
        : []),
      ...(network.status === "WARN"
        ? ["An environment uses a non-loopback network profile; review its egress allowlist."]
        : []),
      ...(browserSandbox.status === "WARN"
        ? ["Browser sandbox is unavailable; HTTP tests stay ready and browser tests are blocked."]
        : []),
      ...(secrets.writable
        ? []
        : ["No writable secure secret backend; secrets need explicit ephemeral mode."]),
      ...(target.status === "WARN" ? ["The probed target answered with a server error."] : []),
      ...(runtime.available && runtime.mode === "rootful"
        ? [
            "Rootful Docker host; rootless is the normative reference and its validation is deferred to M4.",
          ]
        : []),
    ];
    return { status: blocking.length ? "FAIL" : "PASS", blocking, recommendations, checks };
  }
  async capabilities() {
    const docker = await new DockerExecutor().doctor();
    let imageReady = false;
    if (docker.available) {
      try {
        await this.images();
        imageReady = true;
      } catch {}
    }
    const sandboxFeatures: Record<string, true> = {
      "local-execution": true,
      playwright: true,
      http: true,
      python: true,
      docker: true,
      "agent-mode": true,
      resolve_action: true,
      "resources-cleanup": true,
      // M3 features whose core operation dispatches sandboxed Runs (verification, studies, CI).
      healing: true,
      "flake-study": true,
      "selective-run": true,
      ci: true,
    };
    const features = Object.values(capabilityRegistry).map((feature) => {
      const enabled =
        feature.enabled &&
        (!sandboxFeatures[feature.id] || imageReady) &&
        (feature.id !== "unsafe-local" ||
          this.config.profilePolicy.security.allowUnsafeProcessExecution);
      return {
        ...feature,
        enabled,
        disabledReason: enabled
          ? null
          : (feature.disabledReason ?? "Policy or sandbox unavailable"),
      };
    });
    return {
      schemaVersion: "1.0.0",
      features,
      runners: imageReady ? ["playwright", "http", "python"] : [],
      sandbox: docker,
      limits: this.config.effectiveConfig.config.execution,
    };
  }
}
