import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { executeUnsafeProcess } from "./executor.js";

it("routes the explicit unsafe process through IPC and labels it without isolation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-process-"));
  const socketPath = join(root, "egress.sock");
  let requests = 0;
  const proxy = http.createServer((request, response) => {
    requests++;
    expect(request.url).toBe("http://fixture.test/");
    response.end("proxied");
  });
  const listening = Promise.withResolvers<void>();
  proxy.once("error", listening.reject);
  proxy.listen(socketPath, listening.resolve);
  await listening.promise;
  try {
    const code = `const http=require('node:http'); const proxy=new URL(process.env.HTTP_PROXY); http.get({hostname:proxy.hostname,port:proxy.port,path:'http://fixture.test/',headers:{host:'fixture.test'}},response=>response.pipe(process.stdout));`;
    const result = await executeUnsafeProcess({
      unsafeLocal: true,
      allowUnsafeProcessExecution: true,
      singleUser: true,
      socketPath,
      executable: process.execPath,
      args: ["-e", code],
      cwd: root,
    });
    expect(result.code).toBe(0);
    expect(result.isolation).toBe("none");
    expect(result.stdout.toString()).toBe("proxied");
    expect(requests).toBe(1);
  } finally {
    const closed = Promise.withResolvers<void>();
    proxy.close(() => closed.resolve());
    await closed.promise;
    await rm(root, { recursive: true, force: true });
  }
});
