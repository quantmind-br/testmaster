import type { SelectionInput } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import { batchExitCode, exitCodeForGate, exitCodeForRun } from "@testmaster/domain";
import type { Command } from "commander";
import { environmentId, waitForRun } from "./execution.js";
import { collect, type Runtime, string, strings } from "./runtime.js";

export function selectionCommands(test: Command, runtime: Runtime): void {
  runtime.bind(
    test
      .command("rerun [ids...]")
      .option("--chain", "Resolve producer closure (default)")
      .option("--diff")
      .option("--base <ref>")
      .option("--head <ref>")
      .option("--working-tree")
      .option("--reuse-from-run <run>", "Explicit fixture producer (repeatable)", collect)
      .option("--skip-dependencies")
      .option("--preview")
      .option("--env <name>")
      .option("--allow-empty")
      .option("--empty-reason <text>")
      .option("--wait")
      .option("--expected-selection-hash <hash>"),
    async (rt, args, options) => {
      const ids = Array.isArray(args[0]) ? args[0].map(String) : [];
      const diff = options.diff === true || options.workingTree === true;
      if (diff && ids.length)
        throw new ContractError("INVALID_ARGUMENT", "Diff and explicit IDs are mutually exclusive");
      if (!diff && !ids.length)
        throw new ContractError("INVALID_ARGUMENT", "Select test/run IDs or a diff");
      if (options.diff !== true && (string(options, "base") || string(options, "head")))
        throw new ContractError("INVALID_ARGUMENT", "Base/head require --diff");
      const app = await rt.app();
      const projectId = await rt.project(options);
      const runIds = ids.filter((id) => id.startsWith("run_"));
      if (runIds.length && runIds.length !== ids.length)
        throw new ContractError("INVALID_ARGUMENT", "Test and Run IDs cannot be mixed");
      const input: SelectionInput = {
        projectId,
        environmentId: await environmentId(rt, options, projectId),
        ...(diff
          ? {
              diff:
                options.workingTree === true
                  ? { workingTree: true }
                  : {
                      ...(string(options, "base")
                        ? { base: string(options, "base") as string }
                        : {}),
                      ...(string(options, "head")
                        ? { head: string(options, "head") as string }
                        : {}),
                    },
            }
          : runIds.length
            ? { runIds }
            : { testIds: ids }),
        reuseFromRunIds: strings(options, "reuseFromRun"),
        skipDependencies: options.skipDependencies === true,
        allowEmpty: options.allowEmpty === true,
        ...(string(options, "emptyReason")
          ? { emptyReason: string(options, "emptyReason") as string }
          : {}),
        ...(string(options, "expectedSelectionHash")
          ? { expectedSelectionHash: string(options, "expectedSelectionHash") as string }
          : {}),
      };
      if (options.preview === true) return { data: await app.selection.preview(input) };
      const receipt = await app.selection.run(input, { wait: options.wait === true });
      rt.receipts.push(receipt);
      if (options.wait !== true) return { data: receipt };
      const owned = receipt.allMembers.filter((id) => {
        const run = app.runs.get(id);
        return (run.gatePolicy as Record<string, unknown>).ownership === "ephemeral";
      });
      const controller = new AbortController();
      const interrupt = () => controller.abort(rt.controller.signal.reason);
      rt.controller.signal.addEventListener("abort", interrupt, { once: true });
      if (rt.controller.signal.aborted) interrupt();
      const worker = owned.length
        ? app.worker.run({ ephemeral: true, runIds: owned, signal: controller.signal })
        : Promise.resolve();
      let workerError: unknown;
      const finished = worker.catch((error: unknown) => {
        workerError = error;
      });
      const workerFailure = worker.then(
        () => new Promise<never>(() => {}),
        (error: unknown): never => {
          throw error;
        },
      );
      void workerFailure.catch(() => {});
      try {
        await Promise.all(
          receipt.allMembers.map((id) =>
            waitForRun(rt, app, id, {
              ...options,
              workerFailure,
              cancelOnInterrupt: owned.includes(id),
            }),
          ),
        );
        await finished;
        if (workerError) throw workerError;
        const batch = app.batches.get(receipt.batchId);
        const aggregate = batch.aggregate as {
          gate: "passed" | "failed" | "pending" | "not_applicable";
        };
        return {
          data: { ...batch, selectionHash: receipt.selectionHash, excluded: receipt.excluded },
          exit: batchExitCode([
            ...receipt.allMembers.map((id) => exitCodeForRun(app.runs.get(id))),
            exitCodeForGate(aggregate.gate),
          ]),
        };
      } finally {
        for (const id of owned) if (app.runs.get(id).phase !== "completed") app.runs.cancel(id);
        controller.abort();
        await finished;
        rt.controller.signal.removeEventListener("abort", interrupt);
      }
    },
  );
}
