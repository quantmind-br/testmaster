import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * The `docker-rootless` project must run against a rootless daemon that it names explicitly, never
 * against whatever `docker` resolves to by default. The socket comes from
 * `TESTMASTER_ROOTLESS_DOCKER_HOST` or the user's `$XDG_RUNTIME_DIR/docker.sock`; it is exported to
 * this process (so PostgreSQL test containers start on it too) and to the test workers. A rootful
 * daemon behind that socket, or a missing socket, fails the whole run before any test starts, so
 * rootless evidence cannot be produced by accident from the rootful daemon.
 */
export default async function assertRootlessDaemon(): Promise<void> {
  const host =
    process.env.TESTMASTER_ROOTLESS_DOCKER_HOST ??
    `unix://${process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`}/docker.sock`;
  process.env.DOCKER_HOST = host;
  process.env.TESTMASTER_JOURNEY_DOCKER_HOST = host;
  const info = await exec("docker", ["info", "--format", "{{json .SecurityOptions}}"], {
    env: process.env,
    timeout: 30_000,
  }).catch((error: unknown) => {
    throw new Error(`rootless Docker daemon at ${host} is unreachable: ${String(error)}`);
  });
  const options = JSON.parse(info.stdout) as string[];
  if (!options.some((option) => option.includes("name=rootless")))
    throw new Error(`Docker daemon at ${host} is not rootless (SecurityOptions: ${info.stdout})`);
}
