import type { RunnerEvent } from "./protocol.js";
import { ContractError } from "./registries.js";
import { parseStrictJson, validateRunnerWireEvent } from "./validation.js";
export interface RunnerSessionOptions {
  attemptId: string;
  nonce: string;
}
export class RunnerSessionValidator {
  readonly attemptId: string;
  #nonce: string;
  #nextSequence = 0;
  #finished = false;
  #failed = false;
  constructor(options: RunnerSessionOptions) {
    this.attemptId = options.attemptId;
    this.#nonce = options.nonce;
  }
  accept(line: Uint8Array | string): RunnerEvent {
    if (this.#failed || this.#finished)
      throw new ContractError("PRECONDITION_FAILED", "Runner session is closed", {
        reasonCode: "insufficient_evidence",
      });
    try {
      const event = validateRunnerWireEvent(parseStrictJson(line, 262144));
      if (event.attemptId !== this.attemptId || event.seq !== this.#nextSequence)
        throw new ContractError("INVALID_ARGUMENT", "Runner attempt or sequence mismatch");
      if (
        this.#nextSequence === 0 &&
        (event.type !== "runner.hello" || event.payload.nonce !== this.#nonce)
      )
        throw new ContractError("POLICY_DENIED", "Runner handshake failed");
      if (this.#nextSequence > 0 && event.type === "runner.hello")
        throw new ContractError("INVALID_ARGUMENT", "Duplicate runner handshake");
      this.#nextSequence++;
      this.#finished = event.type === "runner.finished";
      return event;
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }
  exit(): { complete: boolean; reasonCode: "insufficient_evidence" | null } {
    return {
      complete: this.#finished && !this.#failed,
      reasonCode: this.#finished && !this.#failed ? null : "insufficient_evidence",
    };
  }
}
