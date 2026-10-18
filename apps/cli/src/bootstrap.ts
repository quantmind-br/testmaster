import { bootstrapProject, confineToRoots } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import { type Command, Option } from "commander";
import { collect, dryRunReport, type Options, type Runtime, required, strings } from "./runtime.js";

type Scope = "codebase" | "diff";
const SCOPES: readonly Scope[] = ["codebase", "diff"];

/** The scopes named with `--scope`, as the MCP tool takes them: at least one, each at most once. */
function scopes(options: Options): Scope[] {
  const named = options.scope === undefined ? ["codebase"] : strings(options, "scope");
  const unknown = named.find((scope) => !SCOPES.includes(scope as Scope));
  if (unknown !== undefined)
    throw new ContractError("INVALID_ARGUMENT", `--scope must be one of: ${SCOPES.join(", ")}`, {
      field: "scope",
    });
  if (new Set(named).size !== named.length)
    throw new ContractError("INVALID_ARGUMENT", "--scope names a scope more than once", {
      field: "scope",
    });
  return named as Scope[];
}

export function bootstrapCommands(program: Command, runtime: Runtime): void {
  runtime.bind(
    program
      .command("bootstrap")
      .description(
        "Create or find the project bound to a root inside the workspace and print its id, a proposed testmaster.config.json, the environment of the target, a preflight and the next actions. Idempotent per root. It never writes a file (write proposedConfig yourself) and never sends a request to the target",
      )
      .option(
        "--root <directory>",
        "Project root; must be inside the workspace directory (default: the workspace directory)",
      )
      .requiredOption(
        "--target-url <url>",
        "http(s) URL of the application under test, without credentials; it is never contacted",
      )
      .option(
        "--scope <scope>",
        `What the project will analyze: ${SCOPES.join(" and/or ")} (repeatable, default codebase)`,
        collect,
      )
      .addOption(
        new Option("--mode <mode>", "Execution mode of the proposed config")
          .choices(["replay", "agent"])
          .default("replay"),
      ),
    async (rt, _args, options) => {
      const app = await rt.app();
      const scope = scopes(options);
      const outcome = await bootstrapProject(
        app,
        {
          projectRoot: options.root === undefined ? "." : required(options, "root"),
          target: required(options, "targetUrl"),
          scope,
          mode: options.mode === "agent" ? "agent" : "replay",
        },
        async (path) =>
          (await confineToRoots(rt.path(path), app.config.cwd, [app.config.cwd])).canonical,
      );
      const { configFile, configPresent, bound, origin, stale, root, ...receipt } = outcome;
      return {
        data: {
          ...receipt,
          nextActions: [
            ...(stale
              ? [
                  `Environment ${stale.name} targets ${stale.origins.join(", ")}, not ${origin}; bootstrap never retargets one. Retarget it with: testmaster env update ${stale.id} --expected-version ${stale.version} --base-url ${origin}`,
                ]
              : []),
            ...(bound
              ? []
              : configPresent
                ? [`Set project.id to ${outcome.projectId} in ${configFile}`]
                : [`Write proposedConfig as ${configFile} (bootstrap never writes a file)`]),
            "Add sources with: testmaster source add <path> --role <role>",
            ...scope.map((item) =>
              item === "codebase"
                ? `Analyze the code with: testmaster discover --project ${outcome.projectId} --root ${root}`
                : `Analyze a change with: testmaster discover --project ${outcome.projectId} --root ${root} --scope diff --base <ref> --working-tree`,
            ),
          ],
        },
      };
    },
    (_rt, _args, options) => {
      scopes(options);
      required(options, "targetUrl");
      return dryRunReport(
        [
          {
            operation: "bootstrap.project",
            root:
              options.root === undefined ? "the workspace directory" : required(options, "root"),
            records:
              "the project bound to the root, found or created, and an environment for the target origin when the project has none",
          },
        ],
        [
          "the root must be inside the workspace directory",
          "the target must be an http(s) URL without credentials",
          "a project with the root's name that is not bound to it refuses the call",
        ],
      );
    },
  );
}
