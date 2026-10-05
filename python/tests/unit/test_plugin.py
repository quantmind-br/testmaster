"""Failure classification must inspect the exception, not unrelated source lines."""
from types import SimpleNamespace

from testmaster_runner.plugin import PythonPlugin


class Protocol:
    def __init__(self):
        self.events = []

    def emit(self, kind, payload):
        self.events.append((kind, payload))


def report(message, source=""):
    return SimpleNamespace(
        longrepr=SimpleNamespace(reprcrash=SimpleNamespace(message=message)),
        longreprtext=source + "\n" + message,
    )


def test_business_assertion_is_not_launch_failure():
    plugin = PythonPlugin(Protocol(), {})
    assert plugin._diagnose(report("AssertionError: Expected password validation", "browser = playwright.chromium.launch(headless=True)\nimport requests")) is False
    assert plugin.security_failure is False
    assert plugin.missing_package is False


def test_browser_launch_exception_is_security_failure():
    plugin = PythonPlugin(Protocol(), {})
    assert plugin._diagnose(report("playwright._impl._errors.Error: BrowserType.launch: sandbox unavailable")) is True
    assert plugin.security_failure is True


def test_missing_dependency_uses_actual_exception():
    protocol = Protocol()
    plugin = PythonPlugin(protocol, {})
    assert plugin._diagnose(report("ModuleNotFoundError: No module named 'unavailable'")) is True
    assert plugin.missing_package is True
    assert protocol.events[0][1]["message"].startswith("missing_package:")


def test_import_error_text_inside_assertion_is_not_dependency_failure():
    plugin = PythonPlugin(Protocol(), {})
    assert plugin._diagnose(report("AssertionError: Expected ImportError warning", "raise ImportError('a fixture source line')")) is False
    assert plugin.missing_package is False


def test_collection_import_error_without_reprcrash_is_blocked():
    import pytest

    protocol = Protocol()
    plugin = PythonPlugin(protocol, {})
    for error in (ModuleNotFoundError("missing package"), ImportError("missing export")):
        with pytest.raises(type(error)) as caught:
            raise error
        plugin.pytest_exception_interact(None, SimpleNamespace(excinfo=caught), SimpleNamespace(failed=True, longrepr="collection error"))
        assert plugin.missing_package is True
        assert protocol.events[-1][1]["message"].startswith("missing_package:")


def test_wrapped_collection_import_failure_uses_terminal_exception_line():
    plugin = PythonPlugin(Protocol(), {})
    plugin.pytest_collectreport(SimpleNamespace(failed=True, longrepr="CollectError", longreprtext="    import missing\nE   ModuleNotFoundError: No module named 'missing'"))
    assert plugin.missing_package is True
    safe = PythonPlugin(Protocol(), {})
    safe.pytest_collectreport(SimpleNamespace(failed=True, longrepr="CollectError", longreprtext="    assert 'ImportError: warning'\nE   AssertionError: ImportError warning"))
    assert safe.missing_package is False


def test_request_fixture_resolves_relative_urls_against_run_environment(monkeypatch):
    import requests

    calls = []

    def capture(self, method, url, **kwargs):
        calls.append((method, url, kwargs))
        return "response"

    monkeypatch.setattr(requests.Session, "request", capture)
    plugin = PythonPlugin(Protocol(), {"baseUrl": "http://fixture.test:1234"})
    fixture = plugin.fixture_request()
    session = next(fixture)
    try:
        assert session.get("/health", timeout=3) == "response"
        assert session.post("http://other.test/action", timeout=5) == "response"
        assert [(method, url, kwargs["timeout"]) for method, url, kwargs in calls] == [("GET", "http://fixture.test:1234/health", 3), ("POST", "http://other.test/action", 5)]
        assert calls[0][2]["allow_redirects"] is True
        assert session.trust_env is True
    finally:
        fixture.close()
