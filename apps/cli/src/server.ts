import { issueLocalToken } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import { createServer } from "@testmaster/server";
import { type Command, Option } from "commander";
import { collect, integer, type Runtime, string, strings } from "./runtime.js";

export function serverCommands(program: Command, runtime: Runtime): void {
  runtime.bind(
    program
      .command("server")
      .command("start")
      .option("--host <host>", "Loopback bind address", "127.0.0.1")
      .option("--port <port>", "HTTP port", integer, 7331)
      .addOption(
        new Option("--mode <mode>", "Deployment mode")
          .choices(["local", "server"])
          .default("local"),
      )
      .option("--origin <origin>", "Allowed browser Origin (repeatable)", collect, [])
      .option("--token-file <path>", "Private capability token file")
      .option("--print-token", "Explicitly emit the capability token"),
    async (rt, _args, options) => {
      if (options.mode === "server")
        throw new ContractError("CAPABILITY_UNAVAILABLE", "Multi-user server requires M4", {
          capability: "server-mode",
          milestone: "M4",
        });
      const host = string(options, "host") ?? "127.0.0.1";
      if (host !== "127.0.0.1")
        throw new ContractError("POLICY_DENIED", "Local server binds 127.0.0.1 only");
      const application = await rt.app();
      const tokenPath = string(options, "tokenFile");
      const token = await issueLocalToken(
        application,
        tokenPath ? { tokenPath: rt.path(tokenPath) } : {},
      );
      const app = createServer({ application, host, origins: strings(options, "origin") });
      const controller = new AbortController();
      const worker = application.worker.run({ signal: controller.signal }).catch((error) => {
        controller.abort(error);
      });
      const address = await app.listen({ host, port: options.port as number });
      const receipt = {
        address,
        tokenPath: token.tokenPath,
        ...(options.printToken ? { token: token.token } : {}),
      };
      rt.emit({
        data: receipt,
        text: `Server listening at ${address}\nCapability token file: ${token.tokenPath}${options.printToken ? `\n${token.token}` : ""}`,
      });
      try {
        await new Promise<void>((resolve) => {
          if (rt.controller.signal.aborted) resolve();
          else rt.controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        controller.abort();
        await app.close();
        await worker;
      }
      return { data: receipt };
    },
  );
}
