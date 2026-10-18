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


def test_pytest_items_and_nested_steps_have_distinct_paired_indexes(tmp_path):
    import pytest

    source = tmp_path / "test_items.py"
    source.write_text("def test_first():\n    assert 2 + 2 == 4\n\ndef test_second():\n    assert 2 + 2 == 5\n")
    protocol = Protocol()
    plugin = PythonPlugin(protocol, {})
    result = pytest.main([str(source), "-q", "--noconftest", "-o", "addopts="], plugins=[plugin])
    assert result == pytest.ExitCode.TESTS_FAILED
    starts = [payload for kind, payload in protocol.events if kind == "step.started"]
    finishes = [payload for kind, payload in protocol.events if kind == "step.finished"]
    assert [event["index"] for event in starts] == [0, 1]
    assert [(event["stepId"], event["index"]) for event in finishes] == [(event["stepId"], event["index"]) for event in starts]
    assert [event["status"] for event in finishes] == ["passed", "failed"]

    plugin.pytest_runtest_logstart("test_outer", ("test_items.py", 0, "test_outer"))
    with plugin.step("nested"):
        pass
    plugin.pytest_runtest_logfinish("test_outer", ("test_items.py", 0, "test_outer"))
    finishes = [payload for kind, payload in protocol.events if kind == "step.finished"]
    assert [event["index"] for event in finishes] == [0, 1, 3, 2]
    assert plugin.completed == 3


def test_explicit_step_index_cannot_reuse_an_emitted_index():
    import pytest

    plugin = PythonPlugin(Protocol(), {})
    with plugin.step("explicit", index=5):
        pass
    with plugin.step("automatic"):
        pass
    with pytest.raises(ValueError, match="nonnegative and unique"):
        with plugin.step("duplicate", index=5):
            pass
    finishes = [payload for kind, payload in plugin.protocol.events if kind == "step.finished"]
    assert [event["index"] for event in finishes] == [5, 6]


def test_colliding_and_nested_step_names_keep_their_original_failures():
    import pytest

    plugin = PythonPlugin(Protocol(), {})
    with pytest.raises(AssertionError, match="business mismatch"):
        with plugin.step("same"):
            with plugin.step("same"):
                raise AssertionError("business mismatch")
    for nodeid in ["test_value[1/2]", "test_value[1_2]"]:
        plugin.pytest_runtest_logstart(nodeid, ("test_items.py", 0, "test_value"))
        plugin.pytest_runtest_logfinish(nodeid, ("test_items.py", 0, "test_value"))
    starts = [payload for kind, payload in plugin.protocol.events if kind == "step.started"]
    finishes = [payload for kind, payload in plugin.protocol.events if kind == "step.finished"]
    assert len({event["stepId"] for event in starts}) == 4
    assert {(event["stepId"], event["index"]) for event in finishes} == {(event["stepId"], event["index"]) for event in starts}
    assert [event["status"] for event in finishes] == ["failed", "failed", "passed", "passed"]
    assert [event["error"]["message"] for event in finishes[:2]] == ["business mismatch", "business mismatch"]


def test_steps_carry_the_pytest_node_id_or_step_name_as_title_cut_at_500_characters(tmp_path):
    import pytest

    source = tmp_path / "test_titles.py"
    source.write_text("import pytest\n\n@pytest.mark.parametrize('value', ['a/b', 'c d'])\ndef test_value(value):\n    assert value\n")
    protocol = Protocol()
    plugin = PythonPlugin(protocol, {})
    pytest.main([str(source), "-q", "--noconftest", "-o", "addopts="], plugins=[plugin])
    with plugin.step("open the login page"):
        pass
    with plugin.step("x" * 600):
        pass
    starts = [payload for kind, payload in protocol.events if kind == "step.started"]
    finishes = [payload for kind, payload in protocol.events if kind == "step.finished"]
    titles = [event["title"] for event in starts]
    # The title is the original text, where the step id is only a sanitized form of it.
    assert titles[0].endswith("test_titles.py::test_value[a/b]")
    assert titles[1].endswith("test_titles.py::test_value[c d]")
    assert starts[0]["stepId"] != titles[0]
    assert titles[2:] == ["open the login page", "x" * 500]
    assert [event["title"] for event in finishes] == titles


def finished_steps(protocol):
    return {payload["stepId"]: payload for kind, payload in protocol.events if kind == "step.finished"}


def run_source(tmp_path, source):
    import pytest

    # Each source needs its own module name: pytest.main reuses this process's import cache.
    path = tmp_path / f"test_kinds_{abs(hash(str(tmp_path)))}.py"
    path.write_text(source)
    protocol = Protocol()
    plugin = PythonPlugin(protocol, {"codeRoot": str(tmp_path)})
    pytest.main([str(path), "-q", "--noconftest", "-o", "addopts=", "-p", "no:cacheprovider"], plugins=[plugin])
    # A pytest step is named after its node id; the test function is its last segment.
    steps = {step_id.rsplit("__", 1)[-1]: step for step_id, step in finished_steps(protocol).items()}
    return plugin, steps, path.name


