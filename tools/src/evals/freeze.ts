import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function assertRegistrationUnchanged(current: Uint8Array, committed: Uint8Array): void {
  if (
    createHash("sha256").update(current).digest("hex") !==
    createHash("sha256").update(committed).digest("hex")
  )
    throw new Error(
      "Preregistration changed after commit (including thresholds, selection or budget); version and commit a distinct round before execution",
    );
}
export async function committedRegistration(
  root: string,
  commit: string,
  registrationPath = "evals/preregistration.json",
): Promise<Buffer> {
  const rel = relative(resolve(root), resolve(root, registrationPath)).replaceAll("\\", "/");
  if (isAbsolute(registrationPath) || rel === ".." || rel.startsWith("../"))
    throw new Error(`Unsafe registration path: ${registrationPath}`);
  const { promise, resolve: accept, reject } = Promise.withResolvers<Buffer>();
  const child = spawn("git", ["--no-pager", "show", `${commit}:${rel}`], {
    cwd: root,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) child.kill("SIGKILL");
    else chunks.push(chunk);
  });
  child.stderr.resume();
  child.once("error", reject);
  child.once("exit", (code) =>
    code === 0 && bytes <= 1024 * 1024
      ? accept(Buffer.concat(chunks))
      : reject(new Error("Cannot read committed preregistration; refusing evaluation")),
  );
  return promise;
}
export async function assertFrozenFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, expected] of Object.entries(files)) {
    const confined = relative(resolve(root), resolve(root, path));
    if (isAbsolute(path) || confined === ".." || confined.startsWith(`..${sep}`))
      throw new Error(`Unsafe frozen input: ${path}`);
    if (
      createHash("sha256")
        .update(await readFile(resolve(root, path)))
        .digest("hex") !== expected
    )
      throw new Error(
        `Frozen input changed: ${path}; preregister a distinct round before live calls`,
      );
  }
}
