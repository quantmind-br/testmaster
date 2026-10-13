import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type GithubWorld, startGithubWorld } from "@testmaster/application/testing";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { Journey } from "./harness.js";

/**
 * J12 with a real execution: the PR flow of the GitHub App against the fake GitHub, but the Run is
 * executed by the Docker sandbox against a preview origin served from this process. The preview
 * origin binds the ephemeral environment, so the sandbox egress policy is what the redirect test hits.
 */
const SHA_A = "a".repeat(40);
const SHA_B = "b1".repeat(20);
const SHA_C = "c2".repeat(20);
const SUCCESS = { "TestMaster / result": "success", "TestMaster / required-gate": "success" };

let session: Journey;
let failure: unknown;
beforeAll(async () => {
  session = await Journey.create("j12-github-docker", {
    class: "deterministic-e2e",
    runner: "real-docker",
    externalDependency: "local-fake-github",
    limitations: [
      "Local fake GitHub API and webhook sender; the real GitHub App installation is the hosted Wave 2 proof.",
      "The preview origin is a local HTTP fixture on the Docker host, not a vendor preview deployment.",
    ],
  });
});
afterAll(async () => {
  await session.close(failure);
});

const worlds: GithubWorld[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.stop();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function world(): Promise<GithubWorld> {
  const created = await startGithubWorld({ executor: "docker" });
  worlds.push(created);
  return created;
}
const verdict = (w: GithubWorld, sha: string): Record<string, string | null> =>
  Object.fromEntries(w.checks(sha).map((check) => [check.name, check.conclusion ?? check.status]));
async function record(name: string, body: () => Promise<Record<string, unknown>>): Promise<void> {
  try {
    session.oracles.push({ scenario: name, ...(await body()) });
  } catch (error) {
    failure ??= error;
    throw error;
  }
}

it("J12 INT-015 INT-017 INT-019 INT-021 the Docker sandbox runs the pull request against its preview and only that SHA turns green", async () => {
  await record("docker-preview-run", async () => {
    const w = await world();
    await w.install();
    await w.openPr(7, SHA_A);
    await w.deploy(1, SHA_A);
    await w.drive(30);
    expect(verdict(w, SHA_A)).toEqual(SUCCESS);
    expect(w.target.hits.length).toBeGreaterThan(0);
    const [run] = w.app.runs.list();
    expect(run).toMatchObject({ phase: "completed", matrixCell: { executor: "docker" } });
    // Negative control: a failing preview fails both checks of its own SHA and leaves A's green untouched.
    w.target.healthy = false;
    await w.openPr(7, SHA_B, { action: "synchronize" });
    await w.deploy(2, SHA_B);
    await w.drive(30);
    expect(verdict(w, SHA_B)).toEqual({ "TestMaster / result": "failure", "TestMaster / required-gate": "failure" });
    expect(verdict(w, SHA_A)).toEqual(SUCCESS);
    expect(w.app.runs.list()).toHaveLength(2);
    return { runs: w.app.runs.list().map((entry) => ({ id: entry.id, phase: entry.phase })), a: verdict(w, SHA_A), b: verdict(w, SHA_B) };
  });
}, 900_000);

it("J12 INT-017 SEC-047 a preview that redirects to another origin is stopped by the sandbox egress policy and the foreign origin is never reached", async () => {
  await record("docker-redirect-egress", async () => {
    const w = await world();
    const foreign = { hits: [] as string[] };
    const internal = createServer((request, response) => {
      foreign.hits.push(`${request.method} ${request.url}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ secret: "internal" }));
    });
    servers.push(internal);
    await new Promise<void>((resolve) => internal.listen(0, "0.0.0.0", resolve));
    const foreignOrigin = `http://127.0.0.1:${(internal.address() as AddressInfo).port}`;
    await w.install();
    w.target.redirect = `${foreignOrigin}/latest/meta-data`;
    await w.openPr(7, SHA_A);
    await w.deploy(1, SHA_A);
    await w.drive(30);
    expect(foreign.hits).toEqual([]);
    expect(verdict(w, SHA_A)["TestMaster / required-gate"]).toBe("failure");
    expect(verdict(w, SHA_A)["TestMaster / result"]).not.toBe("success");
    // Positive control: the same flow without the redirect passes on the next SHA.
    w.target.redirect = null;
    await w.openPr(7, SHA_C, { action: "synchronize" });
    await w.deploy(3, SHA_C);
    await w.drive(30);
    expect(verdict(w, SHA_C)).toEqual(SUCCESS);
    expect(foreign.hits).toEqual([]);
    return { redirected: verdict(w, SHA_A), healthy: verdict(w, SHA_C), foreignHits: foreign.hits.length };
  });
}, 900_000);
