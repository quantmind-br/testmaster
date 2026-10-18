"""Pytest integration for the isolated TestMaster Python runner."""
from __future__ import annotations

import contextvars
import re
import time
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urljoin

import pytest
import pytest_asyncio

from .egress import EgressPolicy
from .protocol import ProtocolClient

_current: contextvars.ContextVar["PythonPlugin | None"] = contextvars.ContextVar("testmaster_plugin", default=None)


# An assertion (or an explicit `pytest.fail`) is a verdict on the target; any other exception is not.
ASSERTION_ERRORS = (AssertionError, pytest.fail.Exception)

# A locator action that matched several elements (`Locator.click: Error: strict mode violation: ...
# resolved to 2 elements`) or timed out without ever matching one is also a verdict on the target,
# like the declarative runner's ambiguous and never-attached locators. One that matched an element
# but did not complete (the call log has "locator resolved to": not enabled, covered) is not.
_STRICT_VIOLATION = re.compile(r"^\s*(?:\w*Error: )?(?:Locator\.\w+: )?(?:\w*Error: )?strict mode violation: [^\n]*\bresolved to \d+ elements?\b")
_LOCATOR_TIMEOUT = re.compile(r"^\s*(?:[\w.]*Error: )?Locator\.\w+: (?:\w*Error: )?Timeout \d+ms exceeded\b")
_LOCATOR_RESOLVED = re.compile(r"^\s*-\s+locator resolved to\b", re.MULTILINE)


def locator_verdict(exc: BaseException) -> str | None:
    """`assertion_mismatch` or `assertion_timeout` when a Playwright locator action ended in a verdict, else None."""
    text = str(exc)
    if _STRICT_VIOLATION.search(text):
        return "assertion_mismatch"
    if _LOCATOR_TIMEOUT.search(text) and not _LOCATOR_RESOLVED.search(text):
        return "assertion_timeout"
    return None


# Longest title a step carries on the wire; the Playwright reporter cuts at the same length.
STEP_TITLE_CHARS = 500


def _step_id(value: str) -> str:
    result = "".join(char if char.isalnum() or char in "_.-" else "_" for char in value)
    return result[:200] or "step"


