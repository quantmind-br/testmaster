import {
  ContractError,
  type SuiteInput,
  type SuitePatchInput,
  type SuiteRunInput,
  type SuiteSelection,
  validate,
} from "@testmaster/contracts";
import type { Command } from "commander";
import { waitForBatch } from "./execution.js";
import {
  collect,
  integer,
  type Options,
  type Runtime,
  required,
  seconds,
  string,
  strings,
  version,
} from "./runtime.js";

type Binding = Extract<SuiteSelection, { kind: "dynamic" }>["projects"][number];
type FixedMember = Extract<SuiteSelection, { kind: "fixed" }>["members"][number];
type Priority = NonNullable<NonNullable<Binding["filter"]>["priorities"]>[number];

function pair(value: string, parts: number, flag: string): string[] {
  const items = value.split(":");
  if (items.length !== parts || items.some((item) => !item))
    throw new ContractError(
      "INVALID_ARGUMENT",
      `${flag} expects ${parts === 2 ? "<project-id>:<environment-id>" : "<test-id>:<revision-id>:<environment-id>"}`,
    );
  return items;
}
function filterOf(options: Options): Binding["filter"] | undefined {
  const tags = strings(options, "tag");
  const priorities = strings(options, "priority") as Priority[];
  const nameContains = string(options, "nameContains");
  if (!tags.length && !priorities.length && !nameContains) return undefined;
  return {
    ...(tags.length ? { tags } : {}),
    ...(priorities.length ? { priorities } : {}),
    ...(nameContains ? { nameContains } : {}),
  };
}
/** Bindings and members named on the command line; the filter flags apply to every binding. */
function bindingsOf(options: Options): Binding[] {
  const filter = filterOf(options);
  return strings(options, "binding").map((value) => {
    const [projectId, environmentId] = pair(value, 2, "--binding") as [string, string];
    return { projectId, environmentId, ...(filter ? { filter } : {}) } as Binding;
  });
}
function membersOf(options: Options): FixedMember[] {
  return strings(options, "member").map((value) => {
    const [testId, revisionId, environmentId] = pair(value, 3, "--member") as [
      string,
      string,
      string,
    ];
    return { testId, revisionId, environmentId } as FixedMember;
  });
}
async function selectionOf(
  runtime: Runtime,
  options: Options,
): Promise<SuiteSelection | undefined> {
  const file = string(options, "selectionFile");
  const bindings = bindingsOf(options);
  const members = membersOf(options);
  if (file && (bindings.length || members.length))
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Use --selection-file or --binding/--member, not both",
    );
  if (bindings.length && members.length)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "A list is either dynamic (--binding) or fixed (--member), not both",
    );
  if (file) {
    const selection = JSON.parse(
      (await runtime.readInput(file)).toString("utf8"),
    ) as SuiteSelection;
    validate("SuiteInput", { name: "selection-file", selection });
    return selection;
  }
  if (bindings.length) return { kind: "dynamic", projects: bindings };
  if (members.length) return { kind: "fixed", members };
  return undefined;
}
function selectionOptions(command: Command): Command {
  return command
    .option(
      "--binding <project:environment>",
      "Dynamic list: project with its explicit environment (repeatable)",
      collect,
    )
    .option("--tag <tag>", "Dynamic filter: tag (repeatable)", collect)
    .option("--priority <priority>", "Dynamic filter: priority (repeatable)", collect)
    .option("--name-contains <text>", "Dynamic filter: test name substring")
    .option(
      "--member <test:revision:environment>",
      "Fixed list: pinned revision (repeatable)",
      collect,
    )
    .option("--selection-file <path>", "JSON selection, as the API accepts it");
}
const MEMBER_INTERVAL_HELP =
  "Minimum milliseconds between the starts of consecutive members of a batch (0 clears)";
function suiteInput(
  name: string,
  description: string | undefined,
  selection: SuiteSelection,
  memberIntervalMs?: number,
) {
  return {
    name,
    ...(description ? { description } : {}),
    selection,
    ...(memberIntervalMs === undefined ? {} : { memberIntervalMs }),
  } satisfies SuiteInput;
}
function runInput(options: Options): SuiteRunInput {
  const confirmed = strings(options, "confirmExclusion");
  const hash = string(options, "expansionHash");
  const heal = string(options, "heal");
  return {
    ...(confirmed.length ? { confirmedExclusions: confirmed } : {}),
    ...(hash ? { expectedExpansionHash: hash } : {}),
    ...(heal ? { healingPolicy: heal as "off" | "propose" } : {}),
  };
}

