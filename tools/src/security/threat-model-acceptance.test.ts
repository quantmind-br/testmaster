import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "@testmaster/application";
import { capabilityRegistry, requireCapability } from "@testmaster/contracts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type CodeComponents,
  checkThreatModel,
  deriveCodeComponents,
  parseThreatModel,
  requiredBoundaryClasses,
} from "./threat-model.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

let markdown = "";
let spec = "";
let components: CodeComponents;
beforeAll(async () => {
  markdown = await readFile(join(root, "docs/security/threat-model.md"), "utf8");
  spec = await readFile(join(root, "specs/07-security.md"), "utf8");
  components = await deriveCodeComponents(root);
});

/** Returns the document without the lines selected by `drop`. */
function without(drop: (line: string) => boolean): string {
  return markdown
    .split("\n")
    .filter((line) => !drop(line))
    .join("\n");
}
const check = (document: string, code: CodeComponents = components) =>
  checkThreatModel({ root, markdown: document, spec, components: code });

describe("SEC-001 versioned threat model acceptance", () => {
  it("models every boundary and every executor, transport and capability found in code with existing enforcing tests", async () => {
    expect(await check(markdown)).toEqual([]);
    const parsed = parseThreatModel(markdown);
    for (const klass of Object.keys(requiredBoundaryClasses))
      expect(parsed.boundaries.some((entry) => entry.class === klass)).toBe(true);
    for (const entry of parsed.boundaries)
      for (const field of ["asset", "control", "abuse", "residual"] as const)
        expect(entry[field].length).toBeGreaterThan(10);
    expect(components.executors).toEqual(expect.arrayContaining(["docker", "process", "attempt"]));
    expect(components.transports).toEqual(expect.arrayContaining(["cli", "mcp", "server"]));
    expect(components.capabilities.map((capability) => capability.id)).toEqual(
      expect.arrayContaining(["mcp", "unsafe-local", "tunnels", "distributed", "ci"]),
    );
    expect(parsed.coverage.get("executor:process")).toEqual(["B-06"]);
    expect(parsed.coverage.get("capability:tunnels")).toEqual(["B-16"]);
  });

  it("keeps shared-kernel and host-administrator residual risks explicit", () => {
    const parsed = parseThreatModel(markdown);
    expect(parsed.boundaries.find((entry) => entry.class === "executor")?.residual).toMatch(
      /shared kernel are not strong hostile multi-tenant isolation/,
    );
    expect(markdown).toContain("this model does not protect against a hostile host administrator");
  });

  it("fails a copy without a boundary SEC-001 names, without any of its fields or without its residual risk", async () => {
    for (const klass of Object.keys(requiredBoundaryClasses)) {
      const mutated = without((line) =>
        new RegExp(`^\\| B-\\d{2} \\| [^|]+ \\| ${klass} \\|`).test(line),
      );
      expect(mutated).not.toBe(markdown);
      expect(await check(mutated)).toEqual(
        expect.arrayContaining([`No boundary of class ${klass} required by SEC-001`]),
      );
    }
    const viewer = markdown.split("\n").find((line) => /^\| B-11 \|/.test(line)) ?? "";
    const cells = viewer.split("|");
    for (const [index, name] of [
      [5, "asset"],
      [6, "control"],
      [7, "abuse"],
      [8, "residual"],
    ] as const) {
      const blanked = [...cells];
      blanked[index] = "  ";
      const mutated = markdown.replace(viewer, blanked.join("|"));
      expect(mutated).not.toBe(markdown);
      expect(await check(mutated)).toEqual(expect.arrayContaining([`B-11: missing ${name}`]));
    }
    const noKernel = markdown.replace("rootful Docker and the shared kernel are", "Docker is");
    expect(noKernel).not.toBe(markdown);
    expect(await check(noKernel)).toEqual(
      expect.arrayContaining([
        "Executor boundary must keep the shared-kernel residual risk explicit",
      ]),
    );
  });

  it("fails a control that cites a missing test, a missing file, a non-test file or too little evidence", async () => {
    const real =
      "`packages/sandbox/src/process/executor.test.ts::requires both opt-ins and single-user authorization without launching a process`";
    expect(markdown).toContain(real);
    const missingName = markdown.replace(real, real.replace("both opt-ins", "no opt-ins at all"));
    expect(await check(missingName)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "B-06: evidence test name not found in file: packages/sandbox/src/process/executor.test.ts::requires no opt-ins at all",
        ),
      ]),
    );
    const missingFile = markdown.replace(
      real,
      real.replace("process/executor.test.ts", "process/gone.test.ts"),
    );
    expect(await check(missingFile)).toEqual(
      expect.arrayContaining([expect.stringContaining("B-06: evidence file missing")]),
    );
    const notTest = markdown.replace(
      real,
      "`packages/sandbox/src/process/executor.ts::executeUnsafeProcess`",
    );
    expect(await check(notTest)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("B-06: evidence must name a relative path/to/file.test.ts"),
      ]),
    );
    const escaping = markdown.replace(real, "`../outside.test.ts::anything`");
    expect(await check(escaping)).toEqual(
      expect.arrayContaining([expect.stringContaining("B-06: evidence file missing")]),
    );
    const sourceLines = markdown.split("\n");
    const row = sourceLines.find((line) => /^\| B-12 \|/.test(line)) ?? "";
    const single = row.slice(
      0,
      row.lastIndexOf("`packages/application/src/agent-skills/installer.test.ts::refuses stale"),
    );
    const mutated = markdown.replace(row, `${single.replace(/; $/, "")} |`);
    expect(await check(mutated)).toEqual(
      expect.arrayContaining(["B-12: enforcement evidence needs at least two path::test citation"]),
    );
  });

  it("fails an executor, transport or capability present in code but absent from the model", async () => {
    // Positive control: a code tree identical to the real one yields no findings.
    const fake = await temporary("tm-threat-model-");
    for (const name of components.transports)
      await mkdir(join(fake, "apps", name), { recursive: true });
    for (const name of ["attempt", "docker", "process"])
      await mkdir(join(fake, "packages", "sandbox", "src", name), { recursive: true }).then(() =>
        writeFile(join(fake, "packages", "sandbox", "src", name, "executor.ts"), ""),
      );
    expect(
      await check(markdown, await deriveCodeComponents(fake, Object.values(capabilityRegistry))),
    ).toEqual([]);

    // Negative controls: the same tree gains a new transport and a new executor.
    await mkdir(join(fake, "apps", "grpc"), { recursive: true });
    await mkdir(join(fake, "packages", "sandbox", "src", "podman"), { recursive: true });
    await writeFile(join(fake, "packages", "sandbox", "src", "podman", "executor.ts"), "");
    const grown = await deriveCodeComponents(fake, Object.values(capabilityRegistry));
    expect(grown.transports).toContain("grpc");
    expect(grown.executors).toContain("podman");
    expect(await check(markdown, grown)).toEqual([
      "executor:podman exists in code but is absent from the threat model",
      "transport:grpc exists in code but is absent from the threat model",
    ]);

    // A new integration/capability fails until it is modelled.
    const extra = { id: "ssh-bastion", enabled: true };
    expect(
      await check(markdown, { ...components, capabilities: [...components.capabilities, extra] }),
    ).toEqual(["capability:ssh-bastion exists in code but is absent from the threat model"]);

    // A component removed from code leaves a stale model entry.
    expect(
      await check(markdown, {
        ...components,
        capabilities: components.capabilities.filter((capability) => capability.id !== "ci"),
      }),
    ).toEqual(["capability:ci is in the threat model but not in code"]);
  });

  it("fails when code enables a boundary the model still lists as disabled, and when the model drops coverage", async () => {
    const enabledTunnel = components.capabilities.map((capability) =>
      capability.id === "tunnels" ? { ...capability, enabled: true } : capability,
    );
    expect(await check(markdown, { ...components, capabilities: enabledTunnel })).toEqual([
      "capability:tunnels is enabled in code but modelled under disabled boundary B-16",
    ]);
    const disabledMcp = components.capabilities.map((capability) =>
      capability.id === "mcp" ? { ...capability, enabled: false } : capability,
    );
    expect(await check(markdown, { ...components, capabilities: disabledMcp })).toEqual([
      "capability:mcp is disabled in code but modelled under enabled boundary B-01",
    ]);
    const unmodelled = markdown.replace(", `capability:unsafe-local`", "");
    expect(unmodelled).not.toBe(markdown);
    expect(await check(unmodelled)).toEqual([
      "capability:unsafe-local exists in code but is absent from the threat model",
    ]);
  });
});

