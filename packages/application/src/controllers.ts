import { setTimeout as delay } from "node:timers/promises";
import { ContractError } from "@testmaster/contracts";
import type { Application } from "./application.js";
import {
  CONTROLLER_HEARTBEAT_MS,
  heartbeatController,
  registerController,
  stopController,
} from "./controller-instances.js";
import { acquireLease, LOOP_LEASE_MS, renewLease } from "./controller-leases.js";
import { flushApiMetrics } from "./telemetry.js";

/** How often a controller writes its API counters to `controller_metrics`. */
export const METRICS_FLUSH_MS = 60_000;

/** A background loop (scheduler, outbox dispatch, maintenance, alerts) run by `server start`. */
export interface Controller {
  readonly name: string;
  readonly intervalMs: number;
  /** Also runs in the single-user local profile; server-only loops leave this unset. */
  readonly local?: boolean;
  /**
   * Runs on one controller at a time (ADR-035): the loop holds the lease named after it, renews it
   * between ticks and while a tick runs, and a tick that loses it is aborted through `signal`. Loops
   * that act on in-memory state of their own process, and the ones whose writes are idempotent
   * claims, leave this unset and run on every controller.
   */
  readonly elected?: boolean;
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
  /**
   * Register this process in `controller_instances`, heartbeat, flush metrics and release the
   * leases on stop. The backup agent shares the database but is not a controller, so it passes false.
   */
  instance?: boolean;
  /** Term of an elected loop's lease; the default is `LOOP_LEASE_MS`, tests shorten it to see a takeover. */
  leaseMs?: number;
}

/** Waits `ms`; false when the signal ended the wait. */
async function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  try {
    await delay(ms, undefined, { signal });
    return true;
  } catch {
    return false;
  }
}

async function plainLoop(
  controller: Controller,
  scope: Application,
  options: RunControllersOptions,
): Promise<void> {
  while (!options.signal.aborted) {
    try {
      await controller.run(scope, options.signal);
    } catch (error) {
      if (options.signal.aborted) return;
      options.onError?.(controller.name, error);
    }
    if (!(await pause(controller.intervalMs, options.signal))) return;
  }
}

/**
 * One elected loop. The lease is renewed every third of its term whether or not a tick is due, so
 * the holder keeps it between hourly ticks and a survivor takes it within one term of a crash (or at
 * once after a graceful stop). The tick signal aborts when a renewal finds the lease gone, so the
 * loop stops acting immediately; it checks the signal between workspaces.
 */
async function electedLoop(
  controller: Controller,
  scope: Application,
  options: RunControllersOptions,
): Promise<void> {
  const database = scope.database;
  const holder = scope.controllerIdentity.id;
  const leaseMs = options.leaseMs ?? LOOP_LEASE_MS;
  const renewMs = Math.floor(leaseMs / 3);
  let fence: number | null = null;
  let due = true;
  let nextRunAt = 0;
  while (!options.signal.aborted) {
    try {
      const now = Date.now();
      if (fence !== null && !renewLease(database, controller.name, holder, fence, leaseMs))
        fence = null;
      if (fence === null) {
        fence = acquireLease(database, controller.name, holder, leaseMs)?.fence ?? null;
        if (fence !== null) due = true;
      }
      if (fence !== null && due) {
        nextRunAt = now + controller.intervalMs;
        const held = fence;
        const lost = new AbortController();
        const keepAlive = setInterval(() => {
          try {
            if (!renewLease(database, controller.name, holder, held, leaseMs)) lost.abort();
          } catch (error) {
            options.onError?.(controller.name, error);
          }
        }, renewMs);
        try {
          await controller.run(scope, AbortSignal.any([options.signal, lost.signal]));
        } finally {
          clearInterval(keepAlive);
          if (lost.signal.aborted) fence = null;
        }
      }
    } catch (error) {
      if (options.signal.aborted) return;
      options.onError?.(controller.name, error);
    }
    const remaining = Math.max(0, nextRunAt - Date.now());
    const wait = fence === null ? renewMs : Math.min(remaining, renewMs);
    due = fence !== null && wait === remaining;
    if (!(await pause(wait, options.signal))) return;
  }
}

/** Keeps this process's row in `controller_instances` fresh; a pruned or stopped row is registered again. */
async function heartbeatLoop(scope: Application, options: RunControllersOptions): Promise<void> {
  while (await pause(CONTROLLER_HEARTBEAT_MS, options.signal)) {
    try {
      if (!heartbeatController(scope.database, scope.controllerIdentity.id))
        registerController(scope.database, scope.controllerIdentity);
    } catch (error) {
      options.onError?.("controller-heartbeat", error);
    }
  }
}

async function metricsLoop(scope: Application, options: RunControllersOptions): Promise<void> {
  while (await pause(METRICS_FLUSH_MS, options.signal)) {
    try {
      flushApiMetrics(scope.database, scope.controllerIdentity.id, scope.apiMetrics);
    } catch (error) {
      options.onError?.("controller-metrics", error);
    }
  }
}

/**
 * Runs every applicable controller until `signal` aborts; one failing loop never stops the rest. A
 * server process also registers itself, heartbeats and flushes its counters, and on stop flushes a
 * last time, releases the leases it holds and marks itself stopped so a survivor takes over at once.
 */
export async function runControllers(
  application: Application,
  registry: ControllerRegistry,
  options: RunControllersOptions,
): Promise<void> {
  const scope = application.controllerScope();
  const instance = options.instance !== false;
  if (instance) registerController(scope.database, scope.controllerIdentity);
  const loops = registry
    .list(options.profile)
    .map((controller) =>
      controller.elected
        ? electedLoop(controller, scope, options)
        : plainLoop(controller, scope, options),
    );
  if (instance) loops.push(heartbeatLoop(scope, options), metricsLoop(scope, options));
  try {
    await Promise.all(loops);
  } finally {
    if (instance) {
      try {
        flushApiMetrics(scope.database, scope.controllerIdentity.id, scope.apiMetrics);
      } catch (error) {
        options.onError?.("controller-metrics", error);
      }
      try {
        stopController(scope.database, scope.controllerIdentity.id);
      } catch (error) {
        options.onError?.("controller-stop", error);
      }
    }
  }
}
