import type * as ChildProcess from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { compileTrigger, lintPlan } from "@testmaster/application";
import { authKinds, jsonSchema, validate } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import type { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCli, runCli } from "./cli.js";
import { type InputExample, inputExamples } from "./examples.js";
import { commandPath } from "./remote.js";
import { Runtime } from "./runtime.js";

// Hermetic: the encrypted file vault, never the host keyring.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: vi.fn(() => {
    throw Object.assign(new Error("Unavailable"), { code: "ENOENT" });
  }),
}));

interface Document {
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}
const cleanups: (() => Promise<void> | void)[] = [];
const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.stubEnv("CI", "true");
});
afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function invoke(args: string[]) {
  let stdout = "";
  const sink = (append: (text: string) => void) =>
    new Writable({
      write(chunk, _encoding, callback) {
        append(String(chunk));
        callback();
      },
    });
  process.exitCode = undefined;
  await runCli(
    ["--json", ...args],
    new Runtime(
      sink((text) => {
        stdout += text;
      }),
      sink(() => {}),
    ),
  );
  return { exit: process.exitCode ?? 0, document: JSON.parse(stdout) as Document };
}
async function emptyRoot() {
  const root = await mkdtemp(join(tmpdir(), "tm-cli-examples-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "home"));
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "home", ".config"));
  return root;
}

// --- The audit: which options read a JSON document -----------------------------------------------

/**
 * Options and positional arguments that name a file or directory but are NOT a JSON document an
 * agent writes by hand: an output destination, a directory, a code or raw-secret file, or a file
 * another command produced. Everything else that names a file must have an `--example`.
 */
const notAuthoredJson: Record<string, string> = {
  "artifact get --out": "output destination",
  "artifact import-fixture <path>": "binary fixture bytes",
  "audit export --out": "output destination",
  "audit verify <path>": "file written by `audit export`",
  "auth-profile export-state --out": "output destination",
  "backup create --out": "output destination",
  "backup restore <path>": "backup directory",
  "backup restore --out": "output destination",
  "backup verify <path>": "backup directory",
  "ci init github --setup-script": "shell script of the runtime image",
  "ci init github --workflow-file": "output destination",
  "ci publish --envelope": "file written by `ci run`",
  "ci run --output-dir": "output directory",
  "contract schema --out": "output destination",
  "db upgrade --backup-out": "output directory",
  "discover --out": "output destination",
  "discover --root": "source directory",
  "mcp serve --root": "approved directory",
  "mcp serve --token-file": "token file, plain text",
  "report export --out": "output destination",
  "plan get --out": "output destination",
  "secret rotate --file": "raw secret value, plain text",
  "secret set --file": "raw secret value, plain text",
  "server keygen --out": "output destination",
  "server start --token-file": "token file, plain text",
  "source add --file": "requirements source in any format; --format picks the parser",
  "source add <path>": "requirements source in any format; --format picks the parser",
  "test create --code": "Playwright or pytest source, not JSON",
  "test export --out": "output destination",
  "test import --path": "Playwright or pytest source, not JSON",
  "test lint --dir": "directory of plan files, each shaped as the --plan example",
  "token issue --token-file": "output destination for the token",
  "usage --out": "output destination",
  "worker start --enroll-token-file": "token file, plain text",
};

interface FileInput {
  /** `schedule create`. */
  command: string;
  /** `--file`, or `<path>` for a positional argument. */
  flag: string;
}
const NAMES_A_FILE = /<(path|file|document)>/u;
function leaves(command: Command): Command[] {
  return command.commands.length ? command.commands.flatMap(leaves) : [command];
}
/** Every option or argument of the real command tree that names a file or directory. */
function fileInputs(program: Command): FileInput[] {
  return leaves(program).flatMap((command) => [
    ...command.options
      .filter((option) => NAMES_A_FILE.test(option.flags))
      .map((option) => ({ command: commandPath(command), flag: option.long as string })),
    ...command.registeredArguments
      .filter((argument) => ["path", "file", "document"].includes(argument.name()))
      .map((argument) => ({ command: commandPath(command), flag: `<${argument.name()}>` })),
  ]);
}
const program = () => createCli(new Runtime());

it("every option that reads a JSON document has an --example, or is classified as not authored JSON", () => {
  const unclassified = fileInputs(program()).filter(
    ({ command, flag }) =>
      inputExamples[command]?.option !== flag && !(`${command} ${flag}` in notAuthoredJson),
  );
  expect(
    unclassified.map((input) => `${input.command} ${input.flag}`),
    "add an inputExamples entry in examples.ts (or classify it in notAuthoredJson with a reason)",
  ).toEqual([]);
});

