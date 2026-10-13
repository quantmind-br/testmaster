import { setTimeout as delay } from "node:timers/promises";
import { ContractError } from "@testmaster/contracts";
import type { Application } from "./application.js";

/** A background loop (scheduler, outbox dispatch, maintenance, alerts) run by `server start`. */
export interface Controller {
  readonly name: string;
  readonly intervalMs: number;
  /** Also runs in the single-user local profile; server-only loops leave this unset. */
  readonly local?: boolean;
  /** `scope` is the controller-scope application: it spans every workspace. */
  run(scope: Application, signal: AbortSignal): Promise<void> | void;
}
export class ControllerRegistry {
  private readonly controllers = new Map<string, Controller>();
  register(controller: Controller): void {
    if (this.controllers.has(controller.name))
      throw new ContractError("INTERNAL", `Controller already registered: ${controller.name}`);
    if (!Number.isInteger(controller.intervalMs) || controller.intervalMs < 10)
      throw new ContractError("INTERNAL", `Controller interval is invalid: ${controller.name}`);
    this.controllers.set(controller.name, controller);
  }
  list(profile: "local" | "server"): Controller[] {
    return [...this.controllers.values()].filter(
      (controller) => profile === "server" || controller.local === true,
    );
  }
}
export interface RunControllersOptions {
  profile: "local" | "server";
  signal: AbortSignal;
  /** Called after a failed tick; the loop continues with the next interval. */
  onError?: (controller: string, error: unknown) => void;
}
/** Runs every applicable controller until `signal` aborts; one failing loop never stops the rest. */
export async function runControllers(
  application: Application,
  registry: ControllerRegistry,
  options: RunControllersOptions,
): Promise<void> {
  const scope = application.controllerScope();
  await Promise.all(
    registry.list(options.profile).map(async (controller) => {
      while (!options.signal.aborted) {
        try {
          await controller.run(scope, options.signal);
        } catch (error) {
          if (options.signal.aborted) return;
          options.onError?.(controller.name, error);
        }
        try {
          await delay(controller.intervalMs, undefined, { signal: options.signal });
        } catch {
          return;
        }
      }
    }),
  );
}
