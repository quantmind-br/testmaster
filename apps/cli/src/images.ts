import type { Command } from "commander";
import { type Runtime, required } from "./runtime.js";

export function imageCommands(program: Command, runtime: Runtime): void {
  const group = program.command("image");
  runtime.bind(
    group
      .command("revoke <image-id>")
      .description("Durably revoke a runner image ID; rollback or restore never reinstalls it")
      .requiredOption("--reason <text>"),
    async (rt, args, options) => ({
      data: (await rt.app()).revokeImage(String(args[0]), required(options, "reason")),
    }),
  );
  runtime.bind(group.command("revoked").description("List revoked image IDs"), async (rt) => ({
    data: { imageIds: (await rt.app()).revokedImages() },
  }));
}
