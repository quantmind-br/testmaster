import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
async function docker(args: string[]) {
  try {
    const result = await exec("docker", args, { maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code: number; stdout: string; stderr: string };
    if (typeof failure.code !== "number") throw error;
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

/**
 * `test_decide` ids of the non-canonical host vectors of the egress policy. pytest writes a
 * non-ASCII character of an id as its `\u` escape.
 */
const egressVectorIds = [
  "https://0x7f.1/a.png-GET-image-fatal",
  "http://127.1/a.png-GET-image-fatal",
  "http://2130706433/a.png-GET-image-fatal",
  "http://0177.0.0.1/a.png-GET-image-fatal",
  "https://example.123/a.png-GET-image-fatal",
  "http://256.1.1.1/a.png-GET-image-fatal",
  "http://\\uff11\\uff12\\uff17.\\uff10.\\uff10.\\uff11/a.png-GET-image-fatal",
  "http://127\\u30020\\u30020\\u30021/a.png-GET-image-fatal",
  "http://a..1/a.png-GET-image-fatal",
  "http://127.0.0.1/a.png-GET-image-aborted",
  "http://[::ffff:1.2.3.4]/a.png-GET-image-aborted",
];

it("the Python runner's unit suite passes inside the locked Python runner image", async () => {
  const lock = JSON.parse(await readFile(resolve("containers/images.lock.json"), "utf8"));
  const imageId: string = lock["testmaster-runner-python"].imageId;
  // The mounted working tree shadows the copy of `python/` baked into the image; the ZAP adapter
  // its unit tests load by path is mounted at the same relative place (ADR-033).
  const result = await docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=256m",
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--security-opt",
    `seccomp=${resolve("containers/seccomp_profile.json")}`,
    "--init",
    "-e",
    "PYTHONPATH=/work/python",
    "--mount",
    `type=bind,src=${resolve("python")},dst=/work/python,readonly`,
    "--mount",
    `type=bind,src=${resolve("containers/zap")},dst=/work/containers/zap,readonly`,
    "--workdir",
    "/work/python",
    "--entrypoint",
    "python",
    imageId,
    "-m",
    "pytest",
    "-q",
    "-rA",
    "-p",
    "no:cacheprovider",
    "tests/unit",
  ]);
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
  // `-rA` lists every passed test in the summary, so the run names each egress vector.
  for (const id of egressVectorIds)
    expect(result.stdout).toContain(`PASSED tests/unit/test_egress.py::test_decide[${id}]`);
  expect(result.stdout).toContain(
    "PASSED tests/unit/test_egress.py::test_canonical_origin_refuses_non_canonical_ipv4_hosts",
  );
});
