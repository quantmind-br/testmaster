"""Browser egress policy of the pytest fixtures (SEC-011).

The same decisions the declarative browser runner and the `@playwright/test` shim take: an ignored
origin (any resource type or method) is aborted and recorded; a passive GET/HEAD subresource of an
unapproved origin is aborted and recorded; every other unapproved request is aborted and recorded as
fatal, which ends the run `blocked/egress_denied`. An ambiguous URL (a non-canonical IPv4 host
such as `127.1` or `0x7f.1` included) is never allowed, ignored or aborted (SEC-008). Requests of
the `requests` session and of a context the test creates itself are held by the egress proxy alone.
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit

PASSIVE_RESOURCE_TYPES = frozenset({"image", "font", "stylesheet", "media"})
PASSIVE_METHODS = frozenset({"GET", "HEAD"})
# Distinct origin and resource-type pairs recorded per attempt, like the other runners.
MAX_DENIALS = 64
_CONTROL = re.compile(r"[\x00-\x20\x7f\\]")
_AUTHORITY = re.compile(r"^(?:[a-z][a-z0-9+.-]*:)?//([^/?#]*)", re.IGNORECASE)
_DEFAULT_PORTS = {"http": 80, "https": 443}
_DECIMAL = re.compile(r"^[0-9]+$")
_HEX_NUMBER = re.compile(r"^0[xX][0-9a-fA-F]*$")
_DOTTED_QUAD = re.compile(r"^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$")


def _idna_host(host: str) -> str:
    # The WHATWG parser maps full-width digits and the ideographic full stop before it reads a number; the stdlib codec does the same.
    try:
        return host.encode("idna").decode("ascii")
    except UnicodeError:
        return host


def _is_number_label(label: str) -> bool:
    return bool(_DECIMAL.match(label) or _HEX_NUMBER.match(label))


def _canonical_dotted_quad(host: str) -> bool:
    return bool(_DOTTED_QUAD.match(host)) and all(int(part) <= 255 for part in host.split("."))


def canonical_origin(url: str) -> str | None:
    """Scheme, host and port of `url`, or None when the URL is ambiguous or not a plain http(s) one."""
    # A fragment never reaches the server.
    text = url.split("#", 1)[0]
    if len(text) > 8192 or _CONTROL.search(text):
        return None
    match = _AUTHORITY.match(text)
    if match and ("%" in match.group(1) or "@" in match.group(1)):
        return None
    try:
        parts = urlsplit(text)
        host = parts.hostname
        port = parts.port
    except ValueError:
        return None
    if parts.scheme not in _DEFAULT_PORTS or parts.username or parts.password or not host:
        return None
    if host.endswith("."):
        host = host[:-1]
    if not host or host.endswith("."):
        return None
    if ":" not in host and _is_number_label(_idna_host(host).rsplit(".", 1)[-1]) and not _canonical_dotted_quad(host):
        return None
    shown = f"[{host}]" if ":" in host else host
    return f"{parts.scheme}://{shown}" + ("" if port in (None, _DEFAULT_PORTS[parts.scheme]) else f":{port}")


def websocket_request_url(url: str) -> str:
    """`ws` maps to `http` and `wss` to `https`; any other scheme is returned unchanged (never authorized)."""
    lowered = url[:6].lower()
    if lowered.startswith("ws:"):
        return "http:" + url[3:]
    if lowered.startswith("wss:"):
        return "https:" + url[4:]
    return url


def denied_origin(url: str) -> str:
    """The origin recorded for a denial; never a path, query, fragment or credentials."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return "unparsable"
    if parts.scheme not in ("http", "https"):
        return f"{parts.scheme}:" if parts.scheme else "unparsable"
    try:
        port = parts.port
        host = parts.hostname or ""
    except ValueError:
        return "unparsable"
    shown = f"[{host}]" if ":" in host else host
    return (f"{parts.scheme}://{shown}" + ("" if port is None else f":{port}"))[:200]


