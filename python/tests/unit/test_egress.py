"""The fixtures' browser egress policy decides like the Playwright runner and the `@playwright/test` shim (SEC-011)."""
import asyncio
from types import SimpleNamespace

import pytest

from testmaster_runner.egress import EgressPolicy, canonical_origin, websocket_request_url
from testmaster_runner.plugin import PythonPlugin

TARGET = "https://app.example.test"
IGNORED = "https://js.stripe.com"


def policy():
    return EgressPolicy([TARGET, "https://cdn.example.test"], [IGNORED])


@pytest.mark.parametrize(
    "url, method, kind, expected",
    [
        (f"{TARGET}/api?x=1", "POST", "xhr", "allowed"),
        (f"{TARGET}/page#section", "GET", "document", "allowed"),
        (f"{IGNORED}/v3", "GET", "script", "ignored"),
        (f"{IGNORED}/v3", "POST", "fetch", "ignored"),
        (f"{IGNORED}/frame", "GET", "document", "ignored"),
        ("https://other.example.test/a.png", "GET", "image", "aborted"),
        ("https://other.example.test/a.png", "HEAD", "media", "aborted"),
        ("https://other.example.test/a.png", "POST", "image", "fatal"),
        ("https://other.example.test/app.js", "GET", "script", "fatal"),
        ("https://other.example.test/", "GET", "document", "fatal"),
        # An ambiguous URL is never ignored, allowed or aborted (SEC-008).
        ("https://js.stripe.com%2f@evil.example.test/a.png", "GET", "image", "fatal"),
        ("https://user:pass@js.stripe.com/v3", "GET", "script", "fatal"),
        ("https://js.stripe.com\\@evil.example.test/v3", "GET", "script", "fatal"),
        ("ftp://js.stripe.com/v3", "GET", "script", "fatal"),
        # A host whose last label is a number is never read as a name, however a client resolves it.
        ("https://0x7f.1/a.png", "GET", "image", "fatal"),
        ("http://127.1/a.png", "GET", "image", "fatal"),
        ("http://2130706433/a.png", "GET", "image", "fatal"),
        ("http://0177.0.0.1/a.png", "GET", "image", "fatal"),
        ("https://example.123/a.png", "GET", "image", "fatal"),
        ("http://256.1.1.1/a.png", "GET", "image", "fatal"),
        ("http://１２７.０.０.１/a.png", "GET", "image", "fatal"),
        ("http://127。0。0。1/a.png", "GET", "image", "fatal"),
        ("http://a..1/a.png", "GET", "image", "fatal"),
        ("http://127.0.0.1/a.png", "GET", "image", "aborted"),
        ("http://[::ffff:1.2.3.4]/a.png", "GET", "image", "aborted"),
    ],
)
def test_decide(url, method, kind, expected):
    assert policy().decide(url, method, kind) == expected


def test_canonical_origin_drops_default_ports_and_keeps_others():
    assert canonical_origin("https://App.Example.test:443/x") == "https://app.example.test"
    assert canonical_origin("http://127.0.0.1:3000/x") == "http://127.0.0.1:3000"
    assert canonical_origin("http://[::1]:8080/") == "http://[::1]:8080"
    assert canonical_origin("not a url") is None


def test_canonical_origin_refuses_non_canonical_ipv4_hosts():
    for url in (
        "https://0x7f.1/a.png",
        "http://127.1/a.png",
        "http://2130706433/a.png",
        "http://0177.0.0.1/a.png",
        "https://example.123/a.png",
        "http://256.1.1.1/a.png",
        "http://１２７.０.０.１/a.png",
        "http://127。0。0。1/a.png",
        "http://a..1/a.png",
    ):
        assert canonical_origin(url) is None, url
    assert canonical_origin("http://127.0.0.1/a.png") == "http://127.0.0.1"
    assert canonical_origin("http://[::ffff:1.2.3.4]/a.png") == "http://[::ffff:1.2.3.4]"


def test_websocket_maps_to_http_origin():
    assert websocket_request_url("wss://live.example.test/s") == "https://live.example.test/s"
    assert websocket_request_url("ws://live.example.test/s") == "http://live.example.test/s"
    assert policy().decide(websocket_request_url("wss://js.stripe.com/s"), "GET", "websocket") == "ignored"
    assert policy().decide(websocket_request_url("wss://other.example.test/s"), "GET", "websocket") == "fatal"


