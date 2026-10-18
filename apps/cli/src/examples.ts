import { scaffoldPlan } from "@testmaster/application";
import {
  type AuthProfileInput,
  type AuthProfilePatch,
  ContractError,
  type ScheduleInput,
  type SchedulePatchInput,
  type SuiteSelection,
} from "@testmaster/contracts";
import { type Command, Option } from "commander";
import { commandPath } from "./remote.js";

const APP = "https://app.example.test";
const IDP = "https://idp.example.test";
// Placeholder ids: every id in a sample is well-formed and means "the one you registered".
const secret = (n: number): string =>
  `sec_01900000-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`;
const SUITE_ID = "sui_01900000-0000-7000-8000-000000000040";
const members = [
  {
    testId: "tst_01900000-0000-7000-8000-000000000010",
    revisionId: "rev_01900000-0000-7000-8000-000000000020",
    environmentId: "env_01900000-0000-7000-8000-000000000030",
  },
  {
    testId: "tst_01900000-0000-7000-8000-000000000011",
    revisionId: "rev_01900000-0000-7000-8000-000000000021",
    environmentId: "env_01900000-0000-7000-8000-000000000030",
  },
];

type AuthSample = Omit<AuthProfileInput, "projectId">;
const authBase = { originBindings: [APP] };

/**
 * Complete `--file` for `auth-profile create`: a form login that posts a JSON body and keeps the
 * session cookie. `secrets` maps each role the kind needs (`username`, `password`) to a vault
 * secret registered earlier with `testmaster secret set`; the project comes from `--project`.
 * The username alone may instead be a plain `"username": "root"` value (and then not in `secrets`):
 * it is shown as written and not masked in evidence, while a secret username is masked everywhere.
 */
export const authProfileFileExample: AuthSample = {
  name: "app-form-login",
  kind: "form",
  originBindings: [APP],
  secrets: { username: secret(1), password: secret(2) },
  config: {
    http: {
      loginUrl: `${APP}/api/auth/login`,
      contentType: "json",
      fields: { username: "email", password: "password" },
      staticFields: { remember: "false" },
      success: { statusIn: [200], cookieNames: ["session"] },
      ttlSeconds: 3600,
    },
  },
  refreshPolicy: { cooldownSeconds: 60 },
};
const oauthConfig = (openid: boolean) => ({
  adapter: "generic",
  issuer: IDP,
  clientId: "testmaster-client",
  scopes: openid ? ["openid", "profile"] : ["profile"],
  allowedScopes: ["openid", "profile", "email"],
  redirectUris: [`${APP}/auth/callback`],
  redirectUri: `${APP}/auth/callback`,
});
/** `--file` of `auth-profile create` per `--kind`: every kind of the AuthProfileInput contract. */
const authProfileSamples: Record<string, () => AuthSample> = {
  form: () => authProfileFileExample,
  // The same form login, driven in the browser; its steps may reference only this profile's secrets.
  "form-browser": () => ({
    name: "app-browser-login",
    kind: "form",
    ...authBase,
    secrets: { username: secret(1), password: secret(2) },
    config: {
      browser: {
        steps: [
          {
            id: "open-login",
            kind: "action",
            operation: "navigate",
            description: "Open the login page",
            required: true,
            input: { path: "/login" },
          },
          {
            id: "type-email",
            kind: "action",
            operation: "fill",
            description: "Type the account email",
            required: true,
            input: {
              locator: { by: "label", value: "Email", exact: true },
              value: { secretRef: secret(1) },
            },
          },
          {
            id: "type-password",
            kind: "action",
            operation: "fill",
            description: "Type the account password",
            required: true,
            input: {
              locator: { by: "label", value: "Password", exact: true },
              value: { secretRef: secret(2) },
            },
          },
          {
            id: "sign-in",
            kind: "action",
            operation: "click",
            description: "Submit the login form",
            required: true,
            input: { locator: { by: "role", role: "button", name: "Sign in", exact: true } },
          },
        ],
        ttlSeconds: 3600,
      },
    },
  }),
  // The username as a plain value: stored and shown as written, not masked in evidence.
  basic: () => ({
    name: "api-basic",
    kind: "basic",
    ...authBase,
    username: "deploy-bot",
    secrets: { password: secret(2) },
    config: {},
  }),
  bearer: () => ({
    name: "api-bearer",
    kind: "bearer",
    ...authBase,
    secrets: { token: secret(3) },
    config: { header: "Authorization" },
  }),
  "api-key": () => ({
    name: "api-key",
    kind: "api-key",
    ...authBase,
    secrets: { key: secret(4) },
    config: { header: "X-Api-Key" },
  }),
  cookie: () => ({
    name: "api-session-cookie",
    kind: "cookie",
    ...authBase,
    secrets: { cookie: secret(5) },
    config: { header: "session" },
  }),
  // The secrets of an OAuth/OIDC profile are authorized for the issuer's origin, not the app's.
  oauth: () => ({
    name: "app-oauth",
    kind: "oauth",
    ...authBase,
    secrets: { clientSecret: secret(6) },
    config: oauthConfig(false),
  }),
  oidc: () => ({
    name: "app-oidc",
    kind: "oidc",
    ...authBase,
    secrets: { clientSecret: secret(6) },
    config: oauthConfig(true),
  }),
  // A human completes the challenge once; the captured session is imported with `auth-profile import-state`.
  manual: () => ({
    name: "app-manual-login",
    kind: "manual",
    ...authBase,
    secrets: {},
    config: { challenge: { kind: "captcha", resolution: "storage-state" }, ttlSeconds: 3600 },
  }),
};
/** `--file` of `auth-profile update`: any subset of the profile; `config` is replaced whole. */
export const authProfilePatchExample: AuthProfilePatch = {
  originBindings: [APP, "https://api.example.test"],
  refreshPolicy: { maxRefreshesPerHour: 10 },
};

