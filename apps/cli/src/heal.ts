import { ContractError } from "@testmaster/contracts";
import { exitCodeForRun } from "@testmaster/domain";
import type { Command } from "commander";
import { waitForRun } from "./execution.js";
import { integer, type Runtime, required, version } from "./runtime.js";

export function healingCommands(program: Command, runtime: Runtime): void {
  const heal = program.command("heal");
  runtime.bind(
    heal
      .command("propose <failedRunId>")
      .option("--deadline-ms <milliseconds>", "Model deadline", integer),
    async (rt, args, options) => {
      const app = await rt.app();
      const deadlineMs = typeof options.deadlineMs === "number" ? options.deadlineMs : undefined;
      return {
        data: await app.healing.propose(
          String(args[0]),
          deadlineMs ? { budget: { deadlineMs } } : {},
        ),
      };
    },
  );
  runtime.bind(heal.command("get <proposalId>"), async (rt, args) => ({
    data: (await rt.app()).healing.get(String(args[0])),
  }));
  runtime.bind(
    heal
      .command("approve <proposalId>")
      .requiredOption("--expected-version <version>", "CAS version", integer)
      .option("--wait"),
    async (rt, args, options) => {
      const app = await rt.app();
      const proposal = await app.healing.approve(String(args[0]), version(options));
      if (!proposal.verificationRunId)
        throw new ContractError("PRECONDITION_FAILED", "Approval did not admit verification");
      const run = app.runs.get(proposal.verificationRunId);
      const receipt = {
        runId: run.id,
        ownership: app.worker.live() ? ("worker" as const) : ("ephemeral" as const),
      };
      rt.receipts.push(receipt);
      if (options.wait !== true) return { data: { proposal, verification: receipt } };
      const verification = await waitForRun(rt, app, run.id, options, receipt.ownership);
      return {
        data: { proposal: await app.healing.reconcile(run.id), verification },
        exit: exitCodeForRun({ outcome: verification.outcome, gate: verification.gate }),
      };
    },
  );
  runtime.bind(
    heal.command("reject <proposalId>").requiredOption("--reason <text>"),
    async (rt, args, options) => ({
      data: (await rt.app()).healing.reject(String(args[0]), required(options, "reason")),
    }),
  );
}
