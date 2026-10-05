"""Pytest integration for the isolated TestMaster Python runner."""
from __future__ import annotations

import contextvars
import time
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from typing import Any, Iterator

import pytest
import pytest_asyncio

from .protocol import ProtocolClient

_current: contextvars.ContextVar["PythonPlugin | None"] = contextvars.ContextVar("testmaster_plugin", default=None)


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

    def __post_init__(self) -> None:
        self._started: dict[str, float] = {}
        self._reports: dict[str, list[Any]] = {}

    def emit_step_start(self, nodeid: str, index: int = 0) -> str:
        step_id = _step_id(nodeid)
        self._started[step_id] = time.monotonic()
        self.protocol.emit("step.started", {"stepId": step_id, "index": index})
        return step_id

    def emit_step_finish(self, step_id: str, status: str, index: int = 0, error: str | None = None) -> None:
        started = self._started.pop(step_id, time.monotonic())
        payload: dict[str, Any] = {
            "stepId": step_id,
            "index": index,
            "status": status,
            "durationMs": max(0, round((time.monotonic() - started) * 1000)),
            "evidencePaths": [],
            "reasonCode": {"passed": "assertions_satisfied", "failed": "assertion_mismatch", "blocked": "unsupported_capability", "inconclusive": "insufficient_evidence"}[status],
        }
        if error:
            payload["error"] = {"code": "pytest_failure", "message": error[:8000]}
        self.protocol.emit("step.finished", payload)

    @contextmanager
    def step(self, name: str, index: int = 0) -> Iterator[None]:
        step_id = self.emit_step_start(name, index)
        try:
            yield
        except BaseException as exc:
            self.failed = True
            self.emit_step_finish(step_id, "failed", index, str(exc))
            raise
        else:
            self.emit_step_finish(step_id, "passed", index)

    def pytest_runtest_logstart(self, nodeid: str, location: tuple[str, int | None, str]) -> None:
        self.emit_step_start(nodeid)

    def _diagnose(self, report: Any) -> bool:
        text = getattr(report, "longreprtext", "")
        if "ModuleNotFoundError" in text or "ImportError" in text:
            self.missing_package = True
            self.protocol.emit("log", {"level": "error", "message": "missing_package: runtime dependency downloads are forbidden"})
            return True
        if "chromium.launch" in text or "BrowserType.launch" in text:
            self.security_failure = True
            return True
        return False

    def pytest_collectreport(self, report: Any) -> None:
        if report.failed:
            self._diagnose(report)

    def pytest_runtest_logreport(self, report: Any) -> None:
        self._reports.setdefault(report.nodeid, []).append(report)
        if report.failed and not self._diagnose(report) and report.when == "call":
            self.failed = True

    def pytest_runtest_logfinish(self, nodeid: str, location: tuple[str, int | None, str]) -> None:
        self.completed += 1
        reports = self._reports.pop(nodeid, [])
        failed = next((getattr(report, "longreprtext", "") for report in reports if report.failed), None)
        skipped = any(report.skipped for report in reports)
        status = "failed" if failed else "inconclusive" if skipped else "passed"
        if failed and self.missing_package:
            status = "blocked"
        if failed and self.security_failure:
            status = "blocked"
        if skipped or (failed and all(report.when != "call" for report in reports if report.failed)):
            self.incomplete = True
        self.emit_step_finish(_step_id(nodeid), status, error=failed)

    def fixture_page(self) -> Any:
        from playwright.sync_api import sync_playwright

        base_url = self.input_data.get("baseUrl")
        args = ["--proxy-server=http://127.0.0.1:3128", "--proxy-bypass-list=<-loopback>"]
        manager = sync_playwright().start()
        browser = manager.chromium.launch(headless=True, chromium_sandbox=True, args=args)
        context = browser.new_context(base_url=base_url if isinstance(base_url, str) else None)
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
        page = await context.new_page()
        try:
            yield page
        finally:
            await context.close()
            await browser.close()
            await manager.stop()

    def fixture_request(self) -> Any:
        import requests

        session = requests.Session()
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
