import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Command } from "commander";
import { type Runtime, required, string, strings } from "./runtime.js";

export function usageCommands(program: Command, runtime: Runtime): void {
  runtime.bind(
    program
      .command("usage")
      .option("--run <id>")
      .option("--model <name>")
      .option("--since <timestamp>")
      .option("--until <timestamp>")
      .option("--out <path>"),
    async (rt, _args, options) => {
      const projectId = string(options, "project") ?? process.env.TESTMASTER_PROJECT_ID;
      const data = (await rt.app()).usage.get({
        ...(projectId ? { projectId } : {}),
        ...(string(options, "run") ? { runId: string(options, "run")! } : {}),
        ...(string(options, "model") ? { model: string(options, "model")! } : {}),
        ...(string(options, "since") ? { since: string(options, "since")! } : {}),
        ...(string(options, "until") ? { until: string(options, "until")! } : {}),
      });
      const out = string(options, "out");
      if (out) {
        const path = rt.path(out);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
      }
      return { data };
    },
  );
  runtime.bind(
    program.command("budget").command("set").requiredOption("--tokens <count>"),
    async (rt, _args, options) => ({
      data: (await rt.app()).usage.setBudget(await rt.project(options), {
        tokens: Number(required(options, "tokens")),
      }),
    }),
  );
  const consent = program.command("consent");
  runtime.bind(
    consent
      .command("grant")
      .requiredOption("--provider <id>")
      .option("--allow-unknown-cost")
      .requiredOption("--data-class <class...>"),
    async (rt, _args, options) => {
      const app = await rt.app();
      const projectId = await rt.project(options);
      const provider = required(options, "provider");
      app.model.grantConsent(
        projectId,
        provider,
        strings(options, "dataClass"),
        options.allowUnknownCost === true,
      );
      return {
        data: { projectId, provider, consent: await app.model.consent(projectId, provider) },
      };
    },
  );
  runtime.bind(
    consent.command("revoke").requiredOption("--provider <id>"),
    async (rt, _args, options) => {
      const app = await rt.app();
      const projectId = await rt.project(options);
      const provider = required(options, "provider");
      app.model.revokeConsent(projectId, provider);
      return {
        data: { projectId, provider, consent: await app.model.consent(projectId, provider) },
      };
    },
  );
  runtime.bind(
    consent.command("status").requiredOption("--provider <id>"),
    async (rt, _args, options) => {
      const projectId = await rt.project(options);
      const provider = required(options, "provider");
      return {
        data: {
          projectId,
          provider,
          consent: await (await rt.app()).model.consent(projectId, provider),
        },
      };
    },
  );
}
