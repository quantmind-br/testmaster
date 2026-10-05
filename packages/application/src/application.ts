import { chmod, lstat, mkdir, mkdtemp, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContractError,
  capabilityRegistry,
  type EnvironmentRevision,
  type Membership,
  type Run,
  type TestCase,
  validate,
} from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { EntityRepository, PersistenceDatabase } from "@testmaster/persistence";
import {
  DockerExecutor,
  dockerCommand,
  type ImageLock,
  verifyImageLock,
} from "@testmaster/sandbox";
import { ApprovalsService } from "./approvals.js";
import { ArtifactsService, ReportsService } from "./artifacts.js";
import {
  EnvironmentsService,
  ProjectsService,
  RevisionsService,
  TestsService,
} from "./authoring.js";
import { BackupsService } from "./backups.js";
import { type ResolveConfigOptions, type ResolvedConfig, resolveConfig } from "./config.js";
import { entity, type Scope, type ServiceContext } from "./context.js";
import { RetentionService } from "./retention.js";
import { BatchesService, RunsService } from "./runs.js";
import { SecretsService } from "./secrets.js";
import { WorkerService } from "./worker.js";

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
}
export interface ApplicationOptions extends ResolveConfigOptions {
  identity?: AuthorizationIdentity;
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
  readonly worker: WorkerService;
  readonly artifacts: ArtifactsService;
  readonly reports: ReportsService;
  readonly seccompPath = fileURLToPath(
    new URL("../../../containers/seccomp_profile.json", import.meta.url),
  );
  private readonly lockPath = fileURLToPath(
    new URL("../../../containers/images.lock.json", import.meta.url),
  );
  private constructor(
    readonly config: ResolvedConfig,
    readonly database: PersistenceDatabase,
    readonly identity?: AuthorizationIdentity,
  ) {
    const workspace = database.get("SELECT id FROM workspaces ORDER BY created_at LIMIT 1");
    const principal = database.get(
      "SELECT id FROM principals WHERE workspace_id=? AND kind='human' AND disabled_at IS NULL ORDER BY created_at LIMIT 1",
      workspace?.id ?? "",
    );
    this.context = {
      database,
      entities: new EntityRepository(database),
      workspaceId: String(workspace?.id ?? ""),
      principalId: identity?.principalId ?? String(principal?.id ?? ""),
      authorize: (scope, projectId) => this.authorize(scope, projectId),
    };
    this.projects = new ProjectsService(this.context);
    this.environments = new EnvironmentsService(this.context);
    this.tests = new TestsService(this.context);
    this.revisions = new RevisionsService(this.context);
    this.approvals = new ApprovalsService(this.context);
    this.secrets = new SecretsService(this.context, config);
    this.runs = new RunsService(this.context, {
      config,
      preflight: (unsafe, executor) => this.preflight(unsafe, executor),
      liveWorker: () => this.worker.live(),
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
    });
    this.artifacts = new ArtifactsService(this.context, config, this.runs);
    this.reports = new ReportsService(this.context, config, this.runs, this.artifacts);
    this.backups = new BackupsService(this.context, config);
  }
  readonly backups: BackupsService;
  readonly retention: RetentionService;
  static async open(options: ApplicationOptions = {}): Promise<Application> {
    const config = await resolveConfig(options);
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    await chmod(config.dataDir, 0o700);
    return new Application(
      config,
      await PersistenceDatabase.open(join(config.dataDir, "testmaster.db")),
      options.identity,
    );
  }
  close(): void {
    this.database.close();
  }
  private authorize(scope: Scope, projectId?: string): void {
    if (!this.context.workspaceId || !this.context.principalId)
      throw new ContractError("PRECONDITION_FAILED", "Initialize this repository first", {
        nextActions: ["init"],
      });
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
    const role = String(membership.role);
    const defaults: Record<string, Scope[]> = {
      org_owner: ["R", "W", "X", "A"],
      org_admin: ["R", "W", "X", "A"],
      maintainer: ["R", "W", "X"],
      runner: ["R", "X"],
      reviewer: ["R", "W"],
      viewer: ["R"],
      service_account: [],
    };
    const member = validate<Membership>("Membership", JSON.parse(String(membership.data_json)));
    if (
      projectId &&
      member.projectRestrictions.length &&
      !member.projectRestrictions.includes(projectId)
    )
      throw new ContractError("FORBIDDEN", "Project is outside membership restrictions");
    if (this.identity && !this.identity.scopes.includes(scope))
      throw new ContractError("FORBIDDEN", "Session scope is insufficient", { scope });
    const action = { R: "read", W: "write", X: "execute", A: "admin" }[scope];
    const grants = this.identity?.grants ?? [];
    for (const grant of grants) validate("PermissionGrant", grant);
    const matching = grants.filter(
      (grant) =>
        (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now()) &&
        grant.actions.includes(action as PermissionGrant["actions"][number]) &&
        (!projectId || !grant.projectIds.length || grant.projectIds.includes(projectId)),
    );
    if (
      matching.some((grant) => grant.deny) ||
      (!(defaults[role] ?? []).includes(scope) && !matching.some((grant) => !grant.deny))
    )
      throw new ContractError("FORBIDDEN", "Action is not authorized", { scope });
  }
  async init(options: { name?: string; baseUrl?: string; overwrite?: boolean } = {}): Promise<{
    workspaceId: string;
    principalId: string;
    projectId: string;
    environmentId: string;
    sessionOnly: boolean;
    notice?: string;
  }> {
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
    const storage = await statfs(this.config.dataDir);
    const used = 1 - Number(storage.bavail) / Number(storage.blocks);
    if (used >= 0.9)
      throw new ContractError("QUOTA_EXCEEDED", "Storage admission suspended at high watermark", {
        usedFraction: used,
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
        diagnostics: docker.diagnostics,
      });
    try {
      await this.images();
    } catch {
      throw new ContractError("POLICY_DENIED", "Runner image lock or seccomp verification failed");
    }
  }
  async images(): Promise<ImageLock> {
    return verifyImageLock(this.lockPath, async (imageId) => {
      const result = await dockerCommand(
        ["image", "inspect", imageId, "--format", "{{.Id}}"],
        10000,
      );
      if (result.code !== 0)
        throw new ContractError("POLICY_DENIED", "Pinned runner image is unavailable");
      return result.stdout.toString().trim();
    });
  }
  async doctor(options: { target?: string } = {}) {
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
    return {
      status:
        !runtime.available || images === "FAIL" || storage === "FAIL" || target.status === "FAIL"
          ? "FAIL"
          : "PASS",
      checks: {
        runtime: { status: runtime.available ? "PASS" : "FAIL", ...runtime },
        images: { status: images },
        storage: { status: storage, availableBytes },
        secrets: { status: secrets.writable ? "PASS" : "WARN", ...secrets },
        config: { status: "PASS", effectiveConfig: this.config.effectiveConfig },
        target,
        model: { status: "DISABLED", reason: "No model calls in replay" },
      },
    };
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
    };
    const features = Object.values(capabilityRegistry).map((feature) => {
      const enabled =
        feature.enabled &&
        feature.milestone !== "M2" &&
        (!sandboxFeatures[feature.id] || imageReady) &&
        (feature.id !== "unsafe-local" ||
          this.config.profilePolicy.security.allowUnsafeProcessExecution);
      return {
        ...feature,
        enabled,
        disabledReason: enabled
          ? null
          : feature.milestone === "M2"
            ? "M2 application surface is not yet enabled"
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
