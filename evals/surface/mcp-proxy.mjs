#!/usr/bin/env node
// Stdio MCP collector between an agent and `testmaster mcp serve`. It relays newline-delimited
// JSON-RPC unchanged in both directions and appends one NDJSON record per tools/list, tools/call
// and resources/read exchange: the arguments (or the resource URI), request and result bytes,
// isError and the error code. With --tools-list it
// answers tools/list from a frozen snapshot instead (the A0 arm), so every arm runs the same build.
//
// Usage: node evals/surface/mcp-proxy.mjs --log FILE [--tools-list SNAPSHOT] -- COMMAND [ARGS...]
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const separator = process.argv.indexOf("--");
if (separator === -1 || separator === process.argv.length - 1)
  throw new Error("Usage: mcp-proxy.mjs --log FILE [--tools-list SNAPSHOT] -- COMMAND [ARGS...]");
const own = process.argv.slice(2, separator);
const option = (name) => {
  const index = own.indexOf(name);
  return index === -1 ? undefined : own[index + 1];
};
const log = option("--log");
if (!log) throw new Error("--log is required");
const snapshotPath = option("--tools-list");
const snapshot = snapshotPath ? JSON.parse(readFileSync(snapshotPath, "utf8")) : null;
const [command, ...args] = process.argv.slice(separator + 1);

const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
const record = (value) => appendFileSync(log, `${JSON.stringify(value)}\n`);

function errorCode(result) {
  const structured = result?.structuredContent?.error?.code;
  if (typeof structured === "string") return structured;
  const last = Array.isArray(result?.content) ? result.content.at(-1)?.text : undefined;
  try {
    const code = JSON.parse(String(last)).error?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    child.stdin.write(`${line}\n`);
    return;
  }
  if (["tools/list", "tools/call", "resources/read"].includes(message.method))
    pending.set(message.id, {
      method: message.method,
      tool: message.params?.name ?? null,
      ...(message.method === "tools/call" ? { arguments: message.params?.arguments ?? {} } : {}),
      ...(message.method === "resources/read" ? { uri: message.params?.uri ?? null } : {}),
      argsBytes: Buffer.byteLength(JSON.stringify(message.params?.arguments ?? {})),
      startedAt: Date.now(),
    });
  child.stdin.write(`${line}\n`);
});
process.stdin.on("end", () => child.stdin.end());

createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(`${line}\n`);
    return;
  }
  const request = message.id === undefined ? undefined : pending.get(message.id);
  if (!request) {
    process.stdout.write(`${line}\n`);
    return;
  }
  pending.delete(message.id);
  let out = line;
  if (request.method === "tools/list" && snapshot && message.result)
    out = JSON.stringify({ ...message, result: { ...message.result, tools: snapshot.tools } });
  const result = message.result;
  record({
    startedAt: new Date(request.startedAt).toISOString(),
    at: new Date().toISOString(),
    method: request.method,
    tool: request.tool,
    ...(request.arguments ? { arguments: request.arguments } : {}),
    ...(request.uri !== undefined ? { uri: request.uri } : {}),
    argsBytes: request.argsBytes,
    resultBytes: Buffer.byteLength(out),
    structuredBytes:
      result?.structuredContent === undefined
        ? 0
        : Buffer.byteLength(JSON.stringify(result.structuredContent)),
    textBytes: [...(result?.content ?? []), ...(result?.contents ?? [])].reduce(
      (total, item) => total + (typeof item.text === "string" ? Buffer.byteLength(item.text) : 0),
      0,
    ),
    isError: result?.isError === true || message.error !== undefined,
    errorCode: message.error ? `jsonrpc_${message.error.code}` : errorCode(result),
    latencyMs: Date.now() - request.startedAt,
    ...(request.method === "tools/list"
      ? { toolCount: (snapshot?.tools ?? result?.tools ?? []).length, fromSnapshot: !!snapshot }
      : {}),
  });
  process.stdout.write(`${out}\n`);
});

child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
  process.stdout.end();
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
