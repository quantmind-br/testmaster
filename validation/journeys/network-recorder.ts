import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { type Journey, object, root } from "./harness.js";

export async function recordNetwork(session: Journey, label: string) {
  const syscalls = join(session.temporary, `${label}.strace`);
  const requests = join(session.temporary, `${label}.jsonl`);
  const preload = join(session.temporary, "network-recorder.mjs");
  await writeFile(requests, "");
  await writeFile(
    preload,
    `import { appendFileSync } from 'node:fs';
import { channel } from 'node:diagnostics_channel';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
const record = (kind, target) => appendFileSync(process.env.TM_NETWORK_LOG, JSON.stringify({pid:process.pid,kind,target:String(target)})+'\\n');
record('loaded', process.pid);
const fetch = globalThis.fetch;
globalThis.fetch = function(input,...args) { record('fetch',input?.url ?? input); return fetch.call(this,input,...args); };
channel('undici:request:create').subscribe(({request}) => record('undici',String(request.origin)+new URL(request.path,String(request.origin)).pathname));
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) { const options = args[0]; record('net', typeof options === 'object' ? (options.path ?? options.host ?? options[0]?.host ?? 'socket') : options); return connect.apply(this,args); };
const secure = tls.connect;
tls.connect = function(...args) { record('tls',args[0]?.host ?? args[1] ?? 'tls'); return secure.apply(this,args); };
for (const key of ['lookup','resolve','resolve4','resolve6']) { const original = dns[key]; dns[key] = function(...args) { record('dns',args[0]); return original.apply(this,args); }; }
syncBuiltinESMExports();
`,
  );
  session.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
  session.env.TM_NETWORK_LOG = requests;
  // strace follows exec/fork, including native Docker/Git children that NODE_OPTIONS cannot cover.
  // Only connection addresses are captured: never send/write buffers or credentials.
  session.commandPrefix = [
    "strace",
    "-f",
    "-qq",
    "-s",
    "0",
    "-e",
    "trace=connect,sendto,sendmsg,sendmmsg",
    "-o",
    syscalls,
  ];
  return {
    async read() {
      const trace = await readFile(syscalls, "utf8");
      const events = (await readFile(requests, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => object(JSON.parse(line)));
      expect(events.some((event) => event.kind === "loaded")).toBe(true);
      return { trace, events };
    },
    async save(trace: string, events: unknown[]) {
      const path = `validation/results/${session.name}-${label}-network.json`;
      await writeFile(
        join(root, path),
        JSON.stringify(
          {
            method:
              "Linux strace process-tree connection addresses plus Node fetch/undici/net/tls/dns diagnostics",
            trace,
            events,
          },
          null,
          2,
        ),
      );
      return path;
    },
    async checkpoint() {
      // strace opens its output anew per CLI invocation; collect it before the next command.
      const { trace } = await this.read();
      await appendFile(join(session.temporary, `${label}-all.strace`), trace);
    },
    async all() {
      const recorded = await this.read();
      return {
        ...recorded,
        trace: await readFile(join(session.temporary, `${label}-all.strace`), "utf8"),
      };
    },
  };
}

export function assertOnlyTargetConnections(trace: string, target: string) {
  const url = new URL(target);
  const inet = trace.split("\n").filter((line) => /sa_family=AF_INET6?[,}]/.test(line));
  expect(inet.length, "A real target TCP connection must be observed").toBeGreaterThan(0);
  for (const line of inet) {
    expect(line).toContain(`sin_port=htons(${url.port})`);
    expect(line).toContain('sin_addr=inet_addr("127.0.0.1")');
  }
  return inet.length;
}

export function assertNoTestSpriteRequests(events: Record<string, unknown>[]) {
  expect(events.filter((event) => /testsprite(?:\.|\/|:)/i.test(String(event.target)))).toEqual([]);
}
