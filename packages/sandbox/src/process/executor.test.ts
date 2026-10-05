import { expect, it } from "vitest";
import { executeUnsafeProcess, type ProcessOptions } from "./executor.js";

it("requires both opt-ins and single-user authorization without launching a process", async () => {
  const options: ProcessOptions = {
    unsafeLocal: true,
    allowUnsafeProcessExecution: true,
    singleUser: true,
    socketPath: "/missing.sock",
    executable: "/must-not-run",
    args: [],
    cwd: "/",
  };
  for (const override of [
    { unsafeLocal: false },
    { allowUnsafeProcessExecution: false },
    { singleUser: false },
  ])
    await expect(executeUnsafeProcess({ ...options, ...override })).rejects.toThrow(
      "unsafe_process_opt_in_required",
    );
});
