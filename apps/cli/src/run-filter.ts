import type { RunListFilter } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import { type Options, string } from "./runtime.js";

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function nonEmpty(options: Options, key: string): string | undefined {
  const value = string(options, key);
  if (value === "") throw new ContractError("INVALID_ARGUMENT", `--${key} must not be empty`);
  return value;
}

function since(options: Options): string | undefined {
  const value = string(options, "since");
  if (value === undefined) return undefined;
  if (!UTC_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value)))
    throw new ContractError(
      "INVALID_ARGUMENT",
      "--since must be a UTC timestamp such as 2030-01-01T00:00:00Z",
    );
  return new Date(value).toISOString();
}

/**
 * The `run list` filter of the local and the remote command. `--project` (or TESTMASTER_PROJECT_ID)
 * filters only when given; the configured or first project is never assumed. An empty
 * TESTMASTER_PROJECT_ID is unset, as an empty shell variable usually is.
 */
export function runListFilter(options: Options): RunListFilter {
  const values: [keyof RunListFilter, string | undefined][] = [
    ["testId", nonEmpty(options, "test")],
    ["batchId", nonEmpty(options, "batch")],
    ["status", nonEmpty(options, "status")],
    ["since", since(options)],
    ["projectId", nonEmpty(options, "project") ?? (process.env.TESTMASTER_PROJECT_ID || undefined)],
  ];
  const filter: RunListFilter = {};
  for (const [key, value] of values) if (value !== undefined) filter[key] = value;
  return filter;
}

/** The cursor binding of `run list`: a cursor issued for other filters is refused. */
export function runListBinding(filter: RunListFilter): string {
  return `runs:${JSON.stringify(filter)}`;
}
