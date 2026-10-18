#!/usr/bin/env node
// CLI collector the session broker runs for each `testmaster` call of the agent, outside its
// sandbox (see broker-client.mjs). It runs the real CLI with the same
// argv, stdin and environment, passes stdout and stderr through unchanged and appends one NDJSON
// record per invocation: argv (with seeded secret values replaced), exit code, output bytes and
// the error code of a failing JSON envelope. With SURFACE_CLI_CAPTURE it also keeps each
// invocation's stdout and stderr (seeded secrets replaced) as <seq>.stdout / <seq>.stderr.
//
// Environment: SURFACE_REAL_CLI (path of apps/cli/dist/main.js), SURFACE_CLI_LOG (NDJSON file),
// SURFACE_SECRETS (optional file with one seeded secret value per line), SURFACE_CLI_CAPTURE
// (optional directory).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const real = process.env.SURFACE_REAL_CLI;
const log = process.env.SURFACE_CLI_LOG;
if (!real || !log) throw new Error("SURFACE_REAL_CLI and SURFACE_CLI_LOG are required");
const capture = process.env.SURFACE_CLI_CAPTURE;
const secrets =
  process.env.SURFACE_SECRETS && existsSync(process.env.SURFACE_SECRETS)
    ? readFileSync(process.env.SURFACE_SECRETS, "utf8").split("\n").filter(Boolean)
    : [];
const redact = (text) =>
  secrets.reduce((value, secret) => value.split(secret).join("[SEEDED_SECRET]"), text);
const argv = process.argv.slice(2);
const leaked = argv.some((arg) => secrets.some((secret) => arg.includes(secret)));

/** The error code of the JSON envelope a failing command prints, on stdout or stderr. */
function envelopeError(...texts) {
  for (const text of texts) {
    const trimmed = text.trim();
    for (const candidate of [trimmed, trimmed.split("\n").at(-1) ?? ""]) {
      try {
        const code = JSON.parse(candidate)?.error?.code;
        if (typeof code === "string") return code;
      } catch {}
    }
  }
  return null;
}

const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const startedAt = Date.now();
const child = spawn(process.execPath, [real, ...argv], { stdio: ["inherit", "pipe", "pipe"] });
const stdout = [];
const stderr = [];
child.stdout.on("data", (chunk) => {
  stdout.push(chunk);
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  stderr.push(chunk);
  process.stderr.write(chunk);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("close", (code, signal) => {
  const out = Buffer.concat(stdout);
  const err = Buffer.concat(stderr);
  if (capture) {
    mkdirSync(capture, { recursive: true });
    writeFileSync(join(capture, `${id}.stdout`), redact(out.toString("utf8")));
    writeFileSync(join(capture, `${id}.stderr`), redact(err.toString("utf8")));
  }
  appendFileSync(
    log,
    `${JSON.stringify({
      id,
      at: new Date(startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      argv: argv.map(redact),
      secretInArgv: leaked,
      exitCode: code,
      signal,
      errorCode: code ? envelopeError(out.toString("utf8"), err.toString("utf8")) : null,
      stdoutBytes: out.length,
      stderrBytes: err.length,
      latencyMs: Date.now() - startedAt,
    })}\n`,
  );
  process.exitCode = code ?? 1;
});
