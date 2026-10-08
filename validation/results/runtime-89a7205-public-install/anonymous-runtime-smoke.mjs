import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { join } from 'node:path';
const exec = promisify(execFile);
const base = '/home/diogo/.local/state/testmaster-releases/runtime-36b3859/anonymous-acceptance';
const cli = '/home/diogo/.local/state/testmaster-releases/runtime-36b3859/public-installed/apps/cli/dist/main.js';
const cwd = join(base, 'consumer-project');
await mkdir(cwd, { mode: 0o700 });
let defective = false;
let requests = 0;
const server = createServer((req, res) => {
  requests++;
  if (req.url !== '/health') { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: defective ? 'degraded' : 'ok' }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|TOKEN|SECRET|PASSWORD/.test(k)));
env.HOME = join(base, 'consumer-home');
env.XDG_CONFIG_HOME = join(env.HOME, '.config');
env.XDG_DATA_HOME = join(env.HOME, '.local/share');
const commands = [];
async function call(args, expected = 0) {
  let stdout, stderr, code = 0;
  try { ({stdout, stderr} = await exec(process.execPath, [cli, ...args], { cwd, env, timeout: 180000, maxBuffer: 32 * 1024 ** 2 })); }
  catch (error) { ({stdout, stderr, code} = error); }
  assert.equal(code, expected, `${args.join(' ')}: ${stderr}`);
  commands.push({ args, exitCode: code, stdout, stderr });
  return JSON.parse(stdout);
}
try {
  await call(['--json', 'init', '--mode', 'local', '--name', 'release-smoke', '--base-url', url]);
  await call(['--json', 'doctor']);
  const plan = await call(['--json', 'test', 'scaffold', '--type', 'backend']);
  await writeFile(join(cwd, 'health.plan.json'), JSON.stringify(plan.data));
  const test = await call(['--json', 'test', 'create', '--plan', 'health.plan.json']);
  assert.match(test.data.id, /^tst_/);
  const healthy = await call(['--json', 'test', 'run', test.data.id, '--wait']);
  defective = true;
  const negative = await call(['--json', 'test', 'run', test.data.id, '--wait'], 1);
  const runs = await call(['--json', 'run', 'list']);
  assert.ok(requests >= 2, 'No actual target requests');
  const evidence = { sourceCommit: process.argv[2], modelCalls: 0, requests, healthy, negative, runs, commands };
  await writeFile(join(base, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ requests, healthyExit: 0, semanticNegativeExit: 1, modelCalls: 0 }));
} finally { await new Promise(resolve => server.close(resolve)); }
