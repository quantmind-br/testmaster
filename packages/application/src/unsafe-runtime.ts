import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ContractError } from "@testmaster/contracts";
import {
  type AttemptRuntimeExecutor,
  type DockerAttempt,
  executeUnsafeProcess,
} from "@testmaster/sandbox";
import type { ResolvedConfig } from "./config.js";

/** No implicit fallback: this adapter is constructed only from a sealed unsafe-local admission. */
export class UnsafeRuntime implements AttemptRuntimeExecutor {
  constructor(readonly config: ResolvedConfig) {}
  async execute(input: DockerAttempt, signal?: AbortSignal) {
    if (input.kind === "python")
      throw new ContractError(
        "CAPABILITY_UNAVAILABLE",
        "Unsafe-local Python execution is unavailable",
        { capability: "unsafe-local-python", milestone: "M2" },
      );
    return executeUnsafeProcess(
      {
        unsafeLocal: true,
        allowUnsafeProcessExecution: this.config.profilePolicy.security.allowUnsafeProcessExecution,
        singleUser: true,
        socketPath: join(input.socketsDir, "egress.sock"),
        executable: process.execPath,
        args: [fileURLToPath(new URL("../../runner/dist/harness.js", import.meta.url))],
        cwd: input.inputDir,
        env: {
          ...process.env,
          TESTMASTER_INPUT_PATH: join(input.inputDir, "snapshot.json"),
          TESTMASTER_EGRESS_SOCKET: join(input.socketsDir, "egress.sock"),
          TESTMASTER_PROTOCOL_SOCKET: join(input.socketsDir, "protocol.sock"),
        },
        timeoutMs: input.attemptTimeoutMs ?? 300000,
      },
      signal,
    );
  }
}
