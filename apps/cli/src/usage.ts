import type { Command } from "commander";
import { type Runtime, required, string, strings } from "./runtime.js";

export function usageCommands(program: Command, runtime: Runtime): void {
  runtime.bind(
    program.command("usage").option("--since <timestamp>"),
    async (rt, _args, options) => ({
      data: await (await rt.app()).usage.get(
        string(options, "project") ?? process.env.TESTMASTER_PROJECT_ID,
        string(options, "since"),
      ),
    }),
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
