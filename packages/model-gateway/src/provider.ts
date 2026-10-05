import { ContractError, parseStrictJson } from "@testmaster/contracts";
import { request } from "undici";

export class ProviderTransportError extends ContractError {
  readonly usableResponse: boolean;
  constructor(message: string, usableResponse: boolean, status?: number) {
    super(
      status === 429 ? "RATE_LIMITED" : "UNAVAILABLE",
      message,
      status === undefined ? {} : { status },
    );
    this.usableResponse = usableResponse;
  }
}

/** One bounded request; redirect and retry decisions remain with the controller. */
export class OpenAICompatibleProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly maxResponseBytes = 8 * 1024 * 1024,
  ) {}

  async models(key: string, signal: AbortSignal): Promise<string[]> {
    const response = await this.send("models", key, signal);
    if (!Array.isArray(response.data))
      throw new ProviderTransportError("Provider model inventory is malformed", true);
    return response.data.flatMap((model: unknown) => {
      if (model && typeof model === "object" && "id" in model && typeof model.id === "string")
        return [model.id];
      return [];
    });
  }

  async complete(
    body: Record<string, unknown>,
    key: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.send("chat/completions", key, signal, body);
  }

  private async send(
    path: string,
    key: string,
    signal: AbortSignal,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let receivedHeaders = false;
    try {
      const response = await request(`${this.baseUrl.replace(/\/$/u, "")}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${key}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
      receivedHeaders = true;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > this.maxResponseBytes) {
          response.body.destroy();
          throw new ContractError("PAYLOAD_TOO_LARGE", "Provider response exceeds byte limit");
        }
        chunks.push(buffer);
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new ProviderTransportError("Provider rejected request", true, response.statusCode);
      }
      let value: unknown;
      try {
        value = parseStrictJson(Buffer.concat(chunks, size), this.maxResponseBytes);
      } catch {
        throw new ProviderTransportError("Provider returned malformed JSON", true);
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new ProviderTransportError("Provider response must be an object", true);
      }
      return value as Record<string, unknown>;
    } catch (error) {
      if (signal.aborted || error instanceof ContractError) throw error;
      throw new ProviderTransportError("Provider connection failed", receivedHeaders);
    }
  }
}
