import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@testmaster/domain";
import { afterEach, expect, it, vi } from "vitest";
import type { SmokeState } from "./replay.js";
import {
  replayM3,
  smokeFetch,
  smokeLimits,
  startSmokeForwarder,
  withRetainedCopy,
} from "./replay.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
function smokeState(): SmokeState {
  return {
    calls: 0,
    generationCalls: 0,
    inventoryCalls: 0,
    conservativeTokens: 0,
    stopped: null,
    wire: [],
  };
}
const body = JSON.stringify({
  model: "qwen3.8-flash",
  reasoning_effort: "medium",
  messages: [{ role: "user", content: "control" }],
});
it("copies retained repo and home without changing originals and removes copies after failure", async () => {
  const original = await mkdtemp(join(tmpdir(), "tm-replay-retained-"));
  temporary.push(original);
  await mkdir(join(original, "repo"));
  await mkdir(join(original, "home"));
  await writeFile(join(original, "repo", "state.db"), "immutable retained evidence");
  await writeFile(join(original, "home", "profile.json"), "original profile");
  const before = createHash("sha256")
    .update(await readFile(join(original, "repo", "state.db")))
    .digest("hex");
  let copied = "";
  await expect(
    withRetainedCopy(original, async (copy) => {
      copied = copy;
      expect(copy).not.toBe(original);
      expect(await readFile(join(copy, "home", "profile.json"), "utf8")).toBe("original profile");
      await writeFile(join(copy, "repo", "state.db"), "analysis writes in copy only");
      throw new Error("control failure");
    }),
  ).rejects.toThrow("control failure");
  const after = createHash("sha256")
    .update(await readFile(join(original, "repo", "state.db")))
    .digest("hex");
  expect(after).toBe(before);
  await expect(stat(copied)).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects symbolic links rather than following retained paths outside the copy", async () => {
  const original = await mkdtemp(join(tmpdir(), "tm-replay-links-"));
  temporary.push(original);
  await symlink("/tmp", join(original, "outside"));
  await expect(withRetainedCopy(original, async () => true)).rejects.toThrow("symbolic links");
});
it("admits gateway byte reservations before forwarding and counts repair calls", async () => {
  const state = smokeState();
  const delegate = vi.fn(async () => new Response("{}"));
  const guarded = smokeFetch(delegate, state, "https://provider.test/v1");
  const reservation =
    Buffer.byteLength(canonicalJson(JSON.parse(body))) + smokeLimits.outputReservation;
  await guarded("https://provider.test/v1/models");
  for (let i = 0; i < smokeLimits.calls; i++)
    await guarded("https://provider.test/v1/chat/completions", { method: "POST", body });
  expect(state.conservativeTokens).toBe(reservation * smokeLimits.calls);
  await expect(
    guarded("https://provider.test/v1/chat/completions", { method: "POST", body }),
  ).rejects.toThrow("smoke_call_limit");
  expect(delegate).toHaveBeenCalledTimes(9);
  expect(state).toMatchObject({ calls: 9, inventoryCalls: 1, generationCalls: 8 });
});
it("refuses requests crossing conservative token limit before any forwarding", async () => {
  const state = smokeState();
  state.conservativeTokens = smokeLimits.conservativeTokens - 1;
  const delegate = vi.fn(async () => new Response("{}"));
  const guarded = smokeFetch(delegate, state, "https://provider.test/v1");
  await expect(
    guarded("https://provider.test/v1/chat/completions", { method: "POST", body }),
  ).rejects.toThrow("smoke_token_limit");
  expect(delegate).not.toHaveBeenCalled();
});
it("stops immediately at provider failure and refuses model or effort substitution", async () => {
  const state = smokeState();
  const delegate = vi.fn(async () => new Response("{}", { status: 500 }));
  const guarded = smokeFetch(delegate, state, "https://provider.test/v1");
  await guarded("https://provider.test/v1/chat/completions", { method: "POST", body });
  await expect(
    guarded("https://provider.test/v1/chat/completions", { method: "POST", body }),
  ).rejects.toThrow("first_provider_failure");
  expect(delegate).toHaveBeenCalledTimes(1);
  const substituted = smokeFetch(delegate, smokeState(), "https://provider.test/v1");
  await expect(
    substituted("https://provider.test/v1/chat/completions", {
      method: "POST",
      body: body.replace("qwen3.8-flash", "muse-spark-1.3"),
    }),
  ).rejects.toThrow("configuration_mismatch");
  expect(delegate).toHaveBeenCalledTimes(1);
});
it("guards local forwarding even when requests bypass global fetch interception", async () => {
  let upstreamCalls = 0;
  const upstream = createServer((_request, response) => {
    upstreamCalls++;
    response.writeHead(500);
    response.end("{}");
  });
  await new Promise<void>((accept) => upstream.listen(0, "127.0.0.1", accept));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Control address missing");
  const state = smokeState();
  const forwarder = await startSmokeForwarder(`http://127.0.0.1:${address.port}/v1`, state);
  try {
    await fetch(`${forwarder.baseUrl}/chat/completions`, { method: "POST", body });
    await fetch(`${forwarder.baseUrl}/chat/completions`, { method: "POST", body });
    expect(upstreamCalls).toBe(1);
    expect(state.wire[0]).toMatchObject({
      model: "qwen3.8-flash",
      reasoningEffort: "medium",
      status: 500,
    });
  } finally {
    await forwarder.close();
    upstream.closeAllConnections();
    await new Promise<void>((accept, reject) =>
      upstream.close((error) => (error ? reject(error) : accept())),
    );
  }
});
it("reports missing transformed runs without inventing a replay or touching originals", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-replay-missing-"));
  temporary.push(root);
  await mkdir(join(root, "evals/m3"), { recursive: true });
  await mkdir(join(root, "retained-results"));
  const item = { id: "control", group: "healthy", expectedFailureKind: "unknown" };
  await writeFile(join(root, "evals/m3/corpus.json"), JSON.stringify({ cases: [item] }));
  await writeFile(
    join(root, "retained-results/control.json"),
    JSON.stringify({ ...item, records: {} }),
  );
  const result = await replayM3(root, "retained-results", "missing-control");
  expect(result).toMatchObject({
    development: true,
    registered: false,
    holdout: false,
    smoke: { calls: 0 },
  });
  expect(result.skips[0]?.reason).toContain("no run invented");
  expect(result.ledgers[0]?.status).toBe("unstarted");
  const report = JSON.parse(await readFile(join(root, result.directory, "report.json"), "utf8"));
  expect(report.registered).toBe(false);
});