def test_only_an_assertion_is_a_verdict_and_other_exceptions_leave_the_test_inconclusive(tmp_path):
    plugin, steps, filename = run_source(
        tmp_path,
        "import pytest\n\ndef test_asserts():\n    assert 1 == 2\n\ndef test_raises():\n    raise KeyError('paths')\n\ndef test_fails():\n    pytest.fail('explicit')\n",
    )
    assert (steps["test_asserts"]["status"], steps["test_asserts"]["reasonCode"]) == ("failed", "assertion_mismatch")
    assert steps["test_asserts"]["error"]["code"] == "pytest_failure"
    assert (steps["test_fails"]["status"], steps["test_fails"]["reasonCode"]) == ("failed", "assertion_mismatch")
    raised = steps["test_raises"]
    assert (raised["status"], raised["reasonCode"]) == ("inconclusive", "insufficient_evidence")
    assert raised["error"] == {"code": "KeyError", "message": f"KeyError: 'paths'\n    at {filename}:7"}
    assert plugin.failed is True


def test_run_whose_tests_only_raised_has_no_assertion_failure(tmp_path):
    plugin, steps, _ = run_source(tmp_path, "def test_raises():\n    raise ValueError('boom')\n")
    step = steps["test_raises"]
    assert (step["status"], step["reasonCode"], step["error"]["code"]) == ("inconclusive", "insufficient_evidence", "ValueError")
    # The harness reports the aggregate failed only when `failed` is set; `incomplete` makes it inconclusive.
    assert plugin.failed is False
    assert plugin.incomplete is True


def test_explicit_step_classifies_the_exception_it_wraps():
    import pytest

    plugin = PythonPlugin(Protocol(), {})
    with pytest.raises(RuntimeError):
        with plugin.step("lookup"):
            raise RuntimeError("no manifest")
    [finish] = [payload for kind, payload in plugin.protocol.events if kind == "step.finished"]
    assert (finish["status"], finish["reasonCode"]) == ("inconclusive", "insufficient_evidence")
    assert finish["error"] == {"code": "RuntimeError", "message": "RuntimeError: no manifest"}
    assert plugin.failed is False
    assert plugin.incomplete is True


STRICT = "Locator.click: Error: strict mode violation: get_by_role(\"button\", name=\"Two\") resolved to 2 elements:\n    1) <button>Two</button>\n\nCall log:\n  - waiting for get_by_role(\"button\", name=\"Two\")"
NEVER_ATTACHED = "Locator.click: Timeout 1500ms exceeded.\nCall log:\n  - waiting for get_by_role(\"button\", name=\"Missing\")"
ATTACHED = "Locator.click: Timeout 1500ms exceeded.\nCall log:\n  - waiting for get_by_role(\"button\", name=\"Off\")\n    - locator resolved to <button disabled>Off</button>\n  - attempting click action\n    - element is not enabled"


def raising(message):
    return f"raise RuntimeError({message!r})"


def test_locator_strict_violation_and_never_attached_timeout_are_verdicts_attached_timeout_is_not(tmp_path):
    plugin, steps, _ = run_source(
        tmp_path,
        "def test_strict():\n    " + raising(STRICT) + "\n\ndef test_missing():\n    " + raising(NEVER_ATTACHED) + "\n\ndef test_disabled():\n    " + raising(ATTACHED) + "\n",
    )
    assert (steps["test_strict"]["status"], steps["test_strict"]["reasonCode"]) == ("failed", "assertion_mismatch")
    assert (steps["test_missing"]["status"], steps["test_missing"]["reasonCode"]) == ("failed", "assertion_timeout")
    assert (steps["test_disabled"]["status"], steps["test_disabled"]["reasonCode"]) == ("inconclusive", "insufficient_evidence")
    assert steps["test_strict"]["error"]["code"] == "RuntimeError"
    assert plugin.failed is True
    assert (plugin.failure_count, plugin.timeout_count) == (2, 1)


def test_explicit_step_gives_a_locator_error_the_same_verdict_as_a_bare_test():
    import pytest

    plugin = PythonPlugin(Protocol(), {})
    for message in (STRICT, NEVER_ATTACHED, ATTACHED):
        with pytest.raises(RuntimeError):
            with plugin.step("click"):
                raise RuntimeError(message)
    finishes = [payload for kind, payload in plugin.protocol.events if kind == "step.finished"]
    assert [(event["status"], event["reasonCode"]) for event in finishes] == [
        ("failed", "assertion_mismatch"),
        ("failed", "assertion_timeout"),
        ("inconclusive", "insufficient_evidence"),
    ]
    assert plugin.failed is True
    assert plugin.incomplete is True
    assert (plugin.failure_count, plugin.timeout_count) == (2, 1)
