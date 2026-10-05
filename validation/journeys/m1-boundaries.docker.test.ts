import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { type ProjectConfig, validate } from "@testmaster/contracts";
import { expect, it } from "vitest";
import {
  action,
  controlledShop,
  diskSnapshot,
  eventually,
  files,
  healthPlan,
  journey,
  object,
  text,
} from "./harness.js";

it("CLI-002 invalid and valid offline dry-runs make no writes or fetches, with an exercised positive boundary control", async () => {
  await journey("cli-002-dry-run-boundary", async (session) => {
    const target = await controlledShop();
    try {
      const boundary = join(session.temporary, "boundary.jsonl");
      const preload = join(session.temporary, "boundary-recorder.mjs");
      await writeFile(boundary, "");
      await writeFile(
        preload,
        `import { appendFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const record = (kind, target) => appendFileSync(process.env.JOURNEY_BOUNDARY_LOG, JSON.stringify({kind,target:String(target)})+'\\n');
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => { record('fetch',args[0]); return originalFetch(...args); };
for (const [kind, transport] of [['http.request',http],['https.request',https]]) {
  const original = transport.request;
  transport.request = function(...args) { record(kind,args[0]); return original.apply(this,args); };
}
syncBuiltinESMExports();
`,
      );
      const options = {
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        JOURNEY_BOUNDARY_LOG: boundary,
      };
      const positive = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "const response = await fetch(process.env.JOURNEY_CONTROL_URL); if (!response.ok) process.exit(1); await response.text();",
        ],
        {
          env: { ...session.env, ...options, JOURNEY_CONTROL_URL: `${target.url}/health` },
          stdio: "pipe",
        },
      );
      const control = Promise.withResolvers<number | null>();
      positive.once("error", control.reject);
      positive.once("close", control.resolve);
      expect(await control.promise).toBe(0);
      expect(target.hits()).toBe(1);
      expect(await readFile(boundary, "utf8")).toContain('"kind":"fetch"');
      await writeFile(boundary, "");
      const invalid = join(session.cwd, "invalid.json");
      await writeFile(invalid, JSON.stringify({ ...healthPlan(), steps: [] }));
      const valid = await session.plan(healthPlan(), "valid.json");
      const before = await diskSnapshot(session.cwd);
      const homeBefore = await diskSnapshot(session.home);
      const invalidResult = await session.command(
        ["test", "create", "--plan", invalid, "--dry-run"],
        5,
        options,
      );
      expect(object(invalidResult.error).code).toBeDefined();
      const dry = await session.command(
        ["test", "create", "--plan", valid, "--dry-run"],
        0,
        options,
      );
      expect(dry).toEqual({
        dryRun: true,
        validated: true,
        operations: [],
        unresolvedPreconditions: [],
      });
      expect(await diskSnapshot(session.cwd)).toEqual(before);
      expect(await diskSnapshot(session.home)).toEqual(homeBefore);
      expect(await readFile(boundary, "utf8")).toBe("");
      expect(target.hits()).toBe(1);
      session.oracles.push({
        check: "offlineDryRunBoundary",
        healthy: true,
        positiveControl: { fetchCalls: 1, targetRequests: 1 },
        invalidExit: 5,
        validExit: 0,
        dryRunRequests: 0,
        repositoryAndHomeUnchanged: true,
      });
    } finally {
      await target.close();
    }
  });
}, 120_000);

it("CLI-003 read-only HOME reports session-only initialization rather than pretending identity was persisted", async () => {
  await journey("cli-003-readonly-home", async (session) => {
    const before = await diskSnapshot(session.home);
    await chmod(session.home, 0o555);
    try {
      const identity = await session.command([
        "init",
        "--mode",
        "local",
        "--name",
        "Read-only home",
        "--base-url",
        "http://127.0.0.1:43210",
      ]);
      expect(identity.sessionOnly).toBe(true);
      expect(identity.notice).toEqual(expect.any(String));
      const result = session.commands[session.commands.length - 1];
      expect(`${JSON.stringify(result?.json)} ${result?.stderr}`).toMatch(
        /session.only|ephemeral|not.persist/i,
      );
      expect(await files(session.home)).toHaveLength(0);
      await chmod(session.home, 0o755);
      expect(await diskSnapshot(session.home)).toEqual(before);
      session.oracles.push({
        check: "readonlyHomeSessionNotice",
        healthy: true,
        sessionOnly: identity.sessionOnly,
        notice: identity.notice,
      });
    } finally {
      await chmod(session.home, 0o700);
    }
  });
}, 120_000);

