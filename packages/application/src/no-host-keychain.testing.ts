/**
 * Vitest setup file for the `unit` and `postgres-parity` projects: keeps every test off the
 * developer's desktop keyring.
 *
 * `SecretsService` stores a local-profile secret through `secret-tool` first and falls back to the
 * encrypted vault only when that fails. On a workstation with a locked or prompting Secret Service,
 * each `secret-tool` call blocks until the service's own 5 s kill, so a world that creates two
 * secrets spends 10 s doing nothing, and a lookup that exceeds the 5 s budget under load fails with
 * "Secret storage is unavailable". The GitHub intake swallows that failure per integration and
 * reports "Webhook signature is invalid". A test must never depend on, or write into, the host
 * keyring: `secret-tool` becomes unavailable (ENOENT, the same error a host without the tool gives)
 * and the real encrypted fallback runs. Production code reads no test configuration; only the test
 * run's module instance of `node:child_process` changes. A test file that mocks the module itself
 * (secrets.test.ts) overrides this one.
 */
import type * as ChildProcess from "node:child_process";
import { vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: ((command: string, ...rest: unknown[]) => {
      if (command === "secret-tool")
        throw Object.assign(new Error("secret-tool is not available in tests"), {
          code: "ENOENT",
        });
      return (actual.spawn as (...args: unknown[]) => unknown)(command, ...rest);
    }) as typeof actual.spawn,
  };
});
