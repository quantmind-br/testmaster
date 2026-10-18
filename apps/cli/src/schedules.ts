import { readFile } from "node:fs/promises";
import { compileTrigger } from "@testmaster/application";
import {
  ContractError,
  type ScheduleInput,
  type SchedulePatchInput,
  type SchedulePreviewInput,
  validate,
} from "@testmaster/contracts";
import type { Command } from "commander";
import {
  collect,
  integer,
  type Options,
  type Runtime,
  string,
  strings,
  version,
} from "./runtime.js";

type Trigger = SchedulePreviewInput["trigger"];
type Selection = NonNullable<SchedulePatchInput["selection"]>;
type Misfire = NonNullable<SchedulePatchInput["misfire"]>;
type Dependency = NonNullable<SchedulePatchInput["dependsOn"]>[number];
type DependencyCondition = Dependency["condition"];

const number = (options: Options, key: string): number | undefined => {
  const value = options[key];
  return typeof value === "number" ? value : undefined;
};

function triggerOf(options: Options): Trigger | undefined {
  const cron = string(options, "cron");
  const every = number(options, "everySeconds");
  if (cron && every !== undefined)
    throw new ContractError("INVALID_ARGUMENT", "Use --cron or --every-seconds, not both");
  if (cron) {
    const timezone = string(options, "timezone");
    const gap = string(options, "dstGap");
    const fold = string(options, "dstFold");
    return {
      kind: "cron",
      cron,
      ...(timezone ? { timezone } : {}),
      ...(gap ? { dstGap: gap as "skip" | "after_gap" } : {}),
      ...(fold ? { dstFold: fold as "once" | "once_last" | "both" } : {}),
    };
  }
  if (every !== undefined) {
    const anchor = string(options, "anchor");
    if (!anchor)
      throw new ContractError("INVALID_ARGUMENT", "--anchor is required with --every-seconds");
    return { kind: "interval", everySeconds: every, anchor };
  }
  return undefined;
}
function selectionOf(options: Options): Selection | undefined {
  const suite = string(options, "suite");
  const members = strings(options, "member");
  if (suite && members.length)
    throw new ContractError("INVALID_ARGUMENT", "Use --suite or --member, not both");
  if (suite) {
    const policy = string(options, "revisionPolicy");
    return {
      kind: "suite",
      suiteId: suite,
      ...(policy ? { revisionPolicy: policy as "pinned" | "latest_approved" } : {}),
    } as Selection;
  }
  if (members.length)
    return {
      kind: "revisions",
      members: members.map((value) => {
        const [testId, revisionId, environmentId] = value.split(":");
        if (!testId || !revisionId || !environmentId)
          throw new ContractError(
            "INVALID_ARGUMENT",
            "--member expects <test-id>:<revision-id>:<environment-id>",
          );
        return { testId, revisionId, environmentId };
      }),
    } as Selection;
  return undefined;
}
function misfireOf(options: Options): Misfire | undefined {
  const policy = string(options, "misfire");
  const grace = number(options, "graceSeconds");
  const max = number(options, "maxCatchUp");
  const window = number(options, "catchUpWindowSeconds");
  if (!policy) {
    if (grace !== undefined || max !== undefined || window !== undefined)
      throw new ContractError("INVALID_ARGUMENT", "--misfire is required with misfire limits");
    return undefined;
  }
  return {
    policy: policy as Misfire["policy"],
    ...(grace !== undefined ? { graceSeconds: grace } : {}),
    ...(max !== undefined ? { maxCatchUp: max } : {}),
    ...(window !== undefined ? { catchUpWindowSeconds: window } : {}),
  };
}
function dependenciesOf(options: Options): Dependency[] | undefined {
  const values = strings(options, "dependsOn");
  if (!values.length) return undefined;
  return values.map((value) => {
    const [scheduleId, condition, timeout] = value.split(":");
    if (
      !scheduleId ||
      !["passed", "failed", "terminal"].includes(condition ?? "") ||
      !/^\d+$/.test(timeout ?? "")
    )
      throw new ContractError(
        "INVALID_ARGUMENT",
        "--depends-on expects <schedule-id>:<passed|failed|terminal>:<timeout-seconds>",
      );
    return {
      scheduleId,
      condition: condition as DependencyCondition,
      timeoutSeconds: Number(timeout),
    } as Dependency;
  });
}
/** Every definition field named on the command line; a file supplies the base, flags override it. */
async function definitionOf(runtime: Runtime, options: Options): Promise<SchedulePatchInput> {
  const file = string(options, "file");
  const base = file
    ? (JSON.parse(await readFile(runtime.path(file), "utf8")) as SchedulePatchInput)
    : {};
  const trigger = triggerOf(options);
  const selection = selectionOf(options);
  const misfire = misfireOf(options);
  const dependsOn = dependenciesOf(options);
  const autoPause = number(options, "autoPauseAfterFailures");
  const onChange = string(options, "secretsOnChange");
  const heal = string(options, "heal");
  const overlap = string(options, "overlap");
  const replaceTimeout = number(options, "replaceTimeoutSeconds");
  const description = string(options, "description");
  const name = string(options, "name");
  const expiresAt = string(options, "expiresAt");
  return {
    ...base,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(selection ? { selection } : {}),
    ...(trigger ? { trigger } : {}),
    ...(misfire ? { misfire } : {}),
    ...(overlap ? { overlap: overlap as "forbid" | "allow" | "replace" } : {}),
    ...(replaceTimeout !== undefined ? { replaceTimeoutSeconds: replaceTimeout } : {}),
    ...(dependsOn ? { dependsOn } : {}),
    ...(autoPause !== undefined ? { autoPauseAfterFailures: autoPause } : {}),
    ...(onChange ? { secrets: { onChange: onChange as "use_current" | "pause" } } : {}),
    ...(heal ? { healingPolicy: heal as "off" | "propose" } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}
function definitionOptions(command: Command): Command {
  return command
    .option("--file <path>", "JSON definition; flags override its fields")
    .option("--name <name>")
    .option("--description <text>")
    .option("--suite <suite-id>", "Run a list")
    .option("--revision-policy <policy>", "pinned (default) or latest_approved")
    .option("--member <test:revision:environment>", "Run pinned revisions (repeatable)", collect)
    .option("--cron <expression>", "Five-field cron")
    .option("--timezone <iana>", "IANA timezone (default UTC)")
    .option("--dst-gap <policy>", "skip (default) or after_gap")
    .option("--dst-fold <policy>", "once (default), once_last or both")
    .option("--every-seconds <seconds>", "UTC interval instead of cron", integer)
    .option("--anchor <timestamp>", "Interval anchor")
    .option("--misfire <policy>", "skip, fire_once or catch_up")
    .option("--grace-seconds <seconds>", "Misfire grace", integer)
    .option("--max-catch-up <count>", "Catch-up cap", integer)
    .option("--catch-up-window-seconds <seconds>", "Catch-up window", integer)
    .option("--overlap <policy>", "forbid, allow or replace")
    .option("--replace-timeout-seconds <seconds>", "Cancel wait before replacement", integer)
    .option(
      "--depends-on <schedule:condition:timeout>",
      "Wait for another schedule (repeatable)",
      collect,
    )
    .option(
      "--auto-pause-after-failures <count>",
      "Pause after consecutive failed firings",
      integer,
    )
    .option("--secrets-on-change <policy>", "use_current or pause")
    .option("--heal <policy>", "off or propose")
    .option("--expires-at <timestamp>");
}

/** Schedules (REQ-035): revisioned cron or interval triggers over a list, with explicit policies. */
export function scheduleCommands(program: Command, runtime: Runtime): void {
  const group = program.command("schedule").alias("schedules").description("Manage schedules");
  runtime.bind(
    definitionOptions(group.command("create")),
    async (rt, _args, opts) => ({
      data: await (await rt.app()).schedules.create(
        (await definitionOf(rt, opts)) as ScheduleInput,
      ),
    }),
    async (rt, _args, opts) => {
      const input = validate<ScheduleInput>("ScheduleInput", await definitionOf(rt, opts));
      compileTrigger(input.trigger);
      return { data: null };
    },
  );
  runtime.bind(group.command("list"), async (rt) => ({
    data: await (await rt.app()).schedules.list(),
  }));
  runtime.bind(group.command("get <id>"), async (rt, args) => ({
    data: await (await rt.app()).schedules.get(String(args[0])),
  }));
  runtime.bind(
    group
      .command("preview")
      .description("List the next occurrences of a trigger, with DST effects")
      .option("--cron <expression>")
      .option("--timezone <iana>")
      .option("--dst-gap <policy>")
      .option("--dst-fold <policy>")
      .option("--every-seconds <seconds>", "", integer)
      .option("--anchor <timestamp>")
      .option("--from <timestamp>")
      .option("--count <count>", "Occurrences to list (default 10)", integer),
    async (rt, _args, opts) => {
      const trigger = triggerOf(opts);
      if (!trigger)
        throw new ContractError("INVALID_ARGUMENT", "--cron or --every-seconds is required");
      const from = string(opts, "from");
      const count = number(opts, "count");
      return {
        data: (await rt.app()).schedules.preview({
          trigger,
          ...(from ? { from } : {}),
          ...(count !== undefined ? { count } : {}),
        }),
      };
    },
  );
  runtime.bind(
    definitionOptions(group.command("update <id>")).requiredOption(
      "--expected-version <version>",
      "Current version",
      integer,
    ),
    async (rt, args, opts) => ({
      data: await (await rt.app()).schedules.update(
        String(args[0]),
        await definitionOf(rt, opts),
        version(opts),
      ),
    }),
  );
  for (const operation of ["pause", "resume", "archive"] as const)
    runtime.bind(
      group
        .command(`${operation} <id>`)
        .requiredOption("--expected-version <version>", "Current version", integer),
      async (rt, args, opts) => ({
        data: await (await rt.app()).schedules[operation](String(args[0]), version(opts)),
      }),
    );
  runtime.bind(
    group
      .command("history <id>")
      .description("Firing history, newest first, with the batch each firing admitted")
      .option("--limit <count>", "Firings to show (default 50)", integer)
      .option("--revisions", "Show the definition revisions instead"),
    async (rt, args, opts) => {
      const app = await rt.app();
      if (opts.revisions === true) return { data: app.schedules.revisions(String(args[0])) };
      return { data: app.schedules.firings(String(args[0]), number(opts, "limit") ?? 50) };
    },
  );
}