it("the example registry and the classification name real options of the command tree", () => {
  const detected = fileInputs(program());
  const has = (command: string, flag: string) =>
    detected.some((input) => input.command === command && input.flag === flag);
  for (const [command, entry] of Object.entries(inputExamples))
    expect(has(command, entry.option), `${command} has no ${entry.option}`).toBe(true);
  for (const key of Object.keys(notAuthoredJson)) {
    const flag = key.slice(key.lastIndexOf(" ") + 1);
    const command = key.slice(0, key.lastIndexOf(" "));
    expect(has(command, flag), `${key} is not a file option`).toBe(true);
    expect(inputExamples[command]?.option, `${key} is also in inputExamples`).not.toBe(flag);
  }
  for (const [command, entry] of Object.entries(inputExamples))
    expect(
      Boolean(entry.content) !== Boolean(entry.variants),
      `${command}: content xor variants`,
    ).toBe(true);
});

// --- Every sample is valid -----------------------------------------------------------------------

/** Each sample of an entry: one, or one per mode. */
function samples(entry: InputExample): { variant: string | undefined; content: unknown }[] {
  if (entry.variants)
    return Object.entries(entry.variants.samples).map(([variant, sample]) => ({
      variant,
      content: sample(),
    }));
  return [{ variant: undefined, content: (entry.content as () => unknown)() }];
}
const projectId = uuidV7IdGenerator.next("prj");
/** The check of commands that read a file but have no registered contract of their own. */
const ownChecks: Record<string, (content: unknown) => void> = {
  // The command's own patch rules: only text and acceptanceCriteria, at least one.
  "requirement update": (content) => {
    const patch = content as { text?: unknown; acceptanceCriteria?: unknown };
    expect(Object.keys(patch).sort()).toEqual(["acceptanceCriteria", "text"]);
    expect(typeof patch.text).toBe("string");
    expect((patch.acceptanceCriteria as unknown[]).every((item) => typeof item === "string")).toBe(
      true,
    );
  },
  // `suite` reads a whole selection and validates it as the selection of a SuiteInput.
  "suite create": (content) => validate("SuiteInput", { name: "sample", selection: content }),
  "suite update": (content) => validate("SuiteInput", { name: "sample", selection: content }),
  "suite add": (content) => validate("SuiteInput", { name: "sample", selection: content }),
  // The service accepts at most 20 typed, locator-bearing form actions, each a valid plan Step.
  explore: (content) => {
    const steps = content as { operation: string; input: object }[];
    expect(Array.isArray(steps) && steps.length >= 1 && steps.length <= 20).toBe(true);
    for (const step of steps) {
      validate("Step", step);
      expect(["click", "fill", "press", "select", "check", "uncheck"]).toContain(step.operation);
      expect(step.input).toHaveProperty("locator");
    }
  },
};

it("every sample, of every mode, passes the contract its command validates it against", () => {
  for (const [command, entry] of Object.entries(inputExamples)) {
    for (const { variant, content } of samples(entry)) {
      const label = `${command}${variant ? ` --${entry.variants?.option.slice(2)} ${variant}` : ""}`;
      expect(() => {
        if (entry.contract === "ExecutablePlan") lintPlan(JSON.stringify(content));
        else if (entry.contract)
          validate(entry.contract, entry.project ? { ...(content as object), projectId } : content);
        else
          (
            ownChecks[command] ??
            (() => {
              throw new Error("neither a contract nor an ownCheck");
            })
          )(content);
      }, label).not.toThrow();
      if (entry.project) expect(content, label).not.toHaveProperty("projectId");
    }
  }
});
function branchKinds(contract: string, property: string): string[] {
  const schema = jsonSchema(contract) as {
    properties: Record<string, { anyOf: { properties: { kind: { const: string } } }[] }>;
  };
  const union = schema.properties[property];
  if (!union) throw new Error(`${contract} has no ${property}`);
  return union.anyOf.map((branch) => branch.properties.kind.const);
}
const contents = (command: string) => samples(inputExamples[command] as InputExample);

