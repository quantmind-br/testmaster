// Host end of the session broker (see broker-client.mjs). It listens on an abstract Unix socket
// (the sandbox shares the host's network namespace, so the name reaches it and no file of the
// harness has to be visible), and runs each request outside the agent's sandbox: `spawnFor`
// returns the command for a header, the broker pipes stdin, stdout, stderr and the exit status.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

const frame = (type, payload) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head = Buffer.alloc(5);
  head.write(type, 0, "latin1");
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
};

/**
 * `spawnFor(header)` → `{command, args, env, cwd}` for `header` = {kind, argv, cwd, env}, or
 * throws to refuse it. Resolves to `{socket, close}`; `socket` is the client's address.
 */
export async function startBroker(spawnFor) {
  // Abstract namespace: the leading NUL is added here and by the client (argv cannot carry it).
  const socket = `testmaster-surface-${randomUUID()}`;
  const children = new Set();
  const server = createServer((connection) => {
    let child = null;
    let pending = Buffer.alloc(0);
    const reply = (type, payload) => {
      if (!connection.destroyed) connection.write(frame(type, payload));
    };
    const start = (header) => {
      let spec;
      try {
        spec = spawnFor(header);
      } catch (error) {
        reply("R", `testmaster: ${error.message}\n`);
        reply("X", JSON.stringify({ code: 1, signal: null }));
        connection.end();
        return;
      }
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      child.stdin.on("error", () => {});
      child.stdout.on("data", (chunk) => reply("O", chunk));
      child.stderr.on("data", (chunk) => reply("R", chunk));
      child.on("error", (error) => reply("R", `testmaster: ${error.message}\n`));
      child.on("close", (code, signal) => {
        children.delete(child);
        reply("X", JSON.stringify({ code, signal }));
        connection.end();
      });
    };
    connection.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1);
        if (pending.length < 5 + length) break;
        const type = pending.toString("latin1", 0, 1);
        const body = pending.subarray(5, 5 + length);
        pending = pending.subarray(5 + length);
        if (type === "H" && !child) start(JSON.parse(body.toString("utf8")));
        else if (type === "I") child?.stdin.write(body);
        else if (type === "E") child?.stdin.end();
        else if (type === "K") child?.kill(body.toString("utf8"));
      }
    });
    // The client went away (its caller killed it): its command goes with it.
    connection.on("close", () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });
    connection.on("error", () => {});
  });
  await new Promise((done) => server.listen(`\0${socket}`, done));
  return {
    socket,
    close: () =>
      new Promise((done) => {
        for (const child of children) child.kill("SIGTERM");
        server.close(() => done());
      }),
  };
}