@dataclass
class PythonPlugin:
    protocol: ProtocolClient
    input_data: dict[str, Any]
    failed: bool = False
    missing_package: bool = False
    security_failure: bool = False
    completed: int = 0
    incomplete: bool = False
    failure_count: int = 0
    timeout_count: int = 0

    def __post_init__(self) -> None:
        self._started: dict[str, float] = {}
        self._titles: dict[str, str] = {}
        self._reports: dict[str, list[Any]] = {}
        self._indexes: dict[str, int] = {}
        self._next_index = 0
        self._used_indexes: set[int] = {1000000}  # Reserved by the imported-code wrapper.
        self._used_step_ids: set[str] = {"imported-code"}
        self._pytest_steps: dict[str, str] = {}
        self._assertions: set[str] = set()
        self._thrown: dict[str, tuple[str, str]] = {}
        self._locator_verdicts: dict[str, str] = {}
        # The browser egress policy of the fixtures; without a network policy in the input nothing is installed.
        self.egress = EgressPolicy.from_input(self.input_data)

    @property
    def egress_denied(self) -> bool:
        """A browser request was denied fatally (not an ignored origin, not a passive subresource): SEC-011."""
        return bool(self.egress and self.egress.fatal)

    def emit_egress_denials(self) -> None:
        """Publishes what the fixtures' route hook denied, once per origin and resource type, on the imported-code step."""
        if not self.egress:
            return
        for denial in self.egress.denials():
            self.protocol.emit("egress.denied", {"stepId": "imported-code", **denial})
        if self.egress.omitted:
            self.protocol.emit("log", {"level": "warn", "message": f"egress_denials_omitted:{self.egress.omitted}"})

    def emit_step_start(self, nodeid: str, index: int | None = None) -> str:
        if index is None:
            index = self._next_index
            while index in self._used_indexes:
                index += 1
        if index < 0 or index in self._used_indexes:
            raise ValueError("Step indexes must be nonnegative and unique")
        self._used_indexes.add(index)
        self._next_index = max(self._next_index, index + 1)
        step_id = _step_id(nodeid)
        if step_id in self._used_step_ids:
            step_id = f"{step_id[:180]}_{index}"
            while step_id in self._used_step_ids:
                step_id += "_"
        self._used_step_ids.add(step_id)
        self._indexes[step_id] = index
        self._started[step_id] = time.monotonic()
        # The pytest node id (or the step name), unsanitized: the step id is only a safe form of it.
        self._titles[step_id] = nodeid[:STEP_TITLE_CHARS]
        self.protocol.emit("step.started", {"stepId": step_id, "index": index, "title": self._titles[step_id]})
        return step_id

    def emit_step_finish(self, step_id: str, status: str, error: str | None = None, code: str = "pytest_failure", reason: str | None = None) -> None:
        started = self._started.pop(step_id, time.monotonic())
        reason_code = reason or {"passed": "assertions_satisfied", "failed": "assertion_mismatch", "blocked": "unsupported_capability", "inconclusive": "insufficient_evidence"}[status]
        if status == "failed":
            self.failure_count += 1
            if reason_code == "assertion_timeout":
                self.timeout_count += 1
        payload: dict[str, Any] = {
            "stepId": step_id,
            "index": self._indexes.pop(step_id),
            "title": self._titles.pop(step_id),
            "status": status,
            "durationMs": max(0, round((time.monotonic() - started) * 1000)),
            "evidencePaths": [],
            "reasonCode": reason_code,
        }
        if error:
            payload["error"] = {"code": code, "message": error[:8000]}
        self.protocol.emit("step.finished", payload)

    @contextmanager
    def step(self, name: str, index: int | None = None) -> Iterator[None]:
        step_id = self.emit_step_start(name, index)
        try:
            yield
        except BaseException as exc:
            verdict = locator_verdict(exc)
            if isinstance(exc, ASSERTION_ERRORS):
                self.failed = True
                self.emit_step_finish(step_id, "failed", str(exc))
            elif verdict:
                self.failed = True
                self.emit_step_finish(step_id, "failed", f"{type(exc).__name__}: {exc}", type(exc).__name__, verdict)
            else:
                self.incomplete = True
                self.emit_step_finish(step_id, "inconclusive", f"{type(exc).__name__}: {exc}", type(exc).__name__)
            raise
        else:
            self.emit_step_finish(step_id, "passed")

    def pytest_runtest_logstart(self, nodeid: str, location: tuple[str, int | None, str]) -> None:
        self._pytest_steps[nodeid] = self.emit_step_start(nodeid)

    def _diagnose(self, report: Any) -> bool:
        # Source listings can contain imports or launch calls unrelated to the failure.
        crash = getattr(getattr(report, "longrepr", None), "reprcrash", None)
        text = getattr(crash, "message", "")
        if text.startswith(("ModuleNotFoundError:", "ImportError:")):
            self.missing_package = True
            self.protocol.emit("log", {"level": "error", "message": "missing_package: runtime dependency downloads are forbidden"})
            return True
        if text.startswith(("playwright._impl._errors.Error: BrowserType.launch:", "Error: BrowserType.launch:", "playwright._impl._errors.TimeoutError: BrowserType.launch:", "TimeoutError: BrowserType.launch:")):
            self.security_failure = True
            return True
        return False

    def pytest_collectreport(self, report: Any) -> None:
        if report.failed:
            if self._diagnose(report):
                return
            # Pytest wraps module import failures in CollectError, whose report
            # has no reprcrash. Inspect terminal exception lines, not source text.
            lines = getattr(report, "longreprtext", "").splitlines()
            if any(line.strip().removeprefix("E").lstrip().startswith(("ModuleNotFoundError:", "ImportError:")) for line in lines):
                self.missing_package = True
                self.protocol.emit("log", {"level": "error", "message": "missing_package: runtime dependency downloads are forbidden"})

    def pytest_exception_interact(self, node: Any, call: Any, report: Any) -> None:
        # Collection reports may render a traceback without reprcrash. The exception
        # object retains its type, unlike unrelated import text in source listings.
        if call.excinfo is None:
            return
        if isinstance(call.excinfo.value, ImportError):
            self.missing_package = True
            self.protocol.emit("log", {"level": "error", "message": "missing_package: runtime dependency downloads are forbidden"})
        nodeid = getattr(node, "nodeid", None)
        if nodeid is None:
            return
        if call.when == "call" and isinstance(call.excinfo.value, ASSERTION_ERRORS):
            self._assertions.add(nodeid)
        elif call.when == "call" and (verdict := locator_verdict(call.excinfo.value)):
            self._locator_verdicts[nodeid] = verdict
        self._thrown.setdefault(nodeid, (call.excinfo.typename, self._thrown_message(call.excinfo, report)))

    def _thrown_message(self, excinfo: Any, report: Any) -> str:
        """The exception as `Class: message` with the `at file:line` it was raised on."""
        crash = getattr(getattr(report, "longrepr", None), "reprcrash", None)
        text = getattr(crash, "message", None) or f"{excinfo.typename}: {excinfo.value}"
        path, line = getattr(crash, "path", None), getattr(crash, "lineno", None)
        if not path or not line:
            return text
        root = Path(self.input_data.get("codeRoot", "/run/testmaster/input/code"))
        try:
            shown = Path(path).relative_to(root)
        except ValueError:
            shown = Path(path).name
        return f"{text}\n    at {shown}:{line}"

    def pytest_runtest_logreport(self, report: Any) -> None:
        self._reports.setdefault(report.nodeid, []).append(report)
        if report.failed:
            self._diagnose(report)

    def pytest_runtest_logfinish(self, nodeid: str, location: tuple[str, int | None, str]) -> None:
        self.completed += 1
        reports = self._reports.pop(nodeid, [])
        failed = next((getattr(report, "longreprtext", "") for report in reports if report.failed), None)
        skipped = any(report.skipped for report in reports)
        assertion = nodeid in self._assertions
        self._assertions.discard(nodeid)
        verdict = self._locator_verdicts.pop(nodeid, None)
        thrown = self._thrown.pop(nodeid, None)
        # Only an assertion, or a locator action that matched several elements or never matched one,
        # is a verdict on the target: any other exception the test code raised (or one raised while
        # setting it up) leaves the test inconclusive, like any non-assertion step.
        status = "passed"
        if failed:
            status = "failed" if assertion or verdict else "inconclusive"
        elif skipped:
            status = "inconclusive"
        if failed and (self.missing_package or self.security_failure):
            status = "blocked"
        if status == "failed":
            self.failed = True
        if skipped or (failed and status == "inconclusive"):
            self.incomplete = True
        error, code = (failed, "pytest_failure") if assertion or thrown is None else (thrown[1], thrown[0])
        self.emit_step_finish(self._pytest_steps.pop(nodeid), status, error=failed and error, code=code, reason=verdict if status == "failed" else None)

    def fixture_page(self) -> Any:
        from playwright.sync_api import sync_playwright

        base_url = self.input_data.get("baseUrl")
        args = ["--proxy-server=http://127.0.0.1:3128", "--proxy-bypass-list=<-loopback>"]
        manager = sync_playwright().start()
        browser = manager.chromium.launch(headless=True, chromium_sandbox=True, args=args)
        context = browser.new_context(base_url=base_url if isinstance(base_url, str) else None)
        if self.egress:
            self.egress.guard_sync(context)
        page = context.new_page()
        try:
            yield page
        finally:
            context.close()
            browser.close()
            manager.stop()


    @asynccontextmanager
    async def async_page_context(self) -> Any:
        from playwright.async_api import async_playwright
        base_url = self.input_data.get("baseUrl")
        args = ["--proxy-server=http://127.0.0.1:3128", "--proxy-bypass-list=<-loopback>"]
        manager = await async_playwright().start()
        browser = await manager.chromium.launch(headless=True, chromium_sandbox=True, args=args)
        context = await browser.new_context(base_url=base_url if isinstance(base_url, str) else None)
        if self.egress:
            await self.egress.guard_async(context)
        page = await context.new_page()
        try:
            yield page
        finally:
            await context.close()
            await browser.close()
            await manager.stop()

    def fixture_request(self) -> Any:
        import requests

        base_url = self.input_data.get("baseUrl")

        class ConfiguredSession(requests.Session):
            def request(self, method: str, url: str, **kwargs: Any) -> Any:
                target = urljoin(base_url, url) if isinstance(base_url, str) else url
                return super().request(method, target, **kwargs)

        session = ConfiguredSession()
        session.trust_env = True
        try:
            yield session
        finally:
            session.close()


@pytest.fixture
def tm_page() -> Any:
    plugin = _current.get()
    if plugin is None:
        raise pytest.UsageError("tm_page requires the TestMaster harness")
    yield from plugin.fixture_page()


@pytest_asyncio.fixture
async def tm_async_page() -> Any:
    plugin = _current.get()
    if plugin is None:
        raise pytest.UsageError("tm_async_page requires the TestMaster harness")
    async with plugin.async_page_context() as page:
        yield page


@pytest.fixture
def tm_request() -> Any:
    plugin = _current.get()
    if plugin is None:
        raise pytest.UsageError("tm_request requires the TestMaster harness")
    yield from plugin.fixture_request()


def current_plugin() -> PythonPlugin | None:
    return _current.get()


def install(plugin: PythonPlugin) -> contextvars.Token[PythonPlugin | None]:
    return _current.set(plugin)


def uninstall(token: contextvars.Token[PythonPlugin | None]) -> None:
    _current.reset(token)
