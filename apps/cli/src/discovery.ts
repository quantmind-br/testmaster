import { codeAnalysisReceipt, type DiscoveryDetail } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import { type Command, Option } from "commander";
import { listOrPage, withPaging, writeJsonOut } from "./paging.js";
import { collect, type Options, type Runtime, required, string, strings } from "./runtime.js";

function input(runtime: Runtime, options: Options) {
  const scope = string(options, "scope") ?? "codebase";
  const base = string(options, "base");
  const head = string(options, "head");
  const workingTree = options.workingTree === true;
  if (scope === "diff" && (!base || (!head && !workingTree)))
    throw new ContractError(
      "PRECONDITION_REQUIRED",
      "Diff discovery requires --base, plus --head or --working-tree",
    );
  if (head && workingTree)
    throw new ContractError("INVALID_ARGUMENT", "--head and --working-tree are mutually exclusive");
  if (scope !== "diff" && (base || head || workingTree))
    throw new ContractError("INVALID_ARGUMENT", "Diff references require --scope diff");
  return {
    scope: scope as "codebase" | "diff",
    ...(string(options, "root") ? { root: runtime.path(required(options, "root")) } : {}),
    ...(base ? { base } : {}),
    ...(head ? { head } : {}),
    ...(workingTree ? { workingTree } : {}),
    ...(options.sourceRevision !== undefined
      ? { sourceRevisionIds: strings(options, "sourceRevision") }
      : {}),
    ...(options.exclude !== undefined ? { excludes: strings(options, "exclude") } : {}),
    ...(string(options, "resume") ? { resume: required(options, "resume") } : {}),
    ...(string(options, "inputsFingerprint")
      ? { inputsFingerprint: required(options, "inputsFingerprint") }
      : {}),
    ...(string(options, "provider") ? { provider: required(options, "provider") } : {}),
    ...(string(options, "model") ? { model: required(options, "model") } : {}),
  };
}

/**
 * The default `discover` answer: the job, the status and the same bounded receipt MCP
 * `testmaster_analyze_code` returns. `--full` prints the stored discovery and `--out` writes it to
 * a file; `feature list` pages the features.
 */
function discoveryReceipt(detail: DiscoveryDetail) {
  const statuses = new Map<string, { status: string; errors: string[]; count: number }>();
  for (const result of detail.job.perFeatureResults) {
    const key = `${result.status}:${result.errors.join(",")}`;
    const known = statuses.get(key);
    if (known) known.count += 1;
    else statuses.set(key, { status: result.status, errors: result.errors, count: 1 });
  }
  return {
    job: {
      id: detail.job.id,
      phase: detail.job.phase,
      inputsFingerprint: detail.job.inputsFingerprint,
    },
    status: detail.status,
    featureStatuses: [...statuses.values()],
    ...codeAnalysisReceipt(detail),
    hint: "Run again with --out <path> to write every skipped file, warning and feature to a file (or --full to print them); `feature list` pages the features",
  };
}

export function discoveryCommands(program: Command, runtime: Runtime): void {
  runtime.bind(
    program
      .command("discover")
      .addOption(new Option("--scope <scope>").choices(["codebase", "diff"]).default("codebase"))
      .option("--root <path>")
      .option("--base <ref>")
      .option("--head <ref>")
      .option("--working-tree")
      .option("--source-revision <id>", "Source revision (repeatable)", collect)
      .option("--exclude <pattern>", "Excluded path (repeatable)", collect)
      .option("--resume <job-id>")
      .option("--inputs-fingerprint <hash>")
      .option("--provider <id>")
      .option("--model <id>")
      .option(
        "--full",
        "Print the whole stored discovery (every skipped file and feature, megabytes on a large repository) instead of the bounded receipt",
      )
      .option(
        "--out <path>",
        "Write the whole stored discovery to this new file (compact JSON) and print the bounded receipt with the file's path, bytes and sha256; not with --full",
      ),
    async (rt, _args, options) => {
      const out = string(options, "out");
      if (out !== undefined && options.full === true)
        throw new ContractError("INVALID_ARGUMENT", "--out cannot be combined with --full");
      const detail = await (await rt.app()).discovery.discover({
        ...input(rt, options),
        projectId: await rt.project(options),
      });
      if (options.full === true) return { data: detail };
      if (out !== undefined)
        return { data: { ...discoveryReceipt(detail), out: await writeJsonOut(rt, out, detail) } };
      return { data: discoveryReceipt(detail) };
    },
    (rt, _args, options) => {
      input(rt, options);
      if (string(options, "out") !== undefined && options.full === true)
        throw new ContractError("INVALID_ARGUMENT", "--out cannot be combined with --full");
      return { data: null };
    },
  );
  const features = program.command("feature").alias("features");
  runtime.bind(
    withPaging(
      features
        .command("list")
        .description(
          "The project's current features ordered by stable key; --limit/--cursor pages them",
        )
        .option(
          "--match <text>",
          "Only features whose stable key contains this text (case-insensitive)",
        ),
      100,
    ),
    async (rt, _args, options) => {
      const projectId = await rt.project(options);
      const match = string(options, "match");
      return {
        data: await listOrPage(
          rt,
          (await rt.app()).discovery.listFeatures(projectId, match),
          `features:${projectId}:${match ?? ""}`,
          options,
        ),
      };
    },
  );
}
