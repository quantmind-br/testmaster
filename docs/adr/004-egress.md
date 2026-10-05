# ADR-004: Host-enforced egress and loopback bridge

- Status: accepted
- Date: 2026-10-05
- Scope: approved M0–M2 implementation plan; later profiles remain capability-gated.

## Context

Browser interception and HTTP client hooks cannot contain arbitrary Python/JS sockets or rebinding. The host proxy must be the only routable path.

## Decision

Per-attempt host egress proxy listens on egress.sock in a private runtime directory. A dumb in-container TCP-to-Unix forwarder listens at 127.0.0.1:3128. The container has network none; browser uses proxy with loopback bypass disabled, undici ProxyAgent and Python HTTP(S)_PROXY. Canonicalize HTTP(S) URLs once: reject userinfo, ambiguous IP/authority encodings, backslashes, controls and zone IDs. Resolve DNS at the proxy, classify every A/AAAA answer, reject mixed forbidden answers and pin the actual vetted address while preserving Host/SNI. Exact allowedOrigins and approved privateTargets/local-loopback host:port only. Authorize each connection and redirect hop; reject Host mismatch, proxy/destination override headers, arbitrary CONNECT and proxy chaining.

## Consequences

Controller provider/IdP/storage traffic uses a separate policy. Do not expose host bridge addresses in plans or publish debug/worker ports. Bounded egress logs contain origin/decision/reason/pinned IP, not query/headers/body. Lease expiry/cancel immediately closes the proxy. TLS verification remains enabled; no arbitrary UDP/QUIC/WebRTC/DNS bypass. SEC-008–013, OPS-008.

## Authority

[SPEC](../../SPEC.md), [architecture](../../specs/02-architecture.md), [security](../../specs/07-security.md), [roadmap](../../ROADMAP.md). These records describe decisions, not proof that controls have already passed acceptance.
