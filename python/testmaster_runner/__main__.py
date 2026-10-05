"""Connect the trusted protocol before pytest imports any user code."""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import platform
import stat
import sys
import threading
from pathlib import Path

from .forwarder import Forwarder
from .protocol import ProtocolClient, load_input


def admitted_files(root: Path, files: list[str]) -> list[str]:
    root = root.resolve(strict=True)
    selected = []
    for name in files:
        parts = Path(name).parts
        if not parts or Path(name).is_absolute() or ".." in parts or "\\" in name:
            raise ValueError("invalid pytest input path")
        current = root
        for part in parts:
            current = current / part
            info = current.lstat()
            if stat.S_ISLNK(info.st_mode):
                raise ValueError("symlink pytest input is forbidden")
        if not current.is_file() or current.suffix != ".py":
            raise ValueError("pytest input must be an admitted Python file")
        selected.append(str(current))
    if not selected:
        raise ValueError("empty pytest selection")
    return selected


def run(input_path: str | None) -> int:
    data = load_input(input_path)
    protocol = ProtocolClient(data["attemptId"], data["nonce"])
    stop = threading.Event()
    timeout_ms = data.get("timeoutMs", 120000)

    def terminate(outcome: str, reason: str, exit_code: int) -> None:
        if not stop.is_set():
            try:
                protocol.emit("runner.finished", {"outcome": outcome, "reasonCode": reason})
            finally:
                os._exit(exit_code)

    def listen() -> None:
        protocol._socket.settimeout(None)
        stream = protocol._socket.makefile("rb")
        try:
            while not stop.is_set():
                line = stream.readline(256 * 1024 + 1)
                if not line or len(line) > 256 * 1024:
                    if not stop.is_set():
                        os._exit(1)
                    return
                event = json.loads(line)
                if event.get("attemptId") != data["attemptId"] or event.get("protocolVersion") != "1.0.0":
                    os._exit(1)
                if event.get("type") == "control.cancel":
                    terminate("cancelled", "user_cancelled", 1)
        except (OSError, ValueError):
            if not stop.is_set():
                os._exit(1)

    timer = threading.Timer(timeout_ms / 1000, terminate, args=("inconclusive", "attempt_timeout", 1))
    timer.daemon = True
    timer.start()
    threading.Thread(target=listen, daemon=True).start()
    forwarder = None
    try:
        versions = {name: importlib.metadata.version(name) for name in ("pytest", "pytest-asyncio", "requests", "playwright")}
        metadata = {"imageId": data["imageId"], "python": platform.python_version(), "packages": versions,
                    "trustLevel": "imported", "limitations": ["Uninstrumented assertions and arbitrary imported code use the pytest process-exit contract; a passing process is not independent business-oracle proof."]}
        runtime = Path("/tmp/testmaster-runtime.json")
        runtime.write_text(json.dumps(metadata), encoding="utf-8")
        protocol.artifact(runtime, "python/runtime.json", "runtime", "application/json")
        selected = admitted_files(Path(data.get("codeRoot", "/run/testmaster/input/code")), data["files"])
        forwarder = Forwarder()
        proxy = "http://127.0.0.1:3128"
        os.environ.update(HTTP_PROXY=proxy, HTTPS_PROXY=proxy, http_proxy=proxy, https_proxy=proxy,
                          NO_PROXY="", no_proxy="", PIP_NO_INDEX="1", UV_OFFLINE="1", PYTEST_DISABLE_PLUGIN_AUTOLOAD="1")
        import pytest
        from . import plugin as fixtures
        from .plugin import PythonPlugin, install, uninstall
        adapter = PythonPlugin(protocol, data)
        token = install(adapter)
        try:
            # Ignore repository pytest config/conftest; explicitly admitted files only.
            code = pytest.main(["-c", "/dev/null", "--noconftest", "-p", "pytest_asyncio.plugin", "--basetemp=/tmp/pytest", "-q", *selected], plugins=[fixtures, adapter])
        finally:
            uninstall(token)
        if adapter.missing_package:
            outcome, reason = "blocked", "unsupported_capability"
        elif adapter.security_failure:
            outcome, reason = "blocked", "security_precondition_failed"
        elif adapter.failed:
            outcome, reason = "failed", "assertion_mismatch"
        elif adapter.incomplete or code != 0:
            outcome, reason = "inconclusive", "insufficient_evidence"
        elif adapter.completed > 0:
            outcome, reason = "passed", "assertions_satisfied"
        else:
            outcome, reason = "inconclusive", "insufficient_evidence"
        protocol.emit("runner.finished", {"outcome": outcome, "reasonCode": reason, "cleanupOutcome": "not_required"})
        return int(code) if outcome != "blocked" else 8
    except (importlib.metadata.PackageNotFoundError, ModuleNotFoundError) as exc:
        protocol.emit("log", {"level": "error", "message": f"missing_package: {exc}; runtime dependency downloads are forbidden"})
        protocol.emit("runner.finished", {"outcome": "blocked", "reasonCode": "unsupported_capability"})
        return 8
    except Exception as exc:
        protocol.emit("log", {"level": "error", "message": str(exc)[:8000]})
        protocol.emit("runner.finished", {"outcome": "inconclusive", "reasonCode": "insufficient_evidence"})
        return 1
    finally:
        stop.set()
        timer.cancel()
        if forwarder:
            forwarder.close()
        protocol.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=None)
    args = parser.parse_args()
    try:
        return run(args.input)
    except Exception as exc:
        print(f"testmaster python harness blocked: {exc}", file=sys.stderr)
        return 9


if __name__ == "__main__":
    raise SystemExit(main())
