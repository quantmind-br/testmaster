import { expect, it } from "vitest";
import { oversizedChunks, startAdversarial } from "./index.js";

it("serves dangerous redirect hops without following them", async () => {
  const server = await startAdversarial();
  try {
    for (const [path, origin] of [
      ["metadata", "http://169.254.169.254"],
      ["loopback", "http://127.0.0.1:1"],
      ["lan", "http://192.168.1.1"],
    ]) {
      const response = await fetch(`${server.url}/redirect/${path}`, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location") as string).origin).toBe(origin);
    }
  } finally {
    await server.close();
  }
});
it("generates bounded chunks exceeding the upload ceiling", async () => {
  let total = 0;
  for await (const chunk of oversizedChunks()) {
    expect(chunk.length).toBeLessThanOrEqual(65536);
    total += chunk.length;
  }
  expect(total).toBe(26 * 1024 * 1024);
});