/** Lists (REQ-034): ordered cross-project sets with an explicit environment per project. */
export function suiteCommands(program: Command, runtime: Runtime): void {
  const group = program.command("suite").alias("suites").description("Manage lists of tests");
  runtime.bind(
    selectionOptions(group.command("create"))
      .requiredOption("--name <name>")
      .option("--description <text>")
      .option("--member-interval-ms <ms>", MEMBER_INTERVAL_HELP, integer),
    async (rt, _args, opts) => {
      const selection = await selectionOf(rt, opts);
      if (!selection)
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Name the tests with --binding, --member or --selection-file",
        );
      return {
        data: await (await rt.app()).suites.create(
          suiteInput(
            required(opts, "name"),
            string(opts, "description"),
            selection,
            typeof opts.memberIntervalMs === "number" ? opts.memberIntervalMs : undefined,
          ),
        ),
      };
    },
    async (rt, _args, opts) => {
      const selection = await selectionOf(rt, opts);
      if (!selection) throw new ContractError("INVALID_ARGUMENT", "A selection is required");
      validate(
        "SuiteInput",
        suiteInput(
          required(opts, "name"),
          undefined,
          selection,
          typeof opts.memberIntervalMs === "number" ? opts.memberIntervalMs : undefined,
        ),
      );
      return { data: null };
    },
  );
  runtime.bind(group.command("list"), async (rt) => ({
    data: await (await rt.app()).suites.list(),
  }));
  runtime.bind(group.command("get <id>"), async (rt, args) => ({
    data: await (await rt.app()).suites.get(String(args[0])),
  }));
  runtime.bind(
    group.command("expand <id>").description("Resolve the list now without running it"),
    async (rt, args) => ({ data: await (await rt.app()).suites.expansion(String(args[0])) }),
  );
  runtime.bind(
    selectionOptions(group.command("update <id>"))
      .option("--name <name>")
      .option("--description <text>")
      .option("--member-interval-ms <ms>", MEMBER_INTERVAL_HELP, integer)
      .requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, opts) => {
      const selection = await selectionOf(rt, opts);
      const patch: SuitePatchInput = {
        ...(string(opts, "name") ? { name: string(opts, "name") as string } : {}),
        ...(string(opts, "description")
          ? { description: string(opts, "description") as string }
          : {}),
        ...(typeof opts.memberIntervalMs === "number"
          ? { memberIntervalMs: opts.memberIntervalMs }
          : {}),
        ...(selection ? { selection } : {}),
      };
      return {
        data: await (await rt.app()).suites.update(String(args[0]), patch, version(opts)),
      };
    },
  );
  runtime.bind(
    selectionOptions(
      group.command("add <id>").description("Add projects or pinned members"),
    ).requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, opts) => {
      const app = await rt.app();
      const suite = app.suites.get(String(args[0]));
      const bindings = bindingsOf(opts);
      const members = membersOf(opts);
      if (!bindings.length && !members.length)
        throw new ContractError("INVALID_ARGUMENT", "Name what to add with --binding or --member");
      const next = ((): SuiteSelection => {
        const current = suite.selection;
        if (current.kind === "dynamic") {
          if (members.length)
            throw new ContractError(
              "INVALID_ARGUMENT",
              "A dynamic list takes --binding, not --member",
            );
          return { kind: "dynamic", projects: [...current.projects, ...bindings] };
        }
        if (bindings.length)
          throw new ContractError("INVALID_ARGUMENT", "A fixed list takes --member, not --binding");
        return { kind: "fixed", members: [...current.members, ...members] };
      })();
      return {
        data: await app.suites.update(suite.id, { selection: next }, version(opts)),
      };
    },
  );
  runtime.bind(
    group
      .command("remove <id>")
      .description("Remove a project or a pinned test from the list")
      .option("--from-project <project-id>", "Dynamic list: project to remove")
      .option("--test <test-id>", "Fixed list: test to remove")
      .requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, opts) => {
      const app = await rt.app();
      const suite = app.suites.get(String(args[0]));
      const project = string(opts, "fromProject");
      const test = string(opts, "test");
      if (!project === !test)
        throw new ContractError("INVALID_ARGUMENT", "Name exactly one of --from-project or --test");
      const current = suite.selection;
      const next: SuiteSelection =
        current.kind === "dynamic"
          ? {
              kind: "dynamic",
              projects: current.projects.filter((binding) => binding.projectId !== project),
            }
          : { kind: "fixed", members: current.members.filter((member) => member.testId !== test) };
      if (current.kind === "dynamic" ? !project : !test)
        throw new ContractError(
          "INVALID_ARGUMENT",
          current.kind === "dynamic"
            ? "A dynamic list takes --from-project"
            : "A fixed list takes --test",
        );
      const before = current.kind === "dynamic" ? current.projects.length : current.members.length;
      const after = next.kind === "dynamic" ? next.projects.length : next.members.length;
      if (before === after)
        throw new ContractError("NOT_FOUND", "The list does not contain that entry");
      return { data: await app.suites.update(suite.id, { selection: next }, version(opts)) };
    },
  );
  runtime.bind(
    group
      .command("archive <id>")
      .requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, opts) => ({
      data: await (await rt.app()).suites.archive(String(args[0]), version(opts)),
    }),
  );
  runtime.bind(
    group
      .command("run <id>")
      .description(
        "Admit one frozen BatchRun for the list (a fixed list runs the revisions it pinned, not later promotions); --wait follows every member to its end (no worker needed: runs them here) and exits with the batch result, otherwise follow each member with `run wait <runId>` (receipt memberRuns), then `report export <batchId>`",
      )
      .option(
        "--confirm-exclusion <key>",
        "Run the dispatchable subset and declare this exclusion (repeatable)",
        collect,
      )
      .option("--expansion-hash <digest>", "Refuse unless the list still resolves to this hash")
      .option("--heal <policy>", "Healing policy: off or propose")
      .option("--wait", "Wait for every member; runs them here when no worker is live")
      .option("--timeout <seconds>", "Wait deadline in seconds", seconds)
      .option("--cancel-on-interrupt", "Cancel the members when interrupted while waiting")
      .option("--queue", "Admit even when no worker is live; Runs wait for one")
      .option("--idempotency-key <key>"),
    async (rt, args, opts) => {
      if (opts.wait === true && opts.queue === true)
        throw new ContractError("INVALID_ARGUMENT", "--wait and --queue are mutually exclusive");
      const app = await rt.app();
      const receipt = await app.suites.run(String(args[0]), runInput(opts), {
        origin: "cli",
        ...(opts.wait === true || opts.queue === true ? { wait: true } : {}),
        waitFlags: ["--wait", "--queue"],
        ...(string(opts, "idempotencyKey")
          ? { idempotencyKey: string(opts, "idempotencyKey") as string }
          : {}),
      });
      rt.receipts.push(receipt);
      return opts.wait === true ? waitForBatch(rt, app, receipt, opts) : { data: receipt };
    },
  );
}
