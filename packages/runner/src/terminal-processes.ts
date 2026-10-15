import { readdir, readFile } from "node:fs/promises";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
}
/**
 * Which processes belong to the attempt. `container` counts every process of the sandbox except
 * init and the harness (the pid namespace is private to the attempt). `marked` is for hosts that
 * share their pid namespace: a process belongs to the attempt when it descends from a spawned
 * group or session, or still carries the environment marker the harness gave every program.
 */
export interface SweepScope {
  mode: "container" | "marked";
  mark: string;
  /** Pids of spawned children (each is its own process group and, for a PTY, session leader). */
  owned: ReadonlySet<number>;
  /** Pids of live sessions whose processes must not be counted or killed. */
  spared: ReadonlySet<number>;
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** SIGHUP and SIGTERM first, then SIGKILL on the whole group once the grace period is over. */
export async function terminateGroup(pid: number, graceMs = 400): Promise<void> {
  signalGroup(pid, "SIGHUP");
  signalGroup(pid, "SIGTERM");
  const until = performance.now() + graceMs;
  while (groupAlive(pid) && performance.now() < until) await sleep(20);
  signalGroup(pid, "SIGKILL");
}
async function readProcess(pid: number): Promise<(ProcessInfo & { state: string }) | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // The command name is parenthesised and may itself contain spaces and parentheses.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const [state, ppid, pgid, sid] = rest;
    if (state === undefined || ppid === undefined || pgid === undefined || sid === undefined)
      return undefined;
    return { pid, ppid: Number(ppid), pgid: Number(pgid), sid: Number(sid), state };
  } catch {
    return undefined;
  }
}
async function marked(pid: number, mark: string): Promise<boolean> {
  try {
    const environment = await readFile(`/proc/${pid}/environ`, "latin1");
    return environment.split("\0").includes(`TESTMASTER_TERMINAL_MARK=${mark}`);
  } catch {
    return false;
  }
}
/** Live (non-zombie) processes of the attempt, never init, the harness or a spared session. */
export async function findSurvivors(scope: SweepScope): Promise<number[]> {
  const result: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^[1-9][0-9]*$/u.test(entry)) continue;
    const pid = Number(entry);
    if (pid === 1 || pid === process.pid) continue;
    const info = await readProcess(pid);
    if (!info || info.state === "Z" || info.state === "X") continue;
    if (scope.spared.has(info.pgid) || scope.spared.has(info.sid) || scope.spared.has(pid))
      continue;
    if (
      scope.mode === "container" ||
      scope.owned.has(info.pgid) ||
      scope.owned.has(info.sid) ||
      scope.owned.has(pid) ||
      (await marked(pid, scope.mark))
    )
      result.push(pid);
  }
  return result;
}
/**
 * Counts what is still alive after the settle window (a helper exiting right behind its parent is
 * not a leak), kills it, and returns the count.
 */
export async function reapSurvivors(scope: SweepScope, settleMs = 250): Promise<number> {
  const until = performance.now() + settleMs;
  let survivors = await findSurvivors(scope);
  while (survivors.length && performance.now() < until) {
    await sleep(25);
    survivors = await findSurvivors(scope);
  }
  for (const pid of survivors) signalGroup(pid, "SIGKILL");
  // Kill again by pid: a survivor may have left the group it was found through.
  for (const pid of survivors)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  return survivors.length;
}