it("the samples cover every mode the contract distinguishes", () => {
  // auth-profile: every kind of AuthProfileInput, with its own `kind`; plus the browser form login.
  const auth = inputExamples["auth-profile create"] as InputExample;
  const byVariant = Object.fromEntries(samples(auth).map((s) => [s.variant, s.content]));
  expect(Object.keys(byVariant).sort()).toEqual([...authKinds, "form-browser"].sort());
  for (const kind of authKinds) expect(byVariant[kind]).toMatchObject({ kind });
  expect(byVariant["form-browser"]).toMatchObject({ kind: "form", config: { browser: {} } });
  expect(byVariant.form).toMatchObject({ config: { http: {} } });
  // lists: fixed and dynamic selections.
  expect(
    contents("suite create")
      .map((s) => (s.content as { kind: string }).kind)
      .sort(),
  ).toEqual(branchKinds("SuiteInput", "selection").sort());
  // schedules: both trigger kinds and both selection kinds, in the create and the update sample.
  for (const command of ["schedule create", "schedule update"]) {
    const found = contents(command).map((s) => s.content as Record<string, { kind: string }>);
    const triggers = new Set(found.flatMap((c) => (c.trigger ? [c.trigger.kind] : [])));
    const selections = new Set(found.flatMap((c) => (c.selection ? [c.selection.kind] : [])));
    expect([...triggers].sort(), command).toEqual(branchKinds("ScheduleInput", "trigger").sort());
    expect([...selections].sort(), command).toEqual(
      branchKinds("ScheduleInput", "selection").sort(),
    );
  }
  // plans: one per application type, each of that type.
  for (const command of ["test create", "test lint", "test revision create", "plan edit"]) {
    const plans = contents(command);
    expect(plans.map((s) => s.variant).sort(), command).toEqual(["backend", "cli", "frontend"]);
    for (const plan of plans) expect(plan.content).toMatchObject({ type: plan.variant });
  }
});

it("schedule samples compile their trigger", () => {
  for (const command of ["schedule create", "schedule update"])
    for (const { content } of contents(command)) {
      const trigger = (content as { trigger?: Parameters<typeof compileTrigger>[0] }).trigger;
      if (trigger) expect(() => compileTrigger(trigger)).not.toThrow();
    }
});

// --- What `--example` prints ---------------------------------------------------------------------

it("--example prints the default sample and, with the variant flag, each mode (spaced or =)", async () => {
  const root = await emptyRoot();
  for (const [command, entry] of Object.entries(inputExamples)) {
    const path = command.split(" ");
    const printed = async (...extra: string[]) => {
      const result = await invoke(["--cwd", root, ...path, "--example", ...extra]);
      expect(result.exit, `${command} ${extra.join(" ")}`).toBe(0);
      const fixture = result.document.data?.fixture as {
        input: { option: string; contract?: string; content: unknown; variant?: unknown };
      };
      return fixture.input;
    };
    if (!entry.variants) {
      expect((await printed()).content).toEqual((entry.content as () => unknown)());
      continue;
    }
    const { option, default: fallback, samples: modes } = entry.variants;
    const available = Object.keys(modes);
    const bare = await printed();
    expect(bare.content, `${command} default`).toEqual((modes[fallback] as () => unknown)());
    expect(bare.variant).toEqual({ option, selected: fallback, available });
    for (const [mode, sample] of Object.entries(modes)) {
      const spaced = await printed(option, mode);
      expect(spaced.content, `${command} ${option} ${mode}`).toEqual(sample());
      expect(spaced.option).toBe(entry.option);
      expect(spaced.variant).toMatchObject({ selected: mode });
      expect((await printed(`${option}=${mode}`)).content).toEqual(sample());
    }
    // Negative control: an unknown mode is refused and names the choices, never a silent default.
    const unknown = await invoke(["--cwd", root, ...path, "--example", option, "no-such-mode"]);
    expect(unknown.exit).not.toBe(0);
    expect(unknown.document.error).toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { choices: available },
    });
  }
});

it("the variant flag is refused when the command runs for real, never ignored", async () => {
  const root = await emptyRoot();
  await writeFile(join(root, "plan.json"), JSON.stringify(contents("test lint")[0]?.content));
  const kind = await invoke([
    "--cwd",
    root,
    "auth-profile",
    "create",
    "--file",
    "p.json",
    "--kind",
    "basic",
  ]);
  expect(kind.document.error).toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(kind.document.error?.message).toContain("only selects the sample printed by --example");
  const type = await invoke([
    "--cwd",
    root,
    "test",
    "lint",
    "--plan",
    "plan.json",
    "--type",
    "cli",
  ]);
  expect(type.document.error).toMatchObject({ code: "INVALID_ARGUMENT" });
  // A value outside the choices is refused by the option itself.
  const bad = await invoke([
    "--cwd",
    root,
    "test",
    "lint",
    "--plan",
    "plan.json",
    "--type",
    "mobile",
  ]);
  expect(bad.document.error).toMatchObject({ code: "INVALID_ARGUMENT" });
});

// --- The samples work for real -------------------------------------------------------------------

