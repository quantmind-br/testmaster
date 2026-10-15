import { issueLocalToken, type Scope } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import type { Command } from "commander";
import { collect, type Runtime, required, string, strings } from "./runtime.js";

const scopeOrder: readonly Scope[] = ["R", "W", "X", "A"];
/** Default grant for an agent: read, write and execute, never administration. */
const defaultScopes: readonly Scope[] = ["R", "W", "X"];

/** Validates `--scope` values and returns them in canonical order so reuse ignores flag order. */
function parseScopes(values: string[]): Scope[] {
  if (!values.length) return [...defaultScopes];
  const unknown = values.filter((value) => !scopeOrder.includes(value as Scope));
  if (unknown.length)
    throw new ContractError("INVALID_ARGUMENT", "--scope must be one of R, W, X, A", {
      allowed: [...scopeOrder],
    });
  return scopeOrder.filter((scope) => values.includes(scope));
}

export function tokenCommands(program: Command, runtime: Runtime): void {
  const group = program.command("token").description("Local capability tokens for agents");
  runtime.bind(
    group
      .command("issue")
      .option("--token-file <path>", "Private token file to create or reuse (required)")
      .option("--scope <scope>", "Token scope R|W|X|A (repeatable; default R W X)", collect, [])
      .option("--expires-at <iso>", "Token expiry (default 30 days)")
      .description("Mint a capability token into a private file; the token is never printed"),
    async (rt, _args, options) => {
      const tokenFile = required(options, "tokenFile");
      const scopes = parseScopes(strings(options, "scope"));
      const expiresAt = string(options, "expiresAt");
      const application = await rt.app();
      const issued = await issueLocalToken(application, {
        tokenPath: rt.path(tokenFile),
        scopes,
        ...(expiresAt ? { expiresAt } : {}),
      });
      const data = {
        tokenPath: issued.tokenPath,
        scopes: issued.identity.scopes,
        expiresAt: issued.identity.expiresAt ?? null,
      };
      return {
        data,
        text: `Capability token file: ${data.tokenPath}\nScopes: ${data.scopes.join(",")}\nExpires: ${data.expiresAt ?? "never"}\n`,
      };
    },
  );
}