/** `--selection-file` of a list: the whole selection, fixed pinned members or dynamic project filters. */
const selectionSamples: Record<string, () => SuiteSelection> = {
  fixed: () => ({ kind: "fixed", members }),
  dynamic: () => ({
    kind: "dynamic",
    projects: [
      {
        projectId: "prj_01900000-0000-7000-8000-000000000050",
        environmentId: "env_01900000-0000-7000-8000-000000000030",
        filter: { tags: ["smoke"], priorities: ["critical", "high"] },
      },
    ],
  }),
};

const intervalTrigger = {
  kind: "interval",
  everySeconds: 3600,
  anchor: "2026-01-01T00:00:00.000Z",
} as const;
const cronTrigger = {
  kind: "cron",
  cron: "0 2 * * *",
  timezone: "America/Sao_Paulo",
  dstGap: "skip",
  dstFold: "once",
} as const;
const pinnedRevisions = { kind: "revisions", members } as const;
const suiteSelection = { kind: "suite", suiteId: SUITE_ID, revisionPolicy: "pinned" } as const;
/** `--file` of `schedule create` per mode: a list on a cron or an interval, or explicit pinned revisions. */
const scheduleSamples: Record<string, () => ScheduleInput> = {
  cron: () => ({
    name: "nightly-smoke",
    description: "Run the smoke list every night at 02:00",
    selection: suiteSelection,
    trigger: cronTrigger,
    misfire: { policy: "fire_once", graceSeconds: 300 },
    overlap: "forbid",
    autoPauseAfterFailures: 3,
    secrets: { onChange: "pause" },
    healingPolicy: "off",
  }),
  interval: () => ({
    name: "hourly-smoke",
    selection: suiteSelection,
    trigger: intervalTrigger,
    misfire: { policy: "skip" },
  }),
  revisions: () => ({
    name: "nightly-pinned-revisions",
    selection: pinnedRevisions,
    trigger: cronTrigger,
  }),
};
/** `--file` of `schedule update` per mode: only the fields to change; flags override them. */
const schedulePatchSamples: Record<string, () => SchedulePatchInput> = {
  cron: () => ({
    selection: { kind: "suite", suiteId: SUITE_ID, revisionPolicy: "latest_approved" },
    trigger: cronTrigger,
    overlap: "replace",
    replaceTimeoutSeconds: 300,
  }),
  interval: () => ({ trigger: intervalTrigger }),
  revisions: () => ({ selection: pinnedRevisions }),
};

