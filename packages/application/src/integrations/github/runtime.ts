import { lookup } from "node:dns/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Resolver } from "@testmaster/sandbox";
import { GithubApi } from "./api.js";

export interface GithubRuntimeOptions {
  /** GitHub REST origin; GitHub Enterprise Server deployments and the local fake override it. */
  apiBaseUrl?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Resolves a preview hostname for the egress check; defaults to the system resolver. */
  resolveHost?: Resolver;
  random?: () => number;
}
/** Process-wide GitHub state shared by every scoped `Application`: API client, token cache and clocks. */
export class GithubRuntime {
  readonly api: GithubApi;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly resolveHost: Resolver;
  readonly random: () => number;
  /** Pulls whose ephemeral worker is already running in this process. */
  readonly driving = new Set<string>();
  constructor(options: GithubRuntimeOptions = {}) {
    const clock = options.now ?? Date.now;
    this.api = new GithubApi({
      now: clock,
      ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
    });
    this.now = () => new Date(clock());
    this.sleep = options.sleep ?? ((ms) => delay(ms));
    this.random = options.random ?? Math.random;
    this.resolveHost =
      options.resolveHost ??
      (async (hostname) => (await lookup(hostname, { all: true })).map((entry) => entry.address));
  }
}
