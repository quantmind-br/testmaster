#!/usr/bin/env node
// Round driver of the surface experiment (PLAN.md §10, "Protocolo por rodada"). It reads a
// committed preregistration, checks that the working tree is the registered commit and build, and
// runs every session (arms × apps × seeds × models) in the registered order. After each app's
// sessions it measures fidelity: the proxy in front of the target serves each seed's defect and the
// tests the session made green are replayed against it, then against the clean target. Finally it
// writes sessions.ndjson (one metrics record per session) next to the preregistration.
//
// Usage: node evals/surface/round.mjs ROUND_DIRECTORY [--app NAME]... [--only SESSION_ID...]
//        node evals/surface/round.mjs ROUND_DIRECTORY --metrics-only
//        node evals/surface/round.mjs --build-hash
// One process per app (--app) may run concurrently; --metrics-only then writes sessions.ndjson.
//
// Nothing here has a deadline: a session runs until its agent ends, a replay until its run
// settles (premise 1). Raw logs go to the state directory the preregistration names.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { measureFloor } from "./floor.mjs";
import { sessionMetrics } from "./metrics.mjs";
import { repo, runSession, sessionCli, sha256, treeHash, treeManifest } from "./session.mjs";
import { startTargetProxy } from "./target-proxy.mjs";

/** The build every arm runs: the compiled output of every workspace package and app. */
export function buildHash() {
  const roots = ["apps", "packages"].flatMap((group) =>
    spawnSync("git", ["-C", repo, "ls-files", "--", `${group}/*/package.json`], {
      encoding: "utf8",
    })
      .stdout.split("\n")
      .filter(Boolean)
      .map((file) => join(repo, file.replace(/package\.json$/, ""), "dist")),
  );
  const files = roots
    .filter((root) => existsSync(root))
    .flatMap((root) =>
      treeManifest(root).map((file) => ({
        ...file,
        path: `${root.slice(repo.length + 1)}/${file.path}`,
      })),
    )
    .filter((file) => !file.path.endsWith(".tsbuildinfo"));
  return treeHash(files);
}

/** Deterministic shuffle (mulberry32) so the session order is part of the preregistration. */
function shuffle(items, seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [out[index], out[other]] = [out[other], out[index]];
  }
  return out;
}

const fill = (template, values) =>
  template.replace(/\{(\w+)\}/g, (whole, key) => (key in values ? values[key] : whole));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** The sessions of a round, in the registered order: apps in order, sessions shuffled per app. */
export function plannedSessions(prereg) {
  return prereg.apps.flatMap((app, appIndex) =>
    shuffle(
      prereg.arms.flatMap((arm) =>
        app.seeds.flatMap((seed) =>
          prereg.models.map((model) => ({
            id: `${app.name}.${seed}.${arm.id}.${model.id}`,
            app: app.name,
            seed,
            arm: arm.id,
            model: model.id,
          })),
        ),
      ),
      prereg.orderSeed + appIndex,
    ),
  );
}

function assertRegistered(prereg) {
  const git = (...args) =>
    spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }).stdout.trim();
  // The preregistration is committed after the commit it registers, so HEAD may be later, but
  // only by round records: everything the sessions run must be byte-identical to that commit.
  if (spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", prereg.commit, "HEAD"]).status)
    throw new Error(`The registered commit ${prereg.commit} is not an ancestor of HEAD`);
  const changed = [
    ...git("diff", "--name-only", prereg.commit, "--", "apps", "packages", "tools", "evals/surface")
      .split("\n")
      .filter(Boolean),
    ...git(
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      "apps",
      "packages",
      "tools",
      "evals/surface",
    )
      .split("\n")
      .filter(Boolean),
  ].filter((path) => !path.startsWith("evals/surface/rounds/"));
  if (changed.length)
    throw new Error(`Changed since the registered commit: ${changed.slice(0, 10).join(", ")}`);
  const build = buildHash();
  if (build !== prereg.buildHash)
    throw new Error(`Build ${build} is not the registered build ${prereg.buildHash}`);
  for (const arm of prereg.arms) {
    const hash = treeHash(treeManifest(join(repo, arm.skillDir)));
    if (hash !== arm.skillSha256)
      throw new Error(`Skill of ${arm.id} hashes ${hash}, registered ${arm.skillSha256}`);
  }
  const a0 = sha256(readFileSync(join(repo, prereg.a0ToolsList)));
  if (a0 !== prereg.a0ToolsListSha256) throw new Error(`A0 tools/list hashes ${a0}`);
  const protocol = sha256(readFileSync(join(repo, "evals/surface/preregistration.json")));
  if (protocol !== prereg.protocolSha256)
    throw new Error(`The protocol evals/surface/preregistration.json hashes ${protocol}`);
  const template = sha256(readFileSync(join(repo, prereg.taskTemplate)));
  if (template !== prereg.taskTemplateSha256) throw new Error(`Task template hashes ${template}`);
}