describe("M0-03 boundary defaults", () => {
  it("raw trace, video and HTTP body capture are off by default and unsafe process execution is not granted by default", async () => {
    const base = await temporary("tm-threat-defaults-");
    const cwd = join(base, "repo");
    const home = join(base, "home");
    await mkdir(cwd, { mode: 0o700 });
    await mkdir(join(home, ".config", "testmaster"), { recursive: true, mode: 0o700 });

    const resolved = await resolveConfig({ cwd, home, env: {} });
    expect(resolved.effectiveConfig.config.artifacts).toMatchObject({
      trace: "off",
      video: "off",
      httpBodies: "off",
    });
    expect(resolved.effectiveConfig.config.execution?.executor ?? "docker").toBe("docker");
    expect(resolved.profilePolicy.security.allowUnsafeProcessExecution).toBe(false);
    expect(resolved.profilePolicy.allowedModelProviders).toEqual([]);

    // Selecting the unsafe process executor without the operator's user policy is refused...
    await expect(
      resolveConfig({ cwd, home, env: { TESTMASTER_EXECUTOR: "process" } }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    // ...and only the operator-owned user policy lifts the refusal (positive control).
    await writeFile(
      join(home, ".config", "testmaster", "policy.json"),
      JSON.stringify({ security: { allowUnsafeProcessExecution: true } }),
    );
    const granted = await resolveConfig({ cwd, home, env: { TESTMASTER_EXECUTOR: "process" } });
    expect(granted.effectiveConfig.config.execution?.executor).toBe("process");
    expect(granted.profilePolicy.security.allowUnsafeProcessExecution).toBe(true);
    // Granting process execution leaves raw capture off: the two opt-ins are independent.
    expect(granted.effectiveConfig.config.artifacts).toMatchObject({
      trace: "off",
      video: "off",
      httpBodies: "off",
    });
  });
});

describe("disabled boundaries", () => {
  it("tunnel, distributed workers, multi-user and every other M4+ capability stay disabled and refuse use", () => {
    const future = Object.values(capabilityRegistry).filter((capability) =>
      ["M4", "M5", "M6"].includes(capability.milestone),
    );
    expect(future.map((capability) => capability.id)).toEqual(
      expect.arrayContaining(["tunnels", "distributed", "multi-user", "server", "sso", "scim"]),
    );
    for (const capability of future) {
      expect(capability.enabled).toBe(false);
      expect(() => requireCapability(capability.id)).toThrowError(
        expect.objectContaining({
          code: "CAPABILITY_UNAVAILABLE",
          details: { capability: capability.id, milestone: capability.milestone },
        }),
      );
    }
    // Positive control: an implemented capability is not refused.
    expect(() => requireCapability("local-execution")).not.toThrow();
  });
});