def test_ignored_and_aborted_denials_do_not_block_but_a_fatal_one_does():
    egress = policy()
    egress.record(f"{IGNORED}/v3?token=canary", "get", "script", "ignored")
    egress.record(f"{IGNORED}/v3", "get", "script", "ignored")
    egress.record("https://other.example.test/a.png", "GET", "image", "aborted")
    assert egress.fatal is False
    assert egress.denials() == [
        {"origin": IGNORED, "method": "GET", "resourceType": "script", "disposition": "ignored", "count": 2},
        {"origin": "https://other.example.test", "method": "GET", "resourceType": "image", "disposition": "aborted", "count": 1},
    ]
    egress.record("https://other.example.test/app.js", "GET", "script", "fatal")
    assert egress.fatal is True


def test_origins_beyond_the_limit_still_block_when_fatal():
    egress = policy()
    for index in range(70):
        egress.record(f"https://c{index}.example.test/a.png", "GET", "image", "aborted")
    assert len(egress.denials()) == 64 and egress.omitted == 6 and egress.fatal is False
    egress.record("https://late.example.test/app.js", "GET", "script", "fatal")
    assert egress.fatal is True


def test_from_input_reads_the_network_policy_and_is_absent_without_one():
    assert EgressPolicy.from_input({}) is None
    built = EgressPolicy.from_input({"networkPolicy": {"allowedOrigins": [TARGET], "ignoredOrigins": [IGNORED]}})
    assert built is not None and built.ignored == {IGNORED} and built.allowed == {TARGET}


class FakeRequest:
    def __init__(self, url, method="GET", resource_type="script"):
        self.url, self.method, self.resource_type = url, method, resource_type


class FakeRoute:
    def __init__(self, request):
        self.request, self.calls = request, []

    def abort(self, reason):
        self.calls.append(("abort", reason))

    def continue_(self):
        self.calls.append(("continue",))


def test_sync_route_handler_continues_allowed_and_aborts_the_rest():
    egress = policy()
    handle = egress.sync_route_handler()
    allowed, ignored, denied = (FakeRoute(FakeRequest(url)) for url in (f"{TARGET}/app.js", f"{IGNORED}/v3", "https://other.example.test/app.js"))
    for route in (allowed, ignored, denied):
        handle(route)
    assert allowed.calls == [("continue",)]
    assert ignored.calls == [("abort", "blockedbyclient")]
    assert denied.calls == [("abort", "blockedbyclient")]
    assert [item["disposition"] for item in egress.denials()] == ["ignored", "fatal"]


def test_async_route_handler_matches_the_sync_one():
    class AsyncRoute(FakeRoute):
        async def abort(self, reason):
            self.calls.append(("abort", reason))

        async def continue_(self):
            self.calls.append(("continue",))

    egress = policy()
    handle = egress.async_route_handler()
    routes = [AsyncRoute(FakeRequest(url)) for url in (f"{TARGET}/app.js", f"{IGNORED}/v3")]

    async def run():
        for route in routes:
            await handle(route)

    asyncio.run(run())
    assert routes[0].calls == [("continue",)]
    assert routes[1].calls == [("abort", "blockedbyclient")]
    assert [item["disposition"] for item in egress.denials()] == ["ignored"]


class Protocol:
    def __init__(self):
        self.events = []

    def emit(self, kind, payload):
        self.events.append((kind, payload))


def test_plugin_publishes_denials_on_the_imported_code_step_and_reports_a_fatal_one():
    protocol = Protocol()
    plugin = PythonPlugin(protocol, {"networkPolicy": {"allowedOrigins": [TARGET], "ignoredOrigins": [IGNORED]}})
    assert plugin.egress_denied is False
    plugin.egress.record(f"{IGNORED}/v3", "GET", "script", "ignored")
    plugin.emit_egress_denials()
    assert protocol.events == [
        ("egress.denied", {"stepId": "imported-code", "origin": IGNORED, "method": "GET", "resourceType": "script", "disposition": "ignored", "count": 1}),
    ]
    assert plugin.egress_denied is False
    plugin.egress.record("https://other.example.test/app.js", "GET", "script", "fatal")
    assert plugin.egress_denied is True


def test_plugin_without_a_network_policy_installs_nothing():
    protocol = Protocol()
    plugin = PythonPlugin(protocol, {})
    assert plugin.egress is None and plugin.egress_denied is False
    plugin.emit_egress_denials()
    assert protocol.events == []
