import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertLiveProviderEndpoint, benchmarkEvidenceClass, isNonPublicHost } from "./evidence.js";
import { runEvaluation } from "./run.js";

const live = {
  class: "live-model-evaluation",
  runner: "real-cli-docker",
  providerHost: "api.quantforge.com.br",
};

describe("benchmark evidence class", () => {
  it("refuses simulated and controlled benchmark reports as release evidence", () => {
    expect(benchmarkEvidenceClass(live)).toBe("live");
    expect(benchmarkEvidenceClass({ class: "deterministic-e2e" })).toBe("non-live");
    expect(
      benchmarkEvidenceClass({ class: "deterministic-local-provider-policy-acceptance" }),
    ).toBe("non-live");
    expect(benchmarkEvidenceClass({ class: "coverage-pilot" })).toBe("non-live");
    // The live label alone is not evidence: runner and a public provider host must agree with it.
    expect(benchmarkEvidenceClass({ ...live, runner: "in-process" })).toBe("non-live");
    expect(benchmarkEvidenceClass({ ...live, providerHost: undefined })).toBe("non-live");
    for (const providerHost of ["127.0.0.1", "localhost", "10.1.2.3", "::1", "controlled"])
      expect(benchmarkEvidenceClass({ ...live, providerHost })).toBe("non-live");
  });
});

describe("live provider endpoint guard", () => {
  it("refuses loopback, private, link-local and non-public provider endpoints", () => {
    for (const baseUrl of [
      "http://127.0.0.1:8080/v1",
      "http://127.255.0.9/v1",
      "http://localhost:3000/v1",
      "http://model.localhost/v1",
      "http://0.0.0.0/v1",
      "http://10.0.0.5/v1",
      "http://172.16.0.1/v1",
      "http://172.31.255.255/v1",
      "http://192.168.1.10/v1",
      "http://169.254.169.254/v1",
      "http://100.64.0.1/v1",
      "http://2130706433/v1",
      "http://[::1]:8080/v1",
      "http://[fd12:3456::1]/v1",
      "http://[fe80::1]/v1",
      "http://[::ffff:127.0.0.1]/v1",
      "http://[::ffff:10.0.0.1]/v1",
      "http://ollama:11434/v1",
      "https://gateway.internal/v1",
      "https://printer.local/v1",
    ])
      expect(() => assertLiveProviderEndpoint(baseUrl), baseUrl).toThrow(
        "loopback, private or link-local",
      );
  });
  it("accepts public endpoints and refuses malformed or non-http endpoints", () => {
    for (const baseUrl of [
      "https://api.quantforge.com.br/v1",
      "https://8.8.8.8/v1",
      "https://172.32.0.1/v1",
      "https://172.15.255.255/v1",
      "https://[2001:4860:4860::8888]/v1",
    ])
      expect(() => assertLiveProviderEndpoint(baseUrl), baseUrl).not.toThrow();
    expect(() => assertLiveProviderEndpoint("not a url")).toThrow("not a valid URL");
    expect(() => assertLiveProviderEndpoint("file:///etc/passwd")).toThrow("http or https");
    expect(isNonPublicHost("api.quantforge.com.br")).toBe(false);
    expect(isNonPublicHost("")).toBe(true);
  });
  it("makes the live evaluation refuse a controlled endpoint before any result directory exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "tm-live-endpoint-"));
    try {
      await writeFile(
        join(root, "registration.json"),
        JSON.stringify({
          id: "controlled-endpoint",
          provider: {
            id: "controlled",
            kind: "openai-compatible",
            baseUrl: "http://127.0.0.1:9/v1",
            apiKeyEnv: "CONTROLLED_KEY",
            model: "fixture",
          },
          dataset: { manifest: "manifest.json", sha256: "0".repeat(64) },
        }),
      );
      await expect(runEvaluation(root, "a".repeat(40), "registration.json")).rejects.toThrow(
        "cannot produce a live-model-evaluation report",
      );
      await expect(access(join(root, "evals"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