class EgressPolicy:
    """The attempt's allowlist and the environment's ignore list, as canonical origins."""

    def __init__(self, allowed: list[str], ignored: list[str]) -> None:
        self.allowed = {origin for entry in allowed if (origin := canonical_origin(entry))}
        self.ignored = {origin for entry in ignored if (origin := canonical_origin(entry))}
        self._entries: dict[tuple[str, str], dict[str, Any]] = {}
        self.omitted = 0
        self._omitted_fatal = False

    @classmethod
    def from_input(cls, data: dict[str, Any]) -> "EgressPolicy | None":
        policy = data.get("networkPolicy")
        if not isinstance(policy, dict) or not isinstance(policy.get("allowedOrigins"), list):
            return None
        ignored = policy.get("ignoredOrigins")
        return cls([str(item) for item in policy["allowedOrigins"]], [str(item) for item in ignored] if isinstance(ignored, list) else [])

    def decide(self, url: str, method: str, resource_type: str) -> str:
        """`allowed`, `ignored`, `aborted` or `fatal`."""
        origin = canonical_origin(url)
        if origin is None:
            return "fatal"
        if origin in self.ignored:
            return "ignored"
        if origin in self.allowed:
            return "allowed"
        if resource_type in PASSIVE_RESOURCE_TYPES and method.upper() in PASSIVE_METHODS:
            return "aborted"
        return "fatal"

    def record(self, url: str, method: str, resource_type: str, disposition: str) -> None:
        origin = denied_origin(url)
        key = (origin, resource_type)
        known = self._entries.get(key)
        if known:
            known["count"] += 1
            if disposition == "fatal":
                known["disposition"] = "fatal"
            return
        if len(self._entries) >= MAX_DENIALS:
            self.omitted += 1
            if disposition == "fatal":
                self._omitted_fatal = True
            return
        self._entries[key] = {
            "origin": origin,
            "method": method.upper()[:200],
            "resourceType": (resource_type or "other")[:200],
            "disposition": disposition,
            "count": 1,
        }

    def denials(self) -> list[dict[str, Any]]:
        return list(self._entries.values())

    @property
    def fatal(self) -> bool:
        return self._omitted_fatal or any(entry["disposition"] == "fatal" for entry in self._entries.values())

    def sync_route_handler(self) -> Any:
        def handle(route: Any) -> None:
            request = route.request
            disposition = self.decide(request.url, request.method, request.resource_type)
            if disposition == "allowed":
                try:
                    route.continue_()
                except Exception:  # The page or context closed mid-request.
                    pass
                return
            self.record(request.url, request.method, request.resource_type, disposition)
            try:
                route.abort("blockedbyclient")
            except Exception:
                pass

        return handle

    def async_route_handler(self) -> Any:
        async def handle(route: Any) -> None:
            request = route.request
            disposition = self.decide(request.url, request.method, request.resource_type)
            if disposition == "allowed":
                try:
                    await route.continue_()
                except Exception:  # The page or context closed mid-request.
                    pass
                return
            self.record(request.url, request.method, request.resource_type, disposition)
            try:
                await route.abort("blockedbyclient")
            except Exception:
                pass

        return handle

    def sync_websocket_handler(self) -> Any:
        def handle(socket: Any) -> None:
            url = websocket_request_url(socket.url)
            disposition = self.decide(url, "GET", "websocket")
            if disposition == "allowed":
                try:
                    socket.connect_to_server()
                except Exception:
                    socket.close(code=1011, reason="WebSocket could not be connected")
                return
            self.record(url, "GET", "websocket", disposition)
            socket.close(code=1008, reason="WebSocket origin is not authorized")

        return handle

    def async_websocket_handler(self) -> Any:
        async def handle(socket: Any) -> None:
            url = websocket_request_url(socket.url)
            disposition = self.decide(url, "GET", "websocket")
            if disposition == "allowed":
                try:
                    socket.connect_to_server()
                except Exception:
                    await socket.close(code=1011, reason="WebSocket could not be connected")
                return
            self.record(url, "GET", "websocket", disposition)
            await socket.close(code=1008, reason="WebSocket origin is not authorized")

        return handle

    def guard_sync(self, context: Any) -> None:
        context.route("**/*", self.sync_route_handler())
        if hasattr(context, "route_web_socket"):
            context.route_web_socket("**/*", self.sync_websocket_handler())

    async def guard_async(self, context: Any) -> None:
        await context.route("**/*", self.async_route_handler())
        if hasattr(context, "route_web_socket"):
            await context.route_web_socket("**/*", self.async_websocket_handler())