/** `--mutation-actions` of `explore`: typed form steps the controller may pick when a control matches. */
const explorationActions = (): unknown[] => [
  {
    id: "approved-email",
    kind: "action",
    operation: "fill",
    description: "Fill the email field",
    required: true,
    input: {
      locator: { by: "label", value: "Email", exact: true },
      value: { literal: "someone@example.test" },
    },
  },
  {
    id: "approved-submit",
    kind: "action",
    operation: "click",
    description: "Press the Sign in button",
    required: true,
    input: { locator: { by: "role", role: "button", name: "Sign in", exact: true } },
  },
];

/** The plan a command reads, per application type (`test scaffold --type` prints the same plans). */
const planSamples: Record<string, () => unknown> = {
  frontend: () => scaffoldPlan("frontend"),
  backend: () => scaffoldPlan("backend"),
  cli: () => scaffoldPlan("cli"),
};

/** An example with several modes: one sample per value of the option that selects the mode. */
export interface ExampleVariants<T = unknown> {
  /** The long flag that picks a sample (`--kind`); it only has a meaning together with `--example`. */
  option: string;
  /** Sample printed when the flag is absent. */
  default: string;
  samples: Record<string, () => T>;
}
export interface InputExample {
  /** The option that reads the file. */
  option: string;
  /**
   * Name of the contract the file is validated against (`testmaster contract schema <name>`).
   * Absent only when the command checks the file with its own rules.
   */
  contract?: string;
  /** The command adds `projectId` from `--project`: the file must not carry it. */
  project?: true;
  /** One sample, for a file with a single mode. */
  content?: () => unknown;
  /** One sample per mode. */
  variants?: ExampleVariants;
}
/** Commands that read a JSON file: the example is a complete, valid file for that option. */
export const inputExamples: Record<string, InputExample> = {
  "auth-profile create": {
    option: "--file",
    contract: "AuthProfileInput",
    project: true,
    variants: { option: "--kind", default: "form", samples: authProfileSamples },
  },
  "auth-profile update": {
    option: "--file",
    contract: "AuthProfilePatch",
    content: () => authProfilePatchExample,
  },
  "requirement update": {
    option: "--file",
    content: () => ({
      text: "A signed-in customer can change the shipping address of an unpaid order.",
      acceptanceCriteria: ["The new address is shown on the order page after saving."],
    }),
  },
  // Edits apply first (an edit clears approval), approvals last; an id in both reject and approve is refused.
  "requirement review": {
    option: "--file",
    contract: "Mcp_testmaster_review_requirements",
    project: true,
    content: () => ({
      expectedVersion: 3,
      update: [
        {
          requirementId: "req_01900000-0000-7000-8000-000000000001",
          text: "A signed-in customer can change the shipping address of an unpaid order.",
          acceptanceCriteria: ["The new address is shown on the order page after saving."],
        },
      ],
      adjudicate: [
        {
          conflictId: "conflict-1",
          selectedRequirementId: "req_01900000-0000-7000-8000-000000000002",
          reason: "The PRD states the 30 day return window; the code's 14 days is a defect.",
        },
      ],
      reject: [
        {
          requirementId: "req_01900000-0000-7000-8000-000000000003",
          reason: "Gift wrapping is not part of this release.",
        },
      ],
      approve: ["req_01900000-0000-7000-8000-000000000001"],
      reason: "Reviewed against the PRD of 2026-10-18.",
    }),
  },
  "test create": planInput("--plan"),
  "test lint": planInput("--plan"),
  "test revision create": planInput("--plan"),
  "plan edit": planInput("--plan"),
  // Validates any contract document; the sample is an ExecutablePlan: pass --schema ExecutablePlan.
  "contract validate": {
    option: "--document",
    contract: "ExecutablePlan",
    content: () => scaffoldPlan("backend"),
  },
  "suite create": selectionInput(),
  "suite update": selectionInput(),
  "suite add": selectionInput(),
  "schedule create": {
    option: "--file",
    contract: "ScheduleInput",
    variants: { option: "--kind", default: "cron", samples: scheduleSamples },
  },
  "schedule update": {
    option: "--file",
    contract: "SchedulePatchInput",
    variants: { option: "--kind", default: "cron", samples: schedulePatchSamples },
  },
  explore: { option: "--mutation-actions", content: explorationActions },
};
function planInput(option: string): InputExample {
  return {
    option,
    contract: "ExecutablePlan",
    variants: { option: "--type", default: "backend", samples: planSamples },
  };
}
function selectionInput(): InputExample {
  return {
    option: "--selection-file",
    variants: { option: "--kind", default: "fixed", samples: selectionSamples },
  };
}

