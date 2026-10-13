import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Serves the built portal (`apps/web/dist`) same-origin (ADR-018). There is no static-file
 * plugin: the build output is read once at startup into a table keyed by its relative paths, so
 * a request path can only ever select a key that exists. It cannot name a file outside the
 * build, follow a symlink, or traverse.
 */
export interface PortalFile {
  readonly body: Buffer;
  readonly type: string;
  readonly etag: string;
}

export interface PortalOptions {
  /** Directory containing `index.html`. Defaults to the sibling `apps/web/dist`. */
  readonly root?: string;
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export const portalSecurityHeaders: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export function defaultPortalRoot(): string {
  return fileURLToPath(new URL("../../web/dist", import.meta.url));
}

function collect(root: string, directory: string, files: Map<string, PortalFile>): void {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
    // Symlinks and special files are never served.
    if (entry.isDirectory()) collect(root, relative, files);
    else if (entry.isFile()) {
      const body = readFileSync(join(root, relative));
      files.set(`/${relative}`, {
        body,
        type: contentTypes[extname(entry.name).toLowerCase()] ?? "application/octet-stream",
        etag: `"${createHash("sha256").update(body).digest("hex")}"`,
      });
    }
  }
}

/** `null` when the portal has not been built; the server then serves the API only. */
export function loadPortal(options: PortalOptions = {}): Map<string, PortalFile> | null {
  const root = options.root ?? defaultPortalRoot();
  try {
    if (!statSync(join(root, "index.html")).isFile()) return null;
  } catch {
    return null;
  }
  const files = new Map<string, PortalFile>();
  collect(root, "", files);
  return files;
}

/** Portal requests are anonymous static GETs: the SPA authenticates through `/v1`. */
export function isPortalRequest(method: string, url: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const path = url.split("?", 1)[0] ?? "";
  return !/^\/(?:v1|mcp)(?:\/|$)/.test(path);
}

function send(reply: FastifyReply, request: FastifyRequest, file: PortalFile, cache: string) {
  for (const [name, value] of Object.entries(portalSecurityHeaders)) reply.header(name, value);
  reply.header("Cache-Control", cache).header("ETag", file.etag).type(file.type);
  if (request.headers["if-none-match"] === file.etag) return reply.code(304).send();
  return reply.send(file.body);
}

export function registerPortal(app: FastifyInstance, files: Map<string, PortalFile>): void {
  const index = files.get("/index.html");
  if (!index) throw new Error("Portal build is missing index.html");
  app.get("/*", (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? "/";
    if (!isPortalRequest(request.method, request.url)) return reply.callNotFound();
    if (path.startsWith("/assets/")) {
      const asset = files.get(path);
      // A missing script or stylesheet must never be answered with HTML.
      if (!asset) return reply.callNotFound();
      return send(reply, request, asset, "public, max-age=31536000, immutable");
    }
    const exact = path === "/index.html" ? undefined : files.get(path);
    if (exact) return send(reply, request, exact, "no-cache");
    // Client-side routes: always the shell, never cached, so a deploy is picked up at once.
    return send(reply, request, index, "no-store");
  });
}
