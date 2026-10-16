# ADR-004: Host-enforced egress and loopback bridge

- Status: accepted
- Date: 2026-10-05
- Scope: approved M0–M2 implementation plan; later profiles remain capability-gated.

## Context

Browser interception and HTTP client hooks cannot contain arbitrary Python/JS sockets or rebinding. The host proxy must be the only routable path.

## Decision

Per-attempt host egress proxy listens on egress.sock in a private runtime directory. A dumb in-container TCP-to-Unix forwarder listens at 127.0.0.1:3128. The container has network none; browser uses proxy with loopback bypass disabled, undici ProxyAgent and Python HTTP(S)_PROXY. Canonicalize HTTP(S) URLs once: reject userinfo, ambiguous IP/authority encodings, backslashes, controls and zone IDs. Resolve DNS at the proxy, classify every A/AAAA answer, reject mixed forbidden answers and pin the actual vetted address while preserving Host/SNI. Exact allowedOrigins and approved privateTargets/local-loopback host:port only. Authorize each connection and redirect hop; reject Host mismatch, arbitrary CONNECT and proxy chaining. A forwarded plain-HTTP request never carries a destination override or proxy-chaining header to the target: the proxy removes `X-Forwarded-*`, `Forwarded`, `Via` and `Proxy-*` request headers (like a reverse proxy that drops client-supplied forwarding headers), forwards the rest unchanged, and records only the removed header names on the `allow` decision. A `Connection` header naming anything but `close` or `keep-alive`, a missing or repeated `Host`, and any such header on a CONNECT request remain refusals.

An environment may list `additionalOrigins`: exact http(s) origins (no wildcard, path, query or credentials; at most 32) that page subrequests may reach in addition to the target. They join the attempt `allowedOrigins` for browser, HTTP and exploration attempts, but they are never target origins: they bind no secret or auth profile, and a stored session is never replayed toward them. Literal-IP and `localhost` entries must fit the network profile; DNS names are classified by the proxy at connect time. The proxy admits a private or loopback address for an additional origin under the same rule as the base target, never wider: only for that exact host and port, only inside the ranges the profile permits (`local-loopback`: `127.0.0.0/8` and `::1`, with `localhost` names pinned to the host loopback like the base URL; `private`: RFC 1918 and `fc00::/7`; `public`: none, so a private answer stays refused), with every DNS answer still classified, the vetted address pinned and each connection rechecked. The policy is built by `attemptEgressPolicy` (`packages/sandbox/src/attempt/egress.ts`). Offline profiles ignore them. Changing the list creates a new environment revision, so earlier approvals do not carry over.

Browser route interception aborts a request to an unapproved origin. A passive subresource (`image`, `font`, `stylesheet` or `media`, `GET`/`HEAD`, canonicalizable URL) is aborted and recorded without failing the run; every other denial (document, script, XHR/fetch, WebSocket, EventSource, manifest, popup, ambiguous URL, other method) ends the run `blocked/egress_denied`. Each denial is reported once per origin and resource type per attempt as an `egress.denied` runner event and appended to `logs/egress.ndjson` with layer `browser_route`; only the origin is recorded, never the path or query.

A page WebSocket is mapped to its HTTP origin (`ws` to `http`, `wss` to `https`) and checked against the same attempt origins: an approved socket is connected to the server through the proxy, any other is closed with code 1008 and denied as a `websocket` request.

## Consequences

Controller provider/IdP/storage traffic uses a separate policy. Do not expose host bridge addresses in plans or publish debug/worker ports. Bounded egress logs contain origin/decision/reason/pinned IP and the names (never values) of removed forwarding headers, not query/headers/body. Lease expiry/cancel immediately closes the proxy. TLS verification remains enabled; no arbitrary UDP/QUIC/WebRTC/DNS bypass. SEC-008–013, OPS-008.

## Authority

[SPEC](../../SPEC.md), [architecture](../../specs/02-architecture.md), [security](../../specs/07-security.md), [roadmap](../../ROADMAP.md). These records describe decisions, not proof that controls have already passed acceptance.