const placeholder = (flag: string): string => flag.replace(/^-+/, "");
/** The sample a `--example` call selects (`--kind x` or `--kind=x` in `argv`), refused when unknown. */
function sampleOf(entry: InputExample, argv: readonly string[]) {
  const variants = entry.variants;
  if (!variants) return { content: (entry.content as () => unknown)() };
  let requested: string | undefined;
  argv.forEach((token, index) => {
    if (token === variants.option) requested = argv[index + 1];
    else if (token.startsWith(`${variants.option}=`))
      requested = token.slice(variants.option.length + 1);
  });
  const selected = requested ?? variants.default;
  const available = Object.keys(variants.samples);
  if (!Object.hasOwn(variants.samples, selected))
    throw new ContractError(
      "INVALID_ARGUMENT",
      `${variants.option} must be one of: ${available.join(", ")}`,
      { option: variants.option, choices: available },
    );
  return {
    content: (variants.samples[selected] as () => unknown)(),
    variant: { option: variants.option, selected, available },
  };
}

/**
 * Declares the variant flag of every command whose example has modes, so help lists it and an
 * unknown value is refused with the choices. The flag only picks the `--example` sample; a real
 * run that carries it is refused instead of silently ignoring it.
 */
export function declareExampleVariants(program: Command): void {
  const visit = (command: Command): void => {
    for (const child of command.commands) visit(child);
    const variants = inputExamples[commandPath(command)]?.variants;
    if (!variants || command.commands.length) return;
    const option = new Option(
      `${variants.option} <${placeholder(variants.option)}>`,
      `Only with --example: which sample file to print (default ${variants.default})`,
    ).choices(Object.keys(variants.samples));
    command.addOption(option);
    command.hook("preAction", (_command, action) => {
      if (action.getOptionValue(option.attributeName()) !== undefined)
        throw new ContractError(
          "INVALID_ARGUMENT",
          `${variants.option} only selects the sample printed by --example`,
          { option: variants.option },
        );
    });
  };
  visit(program);
}

/**
 * The `--example` payload of a command: its input contract and, where it has one, a sample file
 * (the one `argv` selects when the file has several modes).
 */
export function exampleFor(
  command: Command,
  argv: readonly string[] = [],
): Record<string, unknown> {
  const path = commandPath(command);
  const input = inputExamples[path];
  const sample = input ? sampleOf(input, argv) : undefined;
  return {
    example: true,
    dryRun: false,
    command: path,
    fixture: {
      usage: `testmaster ${path} ${command.usage()}`,
      arguments: command.registeredArguments.map((argument) => ({
        name: argument.name(),
        required: argument.required,
        variadic: argument.variadic,
        ...(argument.description ? { description: argument.description } : {}),
      })),
      options: command.options
        .filter((option) => !option.hidden)
        .map((option) => ({
          flags: option.flags,
          required: option.mandatory,
          ...(option.description ? { description: option.description } : {}),
          ...(option.argChoices ? { choices: option.argChoices } : {}),
        })),
      ...(input && sample
        ? {
            input: {
              option: input.option,
              format: "json",
              ...(input.contract ? { contract: input.contract } : {}),
              ...(sample.variant ? { variant: sample.variant } : {}),
              content: sample.content,
            },
          }
        : {}),
    },
  };
}

/** The leaf command that `argv` names, or undefined when it names a group or nothing. */
export function leafCommand(program: Command, argv: readonly string[]): Command | undefined {
  let current = program;
  for (const token of argv) {
    if (token.startsWith("-")) continue;
    const next = current.commands.find(
      (command) => command.name() === token || command.aliases().includes(token),
    );
    if (next) current = next;
  }
  return current !== program && current.commands.length === 0 ? current : undefined;
}
