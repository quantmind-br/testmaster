import type { AuthProfileInput, AuthProfilePatch } from "@testmaster/contracts";
import { ContractError } from "@testmaster/contracts";
import type { Command } from "commander";
import { integer, type Options, type Runtime, required, string, version } from "./runtime.js";

/** Reads a JSON object from `--file`; credentials never travel on the command line. */
async function jsonFile(runtime: Runtime, opts: Options): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(
    (await runtime.readInput(required(opts, "file"))).toString("utf8"),
  );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ContractError("INVALID_ARGUMENT", "--file must contain a JSON object");
  return parsed as Record<string, unknown>;
}
const ttl = (opts: Options): { ttlSeconds?: number } =>
  typeof opts.ttl === "number" ? { ttlSeconds: opts.ttl } : {};

/** Dynamic authentication profiles and manual checkpoints (SEC-023, SEC-024). */
export function authProfileCommands(program: Command, runtime: Runtime): void {
  const profiles = program
    .command("auth-profile")
    .alias("auth-profiles")
    .description("Authentication profiles for target apps (login, OAuth/OIDC, manual)");
  runtime.bind(
    profiles
      .command("create")
      .requiredOption("--file <path>", "JSON: name, kind, originBindings, secrets, config"),
    async (rt, _args, opts) => ({
      data: await (await rt.app()).authProfiles.create({
        ...(await jsonFile(rt, opts)),
        projectId: await rt.project(opts),
      } as AuthProfileInput),
    }),
    async (rt, _args, opts) => {
      await jsonFile(rt, opts);
      return { data: null };
    },
  );
  runtime.bind(profiles.command("list"), async (rt, _args, opts) => ({
    data: await (await rt.app()).authProfiles.list(await rt.project(opts)),
  }));
  runtime.bind(profiles.command("get <id>"), async (rt, args) => ({
    data: await (await rt.app()).authProfiles.get(String(args[0])),
  }));
  runtime.bind(
    profiles
      .command("update <id>")
      .requiredOption("--file <path>", "JSON patch")
      .requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, opts) => ({
      data: await (await rt.app()).authProfiles.update(
        String(args[0]),
        (await jsonFile(rt, opts)) as AuthProfilePatch,
        version(opts),
      ),
    }),
    async (rt, _args, opts) => {
      await jsonFile(rt, opts);
      return { data: null };
    },
  );
  runtime.bind(
    profiles
      .command("test-login <id>")
      .requiredOption("--environment <id>", "Environment whose origins the login is bound to"),
    async (rt, args, opts) => ({
      data: await (await rt.app()).authProfiles.testLogin(
        String(args[0]),
        required(opts, "environment"),
      ),
    }),
  );
  runtime.bind(
    profiles.command("authorize <id>").requiredOption("--environment <id>"),
    async (rt, args, opts) => ({
      data: await (await rt.app()).authProfiles.authorize(
        String(args[0]),
        required(opts, "environment"),
      ),
    }),
  );
  runtime.bind(
    profiles
      .command("complete-authorization <id>")
      .requiredOption("--environment <id>")
      .requiredOption("--authorization <id>", "Authorization returned by `authorize`")
      .requiredOption(
        "--input-ref <secret>",
        "Secret holding the redirect URL the browser reached",
      ),
    async (rt, args, opts) => ({
      data: await (await rt.app()).authProfiles.completeAuthorization(
        String(args[0]),
        { authorizationId: required(opts, "authorization"), inputRef: required(opts, "inputRef") },
        required(opts, "environment"),
      ),
    }),
  );
  runtime.bind(
    profiles
      .command("import-state <id>")
      .requiredOption("--input-ref <secret>", "Secret holding a Playwright storage state")
      .option("--ttl <seconds>", "State lifetime", integer),
    async (rt, args, opts) => ({
      data: await (await rt.app()).authProfiles.importState(String(args[0]), {
        inputRef: required(opts, "inputRef"),
        ...ttl(opts),
      }),
    }),
  );
  runtime.bind(
    profiles
      .command("export-state <id>")
      .requiredOption("--out <path>", "New file (mode 0600) that receives the storage state")
      .option("--password-from-env <variable>", "Caller's password for step-up (remote profiles)")
      .option("--ttl <seconds>", "Export lifetime, 60 to 900", integer),
    async (rt, args, opts) => {
      const variable = string(opts, "passwordFromEnv");
      const password = variable ? process.env[variable] : "";
      if (password === undefined)
        throw new ContractError("INVALID_ARGUMENT", "Password environment variable is not set");
      const exported = await (await rt.app()).authProfiles.exportState(String(args[0]), {
        password,
        ...ttl(opts),
      });
      await rt.writeOutput(required(opts, "out"), exported.storageState, { mode: 0o600 });
      const { storageState: _omitted, ...receipt } = exported;
      return { data: receipt };
    },
  );
  runtime.bind(profiles.command("revoke-session <id>"), async (rt, args) => ({
    data: await (await rt.app()).authProfiles.revokeSession(String(args[0])),
  }));

  const checkpoints = program
    .command("auth-checkpoint")
    .alias("auth-checkpoints")
    .description("Manual authentication checkpoints a human resolves (CAPTCHA, WebAuthn, push)");
  runtime.bind(
    checkpoints
      .command("list")
      .option("--run <id>")
      .option("--auth-profile <id>")
      .option("--state <state>"),
    async (rt, _args, opts) => {
      const runId = string(opts, "run");
      const profileId = string(opts, "authProfile");
      const state = string(opts, "state");
      return {
        data: await (await rt.app()).authCheckpoints.list({
          ...(runId ? { runId } : {}),
          ...(profileId ? { profileId } : {}),
          ...(state ? { state } : {}),
        }),
      };
    },
  );
  runtime.bind(checkpoints.command("get <id>"), async (rt, args) => ({
    data: await (await rt.app()).authCheckpoints.get(String(args[0])),
  }));
  runtime.bind(
    checkpoints
      .command("continue <id>")
      .option("--input-ref <secret>", "Secret with the human-supplied code, state or URL"),
    async (rt, args, opts) => {
      const inputRef = string(opts, "inputRef");
      return {
        data: await (await rt.app()).authCheckpoints.continue(
          String(args[0]),
          inputRef ? { inputRef } : {},
        ),
      };
    },
  );
  runtime.bind(checkpoints.command("cancel <id>"), async (rt, args) => ({
    data: await (await rt.app()).authCheckpoints.cancel(String(args[0])),
  }));
}
