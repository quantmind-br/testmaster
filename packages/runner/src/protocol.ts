import { createHash } from "node:crypto";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import {
  type RunnerEvent,
  type SupervisorEvent,
  validate,
  validateRunnerWireEvent,
} from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";

export class ProtocolClient {
  private seq = 0;
  private readonly pending = new Map<
    string,
    { resolve(value: string): void; reject(error: Error): void }
  >();
  private socket: Socket | undefined;
  private queue: Promise<void> = Promise.resolve();
  readonly controller = new AbortController();
  constructor(
    readonly attemptId: string,
    private readonly nonce: string,
  ) {}
  async open(path: string): Promise<void> {
    const socket = connect(path);
    this.socket = socket;
    socket.on("error", () => this.controller.abort(new Error("protocol_socket_error")));
    socket.on("close", () => {
      this.controller.abort(new Error("protocol_socket_closed"));
      for (const request of this.pending.values())
        request.reject(new Error("protocol_socket_closed"));
      this.pending.clear();
    });
    let buffer = Buffer.alloc(0);
    let supervisorSeq = 0;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let newline = buffer.indexOf(10);
      while (newline !== -1) {
        if (newline > 262144) {
          socket.destroy();
          return;
        }
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        try {
          const event = validate<SupervisorEvent>(
            "SupervisorEvent",
            JSON.parse(line.toString("utf8")),
          );
          if (event.attemptId !== this.attemptId) throw new Error("foreign_supervisor_event");
          if (event.seq !== supervisorSeq++) throw new Error("supervisor_sequence_mismatch");
          if (event.type === "control.cancel")
            this.controller.abort(new Error(event.payload.reasonCode));
          if (event.type === "secret.value") {
            const request = this.pending.get(event.payload.requestId);
            if (!request) throw new Error("unsolicited_secret");
            this.pending.delete(event.payload.requestId);
            request.resolve(event.payload.value);
          }
        } catch {
          socket.destroy();
        }
        newline = buffer.indexOf(10);
      }
      if (buffer.length > 262144) socket.destroy();
    });
    await once(socket, "connect");
    await this.emit("runner.hello", { nonce: this.nonce });
  }
  emit(type: string, payload: unknown): Promise<void> {
    const operation = this.queue.then(async () => {
      const event = validateRunnerWireEvent({
        protocolVersion: "1.0.0",
        seq: this.seq++,
        attemptId: this.attemptId,
        type,
        occurredAt: new Date().toISOString(),
        payload,
      });
      const line = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(line) > 262144) throw new Error("protocol_line_limit");
      if (!this.socket || this.socket.destroyed) throw new Error("protocol_socket_closed");
      await new Promise<void>((resolve, reject) =>
        this.socket?.write(line, (error) => (error ? reject(error) : resolve())),
      );
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async secret(secretRef: string, secretVersion: number): Promise<string> {
    const requestId = `secret-${this.seq}`;
    const value = Promise.withResolvers<string>();
    this.pending.set(requestId, value);
    await this.emit("secret.request", { requestId, secretRef, secretVersion });
    return value.promise;
  }
  async artifact(
    relativePath: string,
    kind: string,
    mimeType: string,
    data: Uint8Array,
  ): Promise<void> {
    const artifactId = uuidV7IdGenerator.next("art");
    await this.emit("artifact.begin", {
      artifactId,
      relativePath,
      kind,
      mimeType,
      sizeBytes: data.byteLength,
    });
    for (let offset = 0; offset < data.byteLength; offset += 131072)
      await this.emit("artifact.chunk", {
        artifactId,
        data: Buffer.from(data.subarray(offset, offset + 131072)).toString("base64"),
      });
    await this.emit("artifact.end", {
      artifactId,
      sizeBytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  async close(): Promise<void> {
    await this.queue;
    this.socket?.end();
  }
}
