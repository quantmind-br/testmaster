import type { Command } from "commander";
import type { Runtime } from "./runtime.js";

export function databaseCommands(program: Command, runtime: Runtime): void {
  const group = program.command("db");
  runtime.bind(group.command("status"), async (rt) => {
    const app = await rt.app();
    app.context.authorize("R");
    return { data: app.database.status() };
  });
  runtime.bind(group.command("migrate"), async (rt) => {
    const app = await rt.app();
    app.context.authorize("A");
    await app.database.migrate();
    return { data: app.database.status() };
  });
}
