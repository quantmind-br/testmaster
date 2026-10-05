import { ContractError } from "@testmaster/contracts";
import { type Command, Option } from "commander";
import { collect, type Options, type Runtime, required, string, strings } from "./runtime.js";

function input(runtime: Runtime, options: Options) {
  const scope = string(options, "scope") ?? "codebase";
  const base = string(options, "base");
  const head = string(options, "head");
  const workingTree = options.workingTree === true;
  if (scope === "diff" && (!base || (!head && !workingTree)))
    throw new ContractError(
      "PRECONDITION_REQUIRED",
      "Diff discovery requires --base and --head or --working-tree",
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
      .option("--model <id>"),
    async (rt, _args, options) => ({
      data: await (await rt.app()).discovery.discover({
        ...input(rt, options),
        projectId: await rt.project(options),
      }),
    }),
    (rt, _args, options) => {
      input(rt, options);
      return { data: null };
    },
  );
}
