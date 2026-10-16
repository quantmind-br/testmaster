import { scaffoldPlan } from "@testmaster/application";
import type { AuthProfileInput, AuthProfilePatch } from "@testmaster/contracts";
import type { Command } from "commander";
import { commandPath } from "./remote.js";

/**
 * Complete `--file` for `auth-profile create`: a form login that posts a JSON body and keeps the
 * session cookie. `secrets` maps each role the kind needs (`username`, `password`) to a vault
 * secret registered earlier with `testmaster secret set`; the project comes from `--project`.
 */
export const authProfileFileExample: Omit<AuthProfileInput, "projectId"> = {
  name: "app-form-login",
  kind: "form",
  originBindings: ["https://app.example.test"],
  secrets: {
    username: "sec_01900000-0000-7000-8000-000000000001",
    password: "sec_01900000-0000-7000-8000-000000000002",
  },
  config: {
    http: {
      loginUrl: "https://app.example.test/api/auth/login",
      contentType: "json",
      fields: { username: "email", password: "password" },
      staticFields: { remember: "false" },
      success: { statusIn: [200], cookieNames: ["session"] },
      ttlSeconds: 3600,
    },
  },
  refreshPolicy: { cooldownSeconds: 60 },
};
/** `--file` of `auth-profile update`: any subset of the profile; `config` is replaced whole. */
export const authProfilePatchExample: AuthProfilePatch = {
  originBindings: ["https://app.example.test", "https://api.example.test"],
  refreshPolicy: { maxRefreshesPerHour: 10 },
};

interface InputExample {
  /** The option that reads the file. */
  option: string;
  content: () => unknown;
}
const planExample = (): unknown => scaffoldPlan("backend");
/** Commands that read a JSON file: the example is a complete, valid file for that option. */
const inputExamples: Record<string, InputExample> = {
  "auth-profile create": { option: "--file", content: () => authProfileFileExample },
  "auth-profile update": { option: "--file", content: () => authProfilePatchExample },
  "requirement update": {
    option: "--file",
    content: () => ({
      text: "A signed-in customer can change the shipping address of an unpaid order.",
      acceptanceCriteria: ["The new address is shown on the order page after saving."],
    }),
  },
  "test create": { option: "--plan", content: planExample },
  "test lint": { option: "--plan", content: planExample },
  "test revision create": { option: "--plan", content: planExample },
  "plan edit": { option: "--plan", content: planExample },
};

/** The `--example` payload of a command: its input contract and, where it has one, a sample file. */
export function exampleFor(command: Command): Record<string, unknown> {
  const path = commandPath(command);
  const input = inputExamples[path];
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
      ...(input
        ? { input: { option: input.option, format: "json", content: input.content() } }
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
