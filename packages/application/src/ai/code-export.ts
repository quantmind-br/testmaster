import { relative, resolve } from "node:path";
import { ContractError } from "@testmaster/contracts";
import { ConfinedRoot, validateRelativePath } from "@testmaster/evidence";
import {
  type CodeExport,
  type CodeExportOptions,
  exportCode,
  exportImportedCode,
} from "@testmaster/planner";
import { auditedOperation } from "../audit.js";
import { RevisionsService, TestsService } from "../authoring.js";
import type { ResolvedConfig } from "../config.js";
import type { ServiceContext } from "../context.js";
import { CodeImportService } from "./code-import.js";

export interface CodeExportServiceOptions extends CodeExportOptions {
  out?: string;
  revisionId?: string;
}
export interface TestCodeExport extends CodeExport {
  testId: string;
  revisionId: string;
  out?: string;
}

/** Reads an exact immutable revision without invoking a model or releasing secrets. */
export class CodeExportService {
  constructor(
    readonly ctx: ServiceContext,
    readonly config: Pick<ResolvedConfig, "cwd" | "dataDir">,
  ) {}

  async export(testId: string, options: CodeExportServiceOptions): Promise<TestCodeExport> {
    return auditedOperation(this.ctx, "code.export", testId, () =>
      this.exportRevision(testId, options),
    );
  }
  private async exportRevision(
    testId: string,
    options: CodeExportServiceOptions,
  ): Promise<TestCodeExport> {
    if (Object.keys(options).some((key) => !["format", "out", "revisionId", "async"].includes(key)))
      throw new ContractError("INVALID_ARGUMENT", "Unknown code export option");
    const test = new TestsService(this.ctx).get(testId);
    const revisionId = options.revisionId ?? test.activeRevisionId;
    if (!revisionId) throw new ContractError("PRECONDITION_FAILED", "Test has no active revision");
    const revision = new RevisionsService(this.ctx).get(revisionId);
    if (revision.testId !== testId)
      throw new ContractError("INVALID_ARGUMENT", "Export revision belongs to another test");
    let exported: CodeExport;
    if (revision.plan) {
      exported = exportCode(revision.plan, {
        format: options.format,
        ...(options.async === undefined ? {} : { async: options.async }),
      });
    } else {
      const { bundle, dependencyLock } = await new CodeImportService(
        this.ctx,
        this.config,
      ).readBundle(revisionId);
      if (bundle.format !== options.format || options.async !== undefined)
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Imported code export preserves its original format and sync/async source",
        );
      exported = exportImportedCode({
        ...bundle,
        contentHash: revision.contentHash,
        dependencyLock: { ...dependencyLock },
      });
    }
    const result: TestCodeExport = {
      ...exported,
      testId,
      revisionId,
    };
    if (options.out === undefined) return result;
    const destination = resolve(this.config.cwd, options.out);
    const path = relative(this.config.cwd, destination);
    const data = resolve(this.config.dataDir);
    if (!path || destination === data || destination.startsWith(`${data}/`))
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Export must be a new workspace directory outside application data",
      );
    try {
      validateRelativePath(path);
    } catch {
      throw new ContractError("INVALID_ARGUMENT", "Export output must remain inside the workspace");
    }
    const root = new ConfinedRoot(this.config.cwd);
    let directory: ConfinedRoot | undefined;
    let created = false;
    try {
      this.ctx.authorize("W", test.projectId);
      root.mkdirExclusive(path);
      created = true;
      directory = root.openDirectory(path);
      for (const [name, content] of Object.entries(result.files)) {
        const file = await directory.openFile(name, true);
        try {
          await file.writeFile(content, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
      }
      await directory.sync();
      result.out = destination;
      return result;
    } catch (error) {
      if (created) await root.remove(path);
      if (error instanceof ContractError) throw error;
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Code export destination cannot be written safely",
        { cause: (error as NodeJS.ErrnoException).code ?? "unsafe_path" },
      );
    } finally {
      directory?.close();
      root.close();
    }
  }
}
