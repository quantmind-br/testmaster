import { expect, it } from "vitest";
import { executionEnvironment, parseActionInputs } from "./inputs.js";

const base: NodeJS.ProcessEnv = {
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_SHA: "a".repeat(40),
  "INPUT_RUNTIME-MANIFEST": `/private/manifest.json#${"b".repeat(64)}`,
  INPUT_ENVIRONMENT: "ci",
  INPUT_ALL: "true",
};
it("rejects shell injection IDs, credential URLs, wrong SHA, unknown inputs and floating manifests", () => {
  for (const changes of [
    { "INPUT_TEST-IDS": '["; curl attacker"]' },
    { "INPUT_TARGET-URL": "http://user:pass@localhost" },
    { "INPUT_CHECKOUT-SHA": "b".repeat(40) },
    { INPUT_COMMAND: "rm -rf /" },
    { "INPUT_RUNTIME-MANIFEST": "manifest.json" },
    { "INPUT_ALLOW-EMPTY": "true" },
  ])
    expect(() => parseActionInputs({ ...base, ...changes })).toThrow();
  expect(parseActionInputs(base)).toMatchObject({
    all: true,
    commitSha: "a".repeat(40),
    quarantinePolicy: "exclude",
  });
});
it("strips provider, Github, node loader and Git configuration secrets from real child environment", () => {
  const env = executionEnvironment({
    ...base,
    PATH: "/bin",
    HOME: "/home/test",
    GITHUB_TOKEN: "github-secret",
    QUANTFORGE_API_KEY: "provider-secret",
    NODE_OPTIONS: "--require malicious",
    GIT_CONFIG_COUNT: "1",
    TESTMASTER_DATA_DIR: "/private/data",
  });
  expect(env).toEqual({
    PATH: "/bin",
    HOME: "/home/test",
    TESTMASTER_DATA_DIR: "/private/data",
    CI: "true",
    TESTMASTER_OFFLINE: "true",
    TESTMASTER_NO_TELEMETRY: "true",
  });
  expect(Object.values(env)).not.toContain("provider-secret");
  expect(Object.values(env)).not.toContain("github-secret");
});
