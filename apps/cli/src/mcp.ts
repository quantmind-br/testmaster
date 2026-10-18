import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Application, authenticateBearer } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import { createMcpServer } from "@testmaster/mcp";
import { createServer } from "@testmaster/server";
import type { Command } from "commander";
import { collect, type Runtime, string } from "./runtime.js";

export function mcpCommands(program: Command, runtime: Runtime): void {
  program
    .command("mcp")
    .command("serve")
    .option("--transport <transport>", "stdio or http", "stdio")
    .option("--root <path>", "Approved filesystem root (repeatable)", collect, [])
    .option("--token-file <path>", "Private local capability token file")
    .option("--port <port>", "Loopback HTTP port", "8080")
    .action(async (_options, command: Command) => {
      const options = command.optsWithGlobals();
      // `--dry-run` answers with its receipt before the server authenticates or opens anything.
      if (await runtime.startCommand(command, [])) return;
      runtime.options = options;
      runtime.emitted = true;
      const app = await Application.open({
        ...(string(options, "cwd") ? { cwd: resolve(String(options.cwd)) } : {}),
        ...(string(options, "config") ? { configPath: String(options.config) } : {}),
        ...(string(options, "profile") ? { profile: String(options.profile) } : {}),
      });
      try {
        let token = process.env.TESTMASTER_TOKEN ?? process.env.TESTMASTER_MCP_TOKEN;
        if (!token) {
          const path =
            string(options, "tokenFile") ??
            join(app.config.home, ".local", "share", "testmaster", "server.token");
          let file: FileHandle;
          try {
            file = await open(
              path,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string")
              throw error;
            throw new ContractError(
              "UNAUTHENTICATED",
              `Token file ${path} is missing or unreadable (${error.code}); create one with \`testmaster token issue --token-file ${path}\`, or set TESTMASTER_TOKEN`,
              { tokenFile: path, errno: error.code },
            );
          }
          try {
            const stat = await file.stat();
            if (
              !stat.isFile() ||
              stat.nlink !== 1 ||
              (stat.mode & 0o777) !== 0o600 ||
              stat.uid !== process.getuid?.() ||
              stat.size > 256
            )
              throw new ContractError("POLICY_DENIED", "Token file must be a private regular file");
            token = (await file.readFile("utf8")).trim();
          } finally {
            await file.close();
          }
        }
        const identity = authenticateBearer(app, token);
        const roots = (options.root as string[]).length
          ? (options.root as string[]).map((path) => resolve(app.config.cwd, path))
          : [app.config.cwd];
        if (options.transport === "stdio") {
          const authenticatedToken = token;
          const mcp = createMcpServer({
            application: app.forIdentity(identity),
            roots,
            authenticate: () => {
              authenticateBearer(app, authenticatedToken);
            },
          });
          // stdin ending means the client is gone: answer what is in flight, then close and exit 0.
          const stdinEnded = new Promise<void>((ended) => process.stdin.once("end", ended));
          await mcp.confined(app.config.cwd);
          await mcp.connectStdio();
          await new Promise<void>((done) => {
            mcp.server.onclose = done;
            void stdinEnded.then(() => mcp.drain()).then(done);
            runtime.controller.signal.addEventListener("abort", () => done(), { once: true });
          });
          await mcp.close();
        } else if (options.transport === "http") {
          const server = await createServer({ application: app, origins: [], mcpRoots: roots });
          const port = Number(options.port);
          if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
            throw new ContractError("INVALID_ARGUMENT", "Invalid port");
          await server.listen({ host: "127.0.0.1", port });
          runtime.stderr.write(`MCP listening on http://127.0.0.1:${port}/mcp\n`);
          await new Promise<void>((done) =>
            runtime.controller.signal.addEventListener("abort", () => done(), { once: true }),
          );
          await server.close();
        } else throw new ContractError("INVALID_ARGUMENT", "Transport must be stdio or http");
      } catch (error) {
        const listed =
          error instanceof ContractError
            ? (["approvedRoots", "clientRoots"] as const).flatMap((key) => {
                const roots = error.details[key];
                return Array.isArray(roots) ? [`${key}: ${roots.join(", ")}`] : [];
              })
            : [];
        runtime.stderr.write(
          `${error instanceof ContractError ? error.code : "UNAUTHENTICATED"}: ${error instanceof ContractError ? error.message : "MCP transport startup failed"}${listed.length ? ` (${listed.join("; ")})` : ""}\n`,
        );
        process.exitCode = error instanceof ContractError && error.code === "FORBIDDEN" ? 9 : 2;
      } finally {
        app.close();
      }
    });
}
