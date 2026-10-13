import { Readable } from "node:stream";
import { type ArtifactStream, resolveArtifactLink } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import type { RouteModule } from "./types.js";

/** Same restrictions as `GET /artifacts/{id}` except the portal may frame the response itself. */
export const gatewayCsp =
  "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export const artifactGatewayRoutes: RouteModule = {
  handlers: {
    // Signature route: no bearer or cookie. The link names the credential that minted it, and
    // authorization, tombstone and expiry are re-evaluated on every request.
    "GET /artifacts/{id}/content": async ({ service, params, query, request, reply }) => {
      const artifactId = params.id ?? "";
      const link = resolveArtifactLink(service, artifactId, query.link);
      const app = service.forIdentity(link.identity);
      const header = request.headers.range;
      const range = header ? /^bytes=(\d+)-(\d+)$/.exec(header) : null;
      if (header && !range)
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Only a single explicit byte range is supported",
        );
      const artifact: ArtifactStream = await app.artifacts.stream(
        artifactId,
        range ? { range: { start: Number(range[1]), end: Number(range[2]) } } : {},
      );
      const filename = `artifact-${artifactId.replace(/[^a-zA-Z0-9_-]/g, "_")}.bin`;
      reply
        .header("ETag", `"${artifact.entry.sha256}"`)
        .header("Accept-Ranges", "bytes")
        .header("Content-Disposition", `${link.disposition}; filename="${filename}"`)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, no-store")
        .header("Content-Security-Policy", gatewayCsp)
        .type(artifact.entry.mimeType);
      if (header)
        reply
          .code(206)
          .header("Content-Range", `bytes ${range?.[1]}-${range?.[2]}/${artifact.entry.sizeBytes}`);
      return reply.send(Readable.from(artifact.stream));
    },
    "POST /artifacts/{id}/links": ({ service, params, body }) =>
      service.artifactLinks.issue(
        params.id ?? "",
        (body as { disposition?: "inline" | "attachment" } | null)?.disposition ?? "inline",
      ),
  },
};
