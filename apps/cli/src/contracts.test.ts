import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { jsonSchema } from "@testmaster/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

interface Document {
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}
const originalExitCode = process.exitCode;
const roots: string[] = [];
beforeEach(() => {
  process.exitCode = undefined;
});
afterEach(async () => {
  process.exitCode = originalExitCode;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workingDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tm-cli-contract-"));
  roots.push(root);
  return root;
}
async function invoke(args: string[], root?: string) {
  let stdout = "";
  const sink = (append: (text: string) => void) =>
    new Writable({
      write(chunk, _encoding, callback) {
        append(String(chunk));
        callback();
      },
    });
  const cwd = root ?? (await workingDirectory());
  await runCli(
    ["--cwd", cwd, ...args],
    new Runtime(
      sink((text) => {
        stdout += text;
      }),
      sink(() => undefined),
    ),
  );
  return { stdout, exit: process.exitCode ?? 0 };
}

it("contract schema prints the schema the MCP resource serves, as pretty text and as the JSON envelope data", async () => {
  const text = await invoke(["contract", "schema", "Step"]);
  expect(text.exit).toBe(0);
  expect(JSON.parse(text.stdout)).toEqual(jsonSchema("Step"));
  expect(text.stdout).toContain("\n  ");

  const json = await invoke(["--output", "json", "contract", "schema", "ExecutablePlan"]);
  expect(json.exit).toBe(0);
  expect((JSON.parse(json.stdout) as Document).data).toEqual(jsonSchema("ExecutablePlan"));
});

it("contract schema --out writes the schema to a new file and never overwrites one", async () => {
  const root = await workingDirectory();
  const first = await invoke(
    ["--output", "json", "contract", "schema", "Step", "--out", "step.json"],
    root,
  );
  expect(first.exit).toBe(0);
  const receipt = (JSON.parse(first.stdout) as Document).data as {
    name: string;
    path: string;
    sizeBytes: number;
  };
  expect(receipt.name).toBe("Step");
  const written = await readFile(join(root, "step.json"), "utf8");
  expect(receipt.path).toBe(join(root, "step.json"));
  expect(Buffer.byteLength(written)).toBe(receipt.sizeBytes);
  expect(JSON.parse(written)).toEqual(jsonSchema("Step"));

  // Negative control: an existing file is refused and keeps its bytes.
  process.exitCode = undefined;
  await writeFile(join(root, "taken.json"), "keep");
  const refused = await invoke(
    ["--output", "json", "contract", "schema", "Step", "--out", "taken.json"],
    root,
  );
  expect((JSON.parse(refused.stdout) as Document).error?.code).toBe("INVALID_ARGUMENT");
  expect(refused.exit).toBe(5);
  expect(await readFile(join(root, "taken.json"), "utf8")).toBe("keep");
});

it("contract schema refuses an unknown or mistyped name with NOT_FOUND naming the similar ones", async () => {
  const mistyped = await invoke(["--output", "json", "contract", "schema", "executableplan"]);
  expect(mistyped.exit).toBe(4);
  const error = (JSON.parse(mistyped.stdout) as Document).error;
  expect(error?.code).toBe("NOT_FOUND");
  expect(error?.message).toContain("similar names are ExecutablePlan");

  process.exitCode = undefined;
  const unknown = await invoke(["--output", "json", "contract", "schema", "NoSuchContract"]);
  expect(unknown.exit).toBe(4);
  expect((JSON.parse(unknown.stdout) as Document).error?.code).toBe("NOT_FOUND");
});