it("every plan, selection, schedule and requirement sample is accepted by the command that reads it", async () => {
  const root = await emptyRoot();
  const file = join(root, "input.json");
  const dry = async (content: unknown, ...args: string[]) => {
    await writeFile(file, JSON.stringify(content));
    const result = await invoke(["--cwd", root, "--dry-run", ...args, "input.json"]);
    expect(result.document.error, args.join(" ")).toBeUndefined();
    expect(result.document.data, args.join(" ")).toMatchObject({ dryRun: true, validated: true });
  };
  for (const { content } of contents("test lint")) {
    await dry(content, "test", "lint", "--plan");
    await dry(content, "test", "create", "--plan");
  }
  for (const { content } of contents("schedule create"))
    await dry(content, "schedule", "create", "--file");
  for (const { content } of contents("suite create"))
    await dry(content, "suite", "create", "--name", "sample", "--selection-file");
  await dry(
    contents("requirement update")[0]?.content,
    "requirement",
    "update",
    requirementId,
    "--expected-version",
    "1",
    "--file",
  );
  await dry(contents("auth-profile create")[0]?.content, "auth-profile", "create", "--file");
  // `contract validate` accepts its sample under the contract it names.
  await writeFile(file, JSON.stringify(contents("contract validate")[0]?.content));
  const validated = await invoke([
    "--cwd",
    root,
    "contract",
    "validate",
    "--schema",
    "ExecutablePlan",
    "--document",
    "input.json",
  ]);
  expect(validated.exit).toBe(0);
  // Negative control: the same gate refuses a sample that was broken.
  await writeFile(
    file,
    JSON.stringify({
      ...(contents("schedule create")[0]?.content as object),
      trigger: { kind: "cron", cron: "nope" },
    }),
  );
  const refused = await invoke([
    "--cwd",
    root,
    "--dry-run",
    "schedule",
    "create",
    "--file",
    "input.json",
  ]);
  expect(refused.exit).not.toBe(0);
});
const requirementId = uuidV7IdGenerator.next("req");

it("every auth-profile kind's sample creates a profile once its secret placeholders name registered secrets", async () => {
  const root = await emptyRoot();
  const base = ["--cwd", root];
  expect((await invoke([...base, "init", "--name", "shop"])).exit).toBe(0);
  vi.stubEnv("TM_EXAMPLE_SECRET", "example-secret-value");
  // Every secret of the samples is authorized for the application and the identity provider.
  const registered = new Map<string, string>();
  const register = async (placeholder: string) => {
    const known = registered.get(placeholder);
    if (known) return known;
    const created = await invoke([
      ...base,
      "secret",
      "set",
      `example-${registered.size}`,
      "--from-env",
      "TM_EXAMPLE_SECRET",
      "--allowed-origin",
      "https://app.example.test",
      "--allowed-origin",
      "https://idp.example.test",
    ]);
    expect(created.exit).toBe(0);
    const id = String(created.document.data?.id);
    registered.set(placeholder, id);
    return id;
  };
  const withRealSecrets = async (content: unknown): Promise<string> => {
    let text = JSON.stringify(content);
    for (const placeholder of new Set(text.match(/sec_[0-9a-f-]{36}/gu) ?? []))
      text = text.replaceAll(placeholder, await register(placeholder));
    return text;
  };
  const file = join(root, "profile.json");
  const ids = new Map<string, string>();
  for (const { variant, content } of contents("auth-profile create")) {
    await writeFile(file, await withRealSecrets(content));
    const created = await invoke([...base, "auth-profile", "create", "--file", "profile.json"]);
    expect(created.document.error, `${variant}`).toBeUndefined();
    expect(created.document.data).toMatchObject({ kind: (content as { kind: string }).kind });
    ids.set(String(variant), String(created.document.data?.id));
  }
  // The update sample is accepted by a stored profile.
  await writeFile(file, JSON.stringify(contents("auth-profile update")[0]?.content));
  const updated = await invoke([
    ...base,
    "auth-profile",
    "update",
    ids.get("form") as string,
    "--file",
    "profile.json",
    "--expected-version",
    "1",
  ]);
  expect(updated.document.error).toBeUndefined();
  expect(updated.document.data).toMatchObject({
    originBindings: ["https://app.example.test", "https://api.example.test"],
  });
  // Negative control: a basic profile without its password secret is refused, so the loop above
  // does check the roles each kind needs.
  const basic = (
    contents("auth-profile create").find((s) => s.variant === "basic") as {
      content: { secrets: Record<string, string> };
    }
  ).content;
  await writeFile(file, await withRealSecrets({ ...basic, name: "no-password", secrets: {} }));
  const refused = await invoke([...base, "auth-profile", "create", "--file", "profile.json"]);
  expect(refused.document.error).toMatchObject({ code: "INVALID_ARGUMENT" });
});
