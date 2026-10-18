// In-sandbox end of the session broker. The driving agent runs in a sandbox that hides the
// TestMaster checkout and the harness state, so `testmaster` on its PATH (and the MCP server
// command of an MCP arm) is this client: it forwards argv, working directory, environment, stdin
// and signals to the broker of its session, outside the sandbox, and replays the broker's stdout,
// stderr and exit status. The client is copied into the session, so no repository path shows.
//
// Usage: node broker-client.mjs SOCKET KIND [ARG...]   (KIND: cli | mcp)
// Frames, both directions: 1 byte type, 4 bytes big-endian length, payload.
//   to the broker: H header JSON {kind, argv, cwd, env}, I stdin bytes, E stdin end, K signal
//   from it:       O stdout bytes, R stderr bytes, X exit JSON {code, signal}
import { connect } from "node:net";

const [socket, kind, ...argv] = process.argv.slice(2);
const connection = connect(`\0${socket}`);
const send = (type, payload) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head = Buffer.alloc(5);
  head.write(type, 0, "latin1");
  head.writeUInt32BE(body.length, 1);
  connection.write(Buffer.concat([head, body]));
};

connection.on("connect", () => {
  send("H", JSON.stringify({ kind, argv, cwd: process.cwd(), env: process.env }));
  process.stdin.on("data", (chunk) => send("I", chunk));
  process.stdin.on("end", () => send("E", ""));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => send("K", signal));
});

let pending = Buffer.alloc(0);
connection.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 5) {
    const length = pending.readUInt32BE(1);
    if (pending.length < 5 + length) break;
    const type = pending.toString("latin1", 0, 1);
    const body = pending.subarray(5, 5 + length);
    pending = pending.subarray(5 + length);
    if (type === "O") process.stdout.write(body);
    else if (type === "R") process.stderr.write(body);
    else if (type === "X") {
      const { code, signal } = JSON.parse(body.toString("utf8"));
      process.stdout.write("", () => process.exit(code ?? (signal ? 128 + 15 : 1)));
    }
  }
});
connection.on("error", (error) => {
  process.stderr.write(`testmaster: session broker unavailable: ${error.message}\n`);
  process.exit(1);
});
