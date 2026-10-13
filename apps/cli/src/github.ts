import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Application,
  authenticateBearer,
  manifestFormHtml,
} from "@testmaster/application";
import {
  ContractError,
  type GithubManifestInput,
  type GithubManifestReceipt,
  type IntegrationMetadata,
} from "@testmaster/contracts";
import type { Command } from "commander";
import { type Options, type Runtime, required, string } from "./runtime.js";

export interface GithubSetupInput {
  manifest: Omit<GithubManifestInput, "redirectUrl">;
  projectIds: string[];
  /** Loopback port for the helper page; 0 picks a free one. */
  port: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called once the helper page is reachable, before waiting for GitHub's redirect. */
  onReady(url: string): void;
}
export interface GithubSetupResult {
  integrationId: string;
  appSlug: string;
  installUrl: string;
  webhookUrl: string;
  scopes: string[];
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? "",
  );
const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
const securityHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  // The only thing this page may do is post the manifest to GitHub.
  "content-security-policy":
    "default-src 'none'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'",
};
function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function send(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, securityHeaders);
  response.end(html);
}

/**
 * GitHub manifest flow for the operator's terminal. A loopback page shows what will be created and
 * posts the manifest to GitHub only on a click; GitHub then redirects the browser back with a
 * one-time code, which is exchanged and stored as TestMaster secrets bound to the GitHub API origin.
 */
export async function runGithubSetup(
  app: Application,
  input: GithubSetupInput,
): Promise<GithubSetupResult> {
  let origin = "";
  let receipt: GithubManifestReceipt | undefined;
  const { promise: done, resolve: finish, reject: fail } = Promise.withResolvers<GithubSetupResult>();
  let converting = false;
  const loopbackHosts = (port: number) => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const port = (server.address() as AddressInfo).port;
    // A rebinding page on another hostname must not be able to read the manifest or trigger the exchange.
    if (!loopbackHosts(port).has(request.headers.host ?? "")) {
      send(response, 421, page("Misdirected request", "<p>Use the printed 127.0.0.1 address.</p>"));
      return;
    }
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/" && receipt) {
      send(response, 200, manifestFormHtml(receipt.createUrl, receipt.manifest as Record<string, unknown>));
      return;
    }
    if (request.method === "GET" && url.pathname === "/callback" && receipt) {
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code") ?? "";
      if (!sameSecret(state, receipt.state) || converting) {
        send(response, 400, page("Request refused", "<p>The state does not match this setup.</p>"));
        return;
      }
      converting = true;
      try {
        const integration: IntegrationMetadata = await app.github.convertManifest(state, {
          code,
          projectIds: input.projectIds,
        });
        const installUrl = `https://github.com/apps/${encodeURIComponent(integration.name)}/installations/new`;
        send(
          response,
          200,
          page(
            "GitHub App created",
            `<p>Credentials were stored as TestMaster secrets. Install the App on the repositories to test: <a href="${escapeHtml(installUrl)}" rel="noreferrer">${escapeHtml(installUrl)}</a></p><p>You can close this tab and return to the terminal.</p>`,
          ),
        );
        finish({
          integrationId: integration.id,
          appSlug: integration.name,
          installUrl,
          webhookUrl: `${new URL(input.manifest.publicOrigin).origin}/v1/integrations/github/webhooks`,
          scopes: [...integration.consent.scopes],
        });
      } catch (error) {
        send(response, 502, page("GitHub App was not created", "<p>See the terminal for the reason.</p>"));
        fail(error);
      }
      return;
    }
    send(response, 404, page("Not found", ""));
  };
  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      send(response, 500, page("Setup failed", ""));
      fail(error);
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(input.port, "127.0.0.1", listening.resolve);
  await listening.promise;
  const timer = setTimeout(
    () =>
      fail(
        new ContractError("UNAVAILABLE", "GitHub App setup timed out before GitHub redirected back", {
          reasonCode: "manifest_expired",
        }),
      ),
    input.timeoutMs,
  );
  const abort = () => fail(new ContractError("UNAVAILABLE", "GitHub App setup was interrupted"));
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    receipt = app.github.manifest({ ...input.manifest, redirectUrl: `${origin}/callback` });
    input.onReady(`${origin}/`);
    return await done;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    server.closeAllConnections();
    await closed.promise;
  }
}

async function actingApplication(runtime: Runtime, options: Options): Promise<Application> {
  if (options.mode !== "server") return runtime.app();
  const variable = required(options, "tokenEnv");
  const token = process.env[variable];
  if (!token)
    throw new ContractError("INVALID_ARGUMENT", "The token environment variable is not set");
  const { application } = await runtime.serverApp();
  return application.forIdentity(authenticateBearer(application, token));
}

export function githubCommands(program: Command, runtime: Runtime): void {
  const integrations =
    program.commands.find((command) => command.name() === "integrations") ??
    program.command("integrations");
  const group = integrations.command("github");
  runtime.bind(
    group
      .command("setup")
      .description("Create the GitHub App with the manifest flow and store its credentials")
      .requiredOption("--public-origin <url>", "HTTPS origin where GitHub reaches this deployment")
      .option("--name <name>", "GitHub App name", "TestMaster")
      .option("--organization <login>", "Create the App under this GitHub organization")
      .option("--allow-agent-pull-requests", "Request contents: write for agent pull requests")
      .option("--port <port>", "Loopback port for the helper page", "0")
      .option("--timeout <seconds>", "Seconds to wait for GitHub's redirect", "900")
      .option("--mode <mode>", "local (default) or server")
      .option("--token-env <variable>", "Environment variable holding an administrator token (server mode)"),
    async (rt, _args, options) => {
      const app = await actingApplication(rt, options);
      const explicitProject = string(options, "project");
      if (options.mode === "server" && !explicitProject) required(options, "project");
      const organization = string(options, "organization");
      const result = await runGithubSetup(app, {
        manifest: {
          name: string(options, "name") ?? "TestMaster",
          publicOrigin: required(options, "publicOrigin"),
          ...(options.allowAgentPullRequests === true ? { allowAgentPullRequests: true } : {}),
          ...(organization ? { organization } : {}),
        },
        projectIds: [explicitProject ?? (await rt.project())],
        port: Number(string(options, "port") ?? 0),
        timeoutMs: Number(string(options, "timeout") ?? 900) * 1000,
        signal: rt.controller.signal,
        onReady: (url) =>
          rt.stderr.write(
            `Open ${url} in a browser, click "Create GitHub App", then confirm on GitHub.\n`,
          ),
      });
      return {
        data: result,
        text: `GitHub App ${result.appSlug} created (integration ${result.integrationId}).\nInstall it on a test repository: ${result.installUrl}\nWebhook URL: ${result.webhookUrl}\n`,
      };
    },
    (rt, _args, options) => {
      required(options, "publicOrigin");
      if (options.mode === "server") required(options, "tokenEnv");
      return { data: null };
    },
  );
}
