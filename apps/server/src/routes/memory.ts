import type { MemoryEntryInput, MemoryEntryPatchInput } from "@testmaster/contracts";
import { ContractError } from "@testmaster/contracts";
import type { RouteContext, RouteModule } from "./types.js";

const id = (context: RouteContext): string => context.params.id as string;
/** Approved project memory (ADR-034): reviewed facts that reach prompts as data, per project. */
export const memoryRoutes: RouteModule = {
  handlers: {
    "GET /projects/{id}/memory": (context) =>
      context.page(context.service.memory.list(id(context))),
    "POST /projects/{id}/memory": (context) =>
      context.service.memory.create(id(context), context.body as MemoryEntryInput),
    // `approve: true` is a decision on the entry as it stands; any other field is an edit.
    "PATCH /memory/{id}": (context) => {
      const { approve, reason, ...edit } = context.body as MemoryEntryPatchInput;
      if (!approve) {
        if (reason !== undefined)
          throw new ContractError("INVALID_ARGUMENT", "A reason accompanies an approval only", {
            field: "reason",
          });
        return context.service.memory.update(id(context), edit);
      }
      if (Object.keys(edit).length > 1)
        throw new ContractError("INVALID_ARGUMENT", "An approval cannot be combined with an edit", {
          field: "approve",
        });
      return context.service.memory.approve(id(context), {
        expectedVersion: edit.expectedVersion,
        ...(reason !== undefined ? { reason } : {}),
      });
    },
    "DELETE /memory/{id}": (context) => context.service.memory.forget(id(context)),
  },
  synchronous: ["POST /projects/{id}/memory", "PATCH /memory/{id}", "DELETE /memory/{id}"],
};
