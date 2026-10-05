import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { scaffoldPlan } from "@testmaster/application";
import { expect, it } from "vitest";
import { controlledShop, eventually, Journey, object, text } from "./harness.js";

it("server start admits, executes and streams real reference-shop evidence through authenticated HTTP", async () => {
  const session = await Journey.create("W4-A-server-api");
  const shop = await controlledShop();
  const socket = createNetServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No allocated port");
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  try {
    const initialized = await session.init(shop.url);
    const project = initialized.projectId;
    const env = initialized.environmentId;
    const running = session.start(["server", "start", "--port", String(port)]);
    const ready = await eventually(
      async () => running.stdout(),
      (value) => value.includes("tokenPath"),
    );
    const receipt = object(JSON.parse(ready.trim()).data);
    const token = (await readFile(text(receipt.tokenPath), "utf8")).trim();
    const url = `http://127.0.0.1:${port}`;
    const headers = { authorization: `Bearer ${token}` };
    const create = await fetch(`${url}/v1/projects/${project}/tests`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ plan: scaffoldPlan("backend"), origin: "manual" }),
    });
    expect(create.status).toBe(201);
    const test = object(object(await create.json()).data);
    const key = randomUUID();
    const body = JSON.stringify({
      testId: test.id,
      environmentId: env,
      mode: "replay",
      healingPolicy: "off",
      origin: "api",
    });
    const admit = () =>
      fetch(`${url}/v1/runs`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", "idempotency-key": key },
        body,
      });
    const response = await admit();
    expect(response.status).toBe(202);
    const run = object(object(await response.json()).data);
    session.runIds.push(text(run.runId));
    const duplicate = await admit();
    expect(object(object(await duplicate.json()).data).runId).toBe(run.runId);
    const events = await fetch(`${url}/v1/runs/${run.runId}/events`, { headers });
    expect(events.status).toBe(200);
    const stream = await events.text();
    expect(stream).toContain("event: run.completed");
    const result = await fetch(`${url}/v1/runs/${run.runId}`, { headers });
    expect(object(object(await result.json()).data).outcome).toBe("passed");
    const bundle = await fetch(`${url}/v1/runs/${run.runId}/bundle`, { headers });
    expect(bundle.status).toBe(200);
    const snapshot = object(object(await bundle.json()).data);
    const manifest = object(snapshot.manifest);
    const entries = manifest.entries as Record<string, unknown>[];
    const entry = entries.find((value) => value.state === "available");
    expect(entry).toBeDefined();
    const artifact = await fetch(`${url}/v1/artifacts/${entry?.artifactId}`, { headers });
    expect(artifact.status).toBe(200);
    expect((await artifact.arrayBuffer()).byteLength).toBeGreaterThan(0);
    running.child.kill("SIGTERM");
    await running.result;
    session.oracles.push({
      api: {
        runId: run.runId,
        terminal: "passed",
        events: stream.split("\n").filter((line) => line.startsWith("event:")),
        artifactId: entry?.artifactId,
      },
      tokenLocationOnly: !ready.includes(token),
    });
  } finally {
    await shop.close();
    await session.close();
  }
}, 120000);