it("CLI-004 secret canary crosses the authorized HTTP boundary but is absent from argv, logs, reports and public artifacts", async () => {
  await journey("cli-004-canary-redaction", async (session) => {
    const target = await controlledShop();
    const canary = `tm-canary-${randomUUID()}-never-public`;
    try {
      await session.init(target.url);
      const configPath = join(session.cwd, "testmaster.config.json");
      const config = validate<ProjectConfig>(
        "ProjectConfig",
        JSON.parse(await readFile(configPath, "utf8")),
      );
      config.artifacts = { trace: "off", video: "off", retentionDays: 30 };
      await writeFile(configPath, JSON.stringify(config));
      const secret = await session.command(
        [
          "secret",
          "set",
          "JOURNEY_CANARY",
          "--from-env",
          "JOURNEY_CANARY_VALUE",
          "--allowed-origin",
          target.url,
        ],
        0,
        { JOURNEY_CANARY_VALUE: canary },
      );
      const secretId = text(secret.id);
      const plan = healthPlan();
      const step = plan.steps[0];
      if (!step || step.kind !== "action" || step.operation !== "request")
        throw new Error("Health plan request missing");
      plan.steps[0] = action(step.id, "request", {
        ...step.input,
        headers: { "x-canary": { secretRef: secretId } },
      });
      const test = await session.createTest(plan);
      const worker = await session.worker();
      target.hold();
      const receipt = await session.command(["test", "run", text(test.id)]);
      const runId = text(receipt.runId);
      await eventually(
        async () => target.hits(),
        (hits) => hits > 0,
      );
      expect(target.seenSecrets()).toEqual([canary]);
      expect(await readFile(`/proc/${worker.child.pid}/cmdline`, "utf8")).not.toContain(canary);
      const exec = promisify(execFile);
      const { stdout: containerIds } = await exec("docker", [
        "ps",
        "-q",
        "--filter",
        `label=io.testmaster.run=${runId}`,
      ]);
      expect(containerIds.trim()).not.toBe("");
      const { stdout: containerArguments } = await exec("docker", [
        "inspect",
        "--format",
        "{{json .Args}}",
        text(containerIds.trim().split("\n")[0]),
      ]);
      expect(containerArguments).not.toContain(canary);
      target.release();
      const result = await session.command(["run", "wait", runId, "--timeout", "120"]);
      expect(result.outcome).toBe("passed");
      worker.child.kill("SIGTERM");
      await worker.result;
      await session.command(["secret", "list"]);
      const output = join(session.cwd, "public-evidence");
      const bundle = await session.command(["artifact", "get", runId, "--out", output]);
      expect(object(bundle.manifest).runId).toBe(runId);
      const reports: string[] = [];
      for (const format of ["json", "markdown", "html", "junit", "allure"]) {
        const path = join(session.cwd, `report-${format}`);
        await session.command(["report", "export", runId, "--format", format, "--out", path]);
        reports.push(...(await files(path)));
        if ((await stat(path)).isFile()) reports.push(path);
      }
      const events = await session.start(["run", "events", runId, "--format", "ndjson"]).result;
      expect(events.exitCode).toBe(0);
      const publicFiles = [...(await files(output)), ...reports];
      expect(publicFiles.length).toBeGreaterThan(0);
      const controlFile = join(session.temporary, "scanner-positive-control");
      await writeFile(controlFile, canary);
      expect((await readFile(controlFile)).includes(Buffer.from(canary))).toBe(true);
      for (const path of publicFiles)
        expect((await readFile(path)).includes(Buffer.from(canary)), path).toBe(false);
      for (const command of session.commands) {
        expect(command.argv.join("\0")).not.toContain(canary);
        expect(command.stdout).not.toContain(canary);
        expect(command.stderr).not.toContain(canary);
      }
      session.oracles.push({
        check: "secretCanaryBoundaryAndRedaction",
        healthy: true,
        runId,
        secretId,
        deliveredAuthorizedRequests: target.seenSecrets().length,
        publicFilesChecked: publicFiles.length,
        scannerPositiveControl: true,
      });
    } finally {
      await target.close();
    }
  });
}, 300_000);

it("J01 dead DOCKER_HOST refuses execution without a local process fallback or target traffic", async () => {
  await journey("j01-docker-unavailable", async (session) => {
    const target = await controlledShop();
    try {
      await session.init(target.url);
      const test = await session.createTest(healthPlan());
      const result = await session.start(
        ["test", "run", text(test.id), "--wait", "--timeout", "30"],
        { DOCKER_HOST: `unix://${join(session.temporary, "nonexistent-docker.sock")}` },
      ).result;
      expect(result.exitCode).toBe(9);
      expect(result.json).toBeDefined();
      const envelope = object(result.json);
      const serialized = JSON.stringify(envelope);
      expect(serialized).toMatch(/sandbox|docker|policy/i);
      expect(target.hits()).toBe(0);
      for (const runId of session.runIds) {
        const run = await session.current(runId);
        expect(run.outcome).not.toBe("passed");
        expect(run.gate).not.toBe("passed");
        expect(JSON.stringify(run)).not.toContain('"executor":"process"');
      }
      session.oracles.push({
        check: "deadDockerNoProcessFallback",
        healthy: true,
        exitCode: result.exitCode,
        targetRequests: target.hits(),
      });
    } finally {
      await target.close();
    }
  });
}, 120_000);