/** Starts an app the harness owns (a fixture) and resolves when it answers; returns a stop function. */
async function startOwned(app, port, env = {}) {
  const command = app.start.command.map((part) => part.replace("{port}", String(port)));
  const child = spawn(command[0], command.slice(1), {
    cwd: join(repo, app.start.cwd),
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
  await waitListening(`http://127.0.0.1:${port}${app.health ?? "/"}`);
  // Resolves once the process is gone, so the next instance can bind the same port.
  return () =>
    new Promise((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done();
      child.once("exit", () => done());
      child.kill();
    });
}

/** Waits until `url` answers at all (a mutant may answer its health check with an error). */
async function waitListening(url) {
  for (;;) {
    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
}

/** Runs `tasks` with at most `limit` in flight. */
async function pool(tasks, limit) {
  const queue = [...tasks];
  await Promise.all(
    Array.from({ length: Math.max(1, limit) }, async () => {
      while (queue.length) await queue.shift()();
    }),
  );
}

/** The tests the session made green on their active revision, from its post-session state. */
function greenTests(state) {
  const active = new Map(state.tests.map((test) => [test.id, test.activeRevisionId]));
  const ids = state.runs
    .filter(
      (run) =>
        run.phase === "completed" &&
        run.outcome === "passed" &&
        run.gate === "passed" &&
        active.get(run.testId) === run.revisionId,
    )
    .map((run) => run.testId);
  return [...new Set(ids)];
}

/** Replays one test's active revision and returns the settled run's verdict. */
async function replay(session, testId) {
  const result = await sessionCli(session, ["test", "run", testId, "--wait"]);
  const run = result.envelope?.data?.run ?? null;
  return {
    testId,
    exit: result.exit,
    runId: run?.id ?? null,
    phase: run?.phase ?? null,
    outcome: run?.outcome ?? null,
    gate: run?.gate ?? null,
    reasonCode: run?.reasonCode ?? null,
    error: result.envelope?.error?.code ?? null,
  };
}
const green = (verdict) =>
  verdict.phase === "completed" && verdict.outcome === "passed" && verdict.gate === "passed";

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--build-hash") {
    console.log(buildHash());
    return;
  }
  const roundDirectory = resolve(argv[0]);
  const flagValues = (flag) =>
    argv.flatMap((value, index) => (argv[index - 1] === flag ? [value] : []));
  const only = argv.includes("--only") ? new Set(argv.slice(argv.indexOf("--only") + 1)) : null;
  const apps = new Set(flagValues("--app"));
  const metricsOnly = argv.includes("--metrics-only");
  const prereg = readJson(join(roundDirectory, "preregistration.json"));
  assertRegistered(prereg);
  const stateDirectory = join(prereg.stateDirectory.replace(/^~(?=\/)/, homedir()), prereg.round);
  mkdirSync(join(stateDirectory, "sessions"), { recursive: true });
  const template = readFileSync(join(repo, prereg.taskTemplate), "utf8");
  const home = homedir();
  const internal = {
    profiles: readJson(join(home, ".config", "testmaster", "profiles.json")),
    policy: readJson(join(home, ".config", "testmaster", "policy.json")),
  };
  const planned = metricsOnly
    ? []
    : plannedSessions(prereg).filter(
        (session) => (!only || only.has(session.id)) && (!apps.size || apps.has(session.app)),
      );
  // The harness floor of T1 (floor.mjs); a failed measurement is recorded, not fatal.
  const floorOf = async (directory) => {
    try {
      await measureFloor(directory, {
        upstream: prereg.agentUpstream,
        apiKey: process.env.QUANTFORGE_API_KEY,
      });
    } catch (error) {
      writeFileSync(join(directory, "floor.json"), JSON.stringify({ error: String(error) }));
    }
  };
  const log = (message) => console.log(`${new Date().toISOString()} ${message}`);

  for (const appEntry of prereg.apps) {
    const sessions = planned.filter((session) => session.app === appEntry.name);
    if (!sessions.length) continue;
    const appDirectory = join(repo, "evals", "surface", "apps", appEntry.name);
    const app = readJson(join(appDirectory, "app.json"));
    const seeds = new Map(
      readJson(join(appDirectory, "seeds.json")).map((seed) => [seed.id, seed]),
    );
    const stopApp = app.start ? await startOwned(app, appEntry.upstreamPort) : async () => {};
    const upstream = app.upstream ?? `http://127.0.0.1:${appEntry.upstreamPort}`;
    await waitListening(`${upstream}${app.health ?? "/"}`);
    const proxy = await startTargetProxy({ upstream, port: appEntry.proxyPort });
    const targetUrl = proxy.url;
    const secrets = app.secretsFile ? readJson(app.secretsFile.replace(/^~(?=\/)/, home)) : {};
    log(`${app.name}: ${sessions.length} sessions through ${targetUrl}`);

    await pool(
      sessions.map((planned) => async () => {
        const directory = join(stateDirectory, "sessions", planned.id);
        const done = join(directory, "state.json");
        if (existsSync(done)) {
          if (!existsSync(join(directory, "floor.json"))) await floorOf(directory);
          return;
        }
        // A session directory without its state is a harness interruption, not a result.
        if (existsSync(directory)) renameSync(directory, `${directory}.interrupted-${Date.now()}`);
        const arm = prereg.arms.find((candidate) => candidate.id === planned.arm);
        const seed = seeds.get(planned.seed);
        const values = {
          targetUrl,
          task: seed.task,
          internalProvider: prereg.internal.provider,
          internalModel: prereg.internal.model,
          secretsNote: app.secretsNote ? ` ${fill(app.secretsNote, { targetUrl })}` : "",
        };
        values.context = fill(app.context, values);
        log(`start ${planned.id}`);
        const record = await runSession(
          {
            id: planned.id,
            arm: { id: arm.id, mcp: arm.mcp, skillDir: join(repo, arm.skillDir) },
            model: planned.model,
            thinking: prereg.models.find((model) => model.id === planned.model).thinking,
            seed: planned.seed,
            app: {
              name: app.name,
              ...(app.source
                ? { source: join(repo, app.source), sourceExclude: app.sourceExclude }
                : { repo: app.repo.replace(/^~(?=\/)/, home), commit: app.commit }),
              targetUrl,
              env: Object.fromEntries(
                Object.entries(app.agentEnv ?? {}).map(([name, key]) => [name, secrets[key]]),
              ),
            },
            prompt: fill(template, values),
            internal,
            a0ToolsList: join(repo, prereg.a0ToolsList),
          },
          directory,
        );
        // An agent that never reached its model is a harness failure, not a session result.
        if (!existsSync(join(directory, "model", "model-requests.ndjson"))) {
          renameSync(directory, `${directory}.harness-failed-${Date.now()}`);
          throw new Error(`${planned.id}: the agent made no model request (see agent.stderr)`);
        }
        // An agent that ended on a refused model request (quota, outage) was stopped by its
        // provider, not by the task: not a result, and a provider down stops the round (protocol
        // stopRules.midRound). Its session reruns when the round is resumed.
        const requests = readFileSync(join(directory, "model", "model-requests.ndjson"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const last = requests.at(-1);
        if (record.agentExit.code !== 0 && last?.status !== 200) {
          renameSync(directory, `${directory}.provider-failed-${Date.now()}`);
          throw new Error(
            `${planned.id}: the provider refused model request ${last?.seq} (HTTP ${last?.status}); the round stops`,
          );
        }
        const tests = (await sessionCli(record, ["test", "list"])).envelope?.data ?? [];
        const runs = (await sessionCli(record, ["run", "list"])).envelope?.data ?? [];
        // Every revision of every test, for the weakened-assertion review (metrics.mjs).
        for (const test of tests)
          test.revisions =
            (await sessionCli(record, ["test", "revision", "list", test.id])).envelope?.data ?? [];
        writeFileSync(done, JSON.stringify({ tests, runs }, null, 2));
        await floorOf(directory);
        log(
          `end ${planned.id} exit=${record.agentExit.code} ${Math.round(record.wallClockMs / 1000)}s`,
        );
      }),
      appEntry.concurrency ?? 1,
    );

    // Fidelity: each seed's defect, then the clean target, against the tests each session made green.
    const finished = sessions
      .map((planned) => join(stateDirectory, "sessions", planned.id))
      .filter((directory) => !existsSync(join(directory, "fidelity.json")))
      .map((directory) => ({
        directory,
        record: readJson(join(directory, "session.json")),
        state: readJson(join(directory, "state.json")),
      }));
    const verdicts = new Map(finished.map((item) => [item.directory, { mutant: [], clean: [] }]));
    for (const seedId of new Set(finished.map((item) => item.record.seed))) {
      const seed = seeds.get(seedId);
      let stopMutant = async () => {};
      if (seed.mutant.env) {
        stopMutant = await startOwned(app, appEntry.mutantPort, seed.mutant.env);
        proxy.setMutant({ upstream: `http://127.0.0.1:${appEntry.mutantPort}` });
      } else proxy.setMutant({ rules: seed.mutant.rules });
      for (const item of finished.filter((candidate) => candidate.record.seed === seedId))
        for (const testId of greenTests(item.state))
          verdicts.get(item.directory).mutant.push(await replay(item.record, testId));
      proxy.setMutant(null);
      await stopMutant();
    }
    for (const item of finished)
      for (const testId of greenTests(item.state))
        verdicts.get(item.directory).clean.push(await replay(item.record, testId));
    for (const item of finished) {
      const { mutant, clean } = verdicts.get(item.directory);
      const reproduced = clean.filter(green).map((verdict) => verdict.testId);
      writeFileSync(
        join(item.directory, "fidelity.json"),
        JSON.stringify(
          {
            seed: item.record.seed,
            greenTests: greenTests(item.state),
            mutant,
            clean,
            completion: reproduced.length > 0,
            // The defect is detected when a test that is green on the clean target fails on it.
            detected: mutant.some(
              (verdict) =>
                reproduced.includes(verdict.testId) &&
                verdict.phase === "completed" &&
                !green(verdict),
            ),
            falsePositive: clean.some((verdict) => !green(verdict)),
          },
          null,
          2,
        ),
      );
    }
    await proxy.close();
    await stopApp();
    log(`${app.name}: fidelity done`);
  }

  // One metrics record per session of the round.
  const records = plannedSessions(prereg)
    .map((planned) => join(stateDirectory, "sessions", planned.id))
    .filter((directory) => existsSync(join(directory, "fidelity.json")))
    .map((directory) => {
      const record = readJson(join(directory, "session.json"));
      const app = readJson(join(repo, "evals", "surface", "apps", record.app, "app.json"));
      const secrets = app.secretsFile
        ? Object.values(readJson(app.secretsFile.replace(/^~(?=\/)/, home)))
        : [];
      return sessionMetrics(directory, { secrets, outsideRoots: [home, repo] });
    });
  writeFileSync(
    join(roundDirectory, "sessions.ndjson"),
    records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""),
  );
  log(`${records.length} session records written to ${join(roundDirectory, "sessions.ndjson")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
