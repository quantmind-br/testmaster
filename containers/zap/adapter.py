"""OWASP ZAP adapter for DAST probes (M5-06, REQ-048).

Runs inside the hardened `testmaster-runner-zap` container. The adapter starts the egress forwarder,
a ZAP daemon on loopback chained to that forwarder, spiders and (optionally) actively scans the
authorized target, and reports the result through the attempt protocol: `dast:spider`,
`dast:active-scan`, one step per alert risk, and the aggregate `dast` step last. No timer cuts a
scan: the adapter polls ZAP until it finishes or the supervisor cancels the attempt. Secret values
reach the target only as ZAP replacer rules; every string written to an event or artifact is
scrubbed first.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

ZAP_HOST = "127.0.0.1"
ZAP_PORT = 8090
UPSTREAM_PROXY = ("127.0.0.1", 3128)
ZAP_LAUNCHER = "/zap/zap.sh"
ZAP_HEAP = "-Xmx1g"  # the container allows 2 GiB; the rest covers the JVM's own overhead and the forwarder
AGGREGATE_STEP = "dast"
AGGREGATE_INDEX = 1000000
MESSAGE_LIMIT = 2000
POLL_SECONDS = 1.0
ALERT_PAGE = 500
# Highest first; `failOn` fails on that risk and every higher one.
RISKS = ("high", "medium", "low", "informational")
FAIL_ON = ("high", "medium", "low")
# ZAP's own stable plugin ids, checked against the pinned image: SQL injection, reflected and
# persistent XSS, path traversal, remote file inclusion, OS command injection, CRLF injection,
# external redirect and server-side template injection.
API_MINIMAL_RULES = (
    6, 7, 20019, 40003, 40012, 40014, 40016, 40017, 40018, 40019, 40020, 40021, 40022, 40027,
    90020, 90035, 90036, 90037,
)
API_MINIMAL_POLICY = "testmaster-api-minimal"
DEFAULT_POLICY = "Default Policy"
WORK_ROOT = Path("/tmp")


class ZapError(RuntimeError):
    """ZAP refused a call or is not reachable."""


class ZapApi:
    """Minimal JSON client for the loopback ZAP API; every call goes straight to ZAP, never through a proxy."""

    def __init__(self, key: str, host: str = ZAP_HOST, port: int = ZAP_PORT) -> None:
        self._base = f"http://{host}:{port}"
        self._key = key
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, component: str, kind: str, name: str, **params: Any) -> Any:
        """`kind` is `view`, `action` or `other`; parameters equal to None are omitted."""
        query = {"apikey": self._key}
        for field, value in params.items():
            if value is None:
                continue
            query[field] = str(value).lower() if isinstance(value, bool) else str(value)
        prefix = "OTHER" if kind == "other" else "JSON"
        url = f"{self._base}/{prefix}/{component}/{kind}/{name}/?{urllib.parse.urlencode(query)}"
        try:
            with self._opener.open(url) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                detail = json.loads(raw).get("message") or exc.reason
            except (ValueError, AttributeError):
                detail = exc.reason
            raise ZapError(f"{component}.{name}: {detail}") from None
        except (urllib.error.URLError, OSError) as exc:
            raise ZapError(f"{component}.{name}: ZAP is not reachable ({type(exc).__name__})") from None
        if kind == "other":
            return raw
        return json.loads(raw)


class Scrubber:
    """Replaces every form of every secret value with `[secret:<ref>]`."""

    def __init__(self, secrets_by_ref: list[tuple[str, str]]) -> None:
        forms: list[tuple[str, str]] = []
        for ref, value in secrets_by_ref:
            if not value:
                continue
            candidates = {value, json.dumps(value)[1:-1], urllib.parse.quote(value, safe=""), urllib.parse.quote_plus(value)}
            token = value.rsplit(" ", 1)[-1]
            if token != value and len(token) >= 8:
                candidates |= {token, json.dumps(token)[1:-1], urllib.parse.quote(token, safe="")}
            forms.extend((form, ref) for form in candidates if form)
        self._forms = sorted(forms, key=lambda item: -len(item[0]))

    def text(self, value: str) -> str:
        for form, ref in self._forms:
            value = value.replace(form, f"[secret:{ref}]")
        return value

    def value(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, list):
            return [self.value(item) for item in value]
        if isinstance(value, dict):
            return {self.text(key): self.value(item) for key, item in value.items()}
        return value

    def leaked(self, value: str) -> bool:
        return any(form in value for form, _ in self._forms)


class Outcome:
    def __init__(self, status: str, reason: str, code: str | None = None, message: str | None = None) -> None:
        self.status = status
        self.reason = reason
        self.code = code
        self.message = message


PASSED = ("passed", "assertions_satisfied")


def risk_rank(risk: str) -> int:
    return RISKS.index(risk) if risk in RISKS else len(RISKS) - 1


def normalize_alert(raw: dict[str, Any], scrub: Scrubber) -> dict[str, Any]:
    """Keeps only the fields a reader needs to find the issue; evidence, attack and request bodies are dropped."""
    risk = str(raw.get("risk") or "").split(" ")[0].lower()
    if risk not in RISKS:
        risk = "informational"
    try:
        cwe = int(raw.get("cweid"))
    except (TypeError, ValueError):
        cwe = None
    return scrub.value({
        "pluginId": str(raw.get("pluginId") or ""),
        "name": str(raw.get("alert") or raw.get("name") or ""),
        "risk": risk,
        "confidence": str(raw.get("confidence") or "").lower(),
        "method": str(raw.get("method") or ""),
        "url": str(raw.get("url") or ""),
        "param": str(raw.get("param") or ""),
        "cweid": cwe if cwe and cwe > 0 else None,
    })


def group_alerts(alerts: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = {risk: [] for risk in RISKS}
    for alert in alerts:
        groups[alert["risk"]].append(alert)
    return groups


def risk_outcome(risk: str, alerts: list[dict[str, Any]], fail_on: str) -> Outcome:
    """A risk at or above `failOn` with at least one alert fails; everything else passes."""
    if alerts and risk_rank(risk) <= risk_rank(fail_on) and risk in FAIL_ON:
        names = sorted({alert["name"] for alert in alerts})
        return Outcome("failed", "assertion_mismatch", "dast_alert", f"{len(alerts)} {risk} alerts: {', '.join(names)}"[:MESSAGE_LIMIT])
    return Outcome(*PASSED)


def target_url(base_url: str, path: str) -> str:
    return base_url.rstrip("/") + path


class Runner:
    """One DAST attempt against a ZAP API; `api` and `protocol` are injectable so the flow runs without ZAP."""

    def __init__(self, data: dict[str, Any], protocol: Any, api: Any, scrub: Scrubber, work: Path,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self.data = data
        self.probe = data["probe"]
        self.protocol = protocol
        self.api = api
        self.scrub = scrub
        self.work = work
        self.sleep = sleep
        self.base_url = data["baseUrl"]
        self._index = 0
        self.outcomes: list[Outcome] = []

    def run(self, credentials: list[tuple[str, str, str]]) -> tuple[str, str]:
        """Emits every step and returns the aggregate (status, reasonCode); the aggregate step is last."""
        self.protocol.emit("step.started", {"stepId": AGGREGATE_STEP, "index": AGGREGATE_INDEX, "title": AGGREGATE_STEP})
        started = time.monotonic()
        try:
            verdict = self._execute(credentials)
        except Exception as exc:
            # Never echo the message: it may carry request data.
            verdict = Outcome("inconclusive", "insufficient_evidence", type(exc).__name__, f"unexpected {type(exc).__name__}")
        payload: dict[str, Any] = {
            "stepId": AGGREGATE_STEP,
            "index": AGGREGATE_INDEX,
            "title": AGGREGATE_STEP,
            "status": verdict.status,
            "reasonCode": verdict.reason,
            "durationMs": max(0, round((time.monotonic() - started) * 1000)),
            "evidencePaths": [],
        }
        if verdict.status != "passed":
            payload["error"] = {"code": verdict.code or verdict.reason, "message": (verdict.message or verdict.reason)[:MESSAGE_LIMIT]}
        self.protocol.emit("step.finished", payload)
        return verdict.status, verdict.reason

    def _execute(self, credentials: list[tuple[str, str, str]]) -> Outcome:
        probe = self.probe
        policy = self._prepare(credentials)
        urls = [target_url(self.base_url, path) for path in probe["startPaths"]]
        self._step("dast:spider", "spider", lambda: self._spider(urls))
        if probe["activeScan"]:
            self._step("dast:active-scan", "active scan", lambda: self._active_scan(urls, policy))
        complete = all(item.status == "passed" for item in self.outcomes)
        alerts = self._alerts()
        for risk in RISKS:
            group = alerts[risk] if alerts is not None else []
            paths = ["dast/alerts.json"] if alerts is not None and group else []
            body = self._unavailable if alerts is None else (lambda g=group, r=risk: self._risk(r, g, complete))
            self._step(f"dast:{risk}", risk, body, paths)
        for status, reason in (("failed", "assertion_mismatch"), ("inconclusive", "insufficient_evidence")):
            first = next((item for item in self.outcomes if item.status == status), None)
            if first is not None:
                return Outcome(status, reason, first.code, first.message)
        return Outcome(*PASSED)

    def _risk(self, risk: str, alerts: list[dict[str, Any]], complete: bool) -> Outcome:
        outcome = risk_outcome(risk, alerts, self.probe["failOn"])
        if outcome.status == "passed" and not alerts and not complete:
            # No alert proves nothing when the scan that should have produced it did not finish.
            return Outcome("inconclusive", "insufficient_evidence", "scan_incomplete", f"no {risk} alerts, but the scan did not complete")
        return outcome

    def _unavailable(self) -> Outcome:
        return Outcome("inconclusive", "insufficient_evidence", "zap_unavailable", "the alerts could not be read from ZAP")

    def _step(self, step_id: str, title: str, body: Callable[[], Outcome], evidence: list[str] | None = None) -> Outcome:
        index = self._index
        self._index += 1
        self.protocol.emit("step.started", {"stepId": step_id, "index": index, "title": title})
        started = time.monotonic()
        try:
            outcome = body()
        except ZapError as exc:
            outcome = Outcome("inconclusive", "insufficient_evidence", "zap_error", self.scrub.text(str(exc)))
        except Exception as exc:
            outcome = Outcome("inconclusive", "insufficient_evidence", type(exc).__name__, self.scrub.text(f"unexpected {type(exc).__name__}"))
        self.outcomes.append(outcome)
        payload: dict[str, Any] = {
            "stepId": step_id,
            "index": index,
            "title": title,
            "status": outcome.status,
            "reasonCode": outcome.reason,
            "durationMs": max(0, round((time.monotonic() - started) * 1000)),
            "evidencePaths": evidence or [],
        }
        if outcome.status != "passed":
            payload["error"] = {"code": outcome.code or outcome.reason, "message": self.scrub.text(outcome.message or outcome.reason)[:MESSAGE_LIMIT]}
        self.protocol.emit("step.finished", payload)
        return outcome

    def _prepare(self, credentials: list[tuple[str, str, str]]) -> str:
        api = self.api
        api.call("network", "action", "setHttpProxy", host=UPSTREAM_PROXY[0], port=UPSTREAM_PROXY[1])
        api.call("network", "action", "setHttpProxyEnabled", enabled=True)
        # The scan runs until ZAP finishes it; only the spider's duration is bounded, as the operator named it.
        api.call("ascan", "action", "setOptionMaxScanDurationInMins", Integer=0)
        api.call("ascan", "action", "setOptionMaxRuleDurationInMins", Integer=0)
        api.call("spider", "action", "setOptionMaxDuration", Integer=self.probe["spider"]["maxDurationMinutes"])
        for number, (header, _ref, value) in enumerate(credentials, 1):
            api.call("replacer", "action", "addRule", description=f"testmaster-credential-{number}", enabled=True,
                     matchType="REQ_HEADER", matchRegex=False, matchString=header, replacement=value, initiators="")
        if self.probe["policy"] == "api-minimal":
            return self._api_minimal_policy()
        return DEFAULT_POLICY

    def _api_minimal_policy(self) -> str:
        """Only the injection and traversal rules an HTTP API can answer; every other scanner is disabled."""
        api = self.api
        api.call("ascan", "action", "addScanPolicy", scanPolicyName=API_MINIMAL_POLICY)
        api.call("ascan", "action", "disableAllScanners", scanPolicyName=API_MINIMAL_POLICY)
        api.call("ascan", "action", "enableScanners", ids=",".join(str(rule) for rule in API_MINIMAL_RULES), scanPolicyName=API_MINIMAL_POLICY)
        return API_MINIMAL_POLICY

    def _wait(self, component: str, scan: str) -> None:
        while True:
            status = self.api.call(component, "view", "status", scanId=scan)["status"]
            if int(status) >= 100:
                return
            self.sleep(POLL_SECONDS)

    def _spider(self, urls: list[str]) -> Outcome:
        found: set[str] = set()
        for url in urls:
            self.api.call("core", "action", "accessUrl", url=url, followRedirects=True)
            scan = self.api.call("spider", "action", "scan", url=url, maxChildren=self.probe["spider"]["maxChildren"], recurse=True, subtreeOnly=True)["scan"]
            self._wait("spider", scan)
            found.update(self.api.call("spider", "view", "results", scanId=scan)["results"])
        if not found:
            return Outcome("inconclusive", "insufficient_evidence", "spider_empty", "the spider found no URL under the start paths")
        return Outcome(*PASSED)

    def _active_scan(self, urls: list[str], policy: str) -> Outcome:
        for url in urls:
            scan = self.api.call("ascan", "action", "scan", url=url, recurse=True, inScopeOnly=False, scanPolicyName=policy)["scan"]
            self._wait("ascan", scan)
        return Outcome(*PASSED)

    def _alerts(self) -> dict[str, list[dict[str, Any]]] | None:
        """Waits for passive scanning, stores both artifacts and returns the alerts by risk; None when ZAP cannot be read."""
        try:
            while int(self.api.call("pscan", "view", "recordsToScan")["recordsToScan"]) > 0:
                self.sleep(POLL_SECONDS)
            raw: list[dict[str, Any]] = []
            while True:
                page = self.api.call("core", "view", "alerts", baseurl=self.base_url, start=len(raw), count=ALERT_PAGE)["alerts"]
                raw.extend(page)
                if len(page) < ALERT_PAGE:
                    break
            alerts = sorted((normalize_alert(item, self.scrub) for item in raw),
                            key=lambda a: (risk_rank(a["risk"]), a["pluginId"], a["url"], a["param"], a["method"]))
            self._store_alerts(alerts)
            self._store_report()
        except ZapError:
            return None
        return group_alerts(alerts)

    def _store_alerts(self, alerts: list[dict[str, Any]]) -> None:
        target = self.work / "alerts.json"
        text = json.dumps(alerts, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        self._publish(target, text, "dast/alerts.json", "dast-alerts")

    def _store_report(self) -> None:
        directory = self.work / "report"
        directory.mkdir(exist_ok=True)
        self.api.call("reports", "action", "generate", title="TestMaster DAST", template="traditional-json", reportDir=str(directory), reportFileName="report")
        text = (directory / "report.json").read_text(encoding="utf-8")
        self._publish(self.work / "report.json", self.scrub.text(text), "dast/report.json", "dast-report")

    def _publish(self, target: Path, text: str, relative: str, kind: str) -> None:
        if self.scrub.leaked(text):
            raise RuntimeError(f"a secret value reached {relative}; refusing to publish it")
        target.write_text(text, encoding="utf-8")
        self.protocol.artifact(target, relative, kind, "application/json")


class ZapProcess:
    """The ZAP daemon: loopback only, random API key, state under /tmp, no update or call-home traffic."""

    def __init__(self, work: Path, key: str) -> None:
        self.work = work
        self.key = key
        self.process: subprocess.Popen[bytes] | None = None
        self.log: Any = None

    def start(self) -> None:
        Path(os.environ.get("HOME", "/tmp/home")).mkdir(parents=True, exist_ok=True)
        config = self.work / "zap.properties"
        descriptor = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(f"api.key={self.key}\napi.disablekey=false\nstart.checkForUpdates=false\n")
        self.log = open(self.work / "zap.log", "wb")
        self.process = subprocess.Popen(
            [ZAP_LAUNCHER, ZAP_HEAP, "-daemon", "-silent", "-host", ZAP_HOST, "-port", str(ZAP_PORT),
             "-dir", str(self.work / "home"), "-configfile", str(config)],
            stdin=subprocess.DEVNULL, stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)

    def wait_ready(self, api: ZapApi, sleep: Callable[[float], None] = time.sleep) -> None:
        assert self.process is not None
        while True:
            if self.process.poll() is not None:
                raise ZapError(f"ZAP exited with status {self.process.returncode} while starting: {self.tail()}")
            try:
                api.call("core", "view", "version")
                return
            except ZapError:
                sleep(POLL_SECONDS)

    def tail(self) -> str:
        try:
            return (self.work / "zap.log").read_text(encoding="utf-8", errors="replace")[-1500:]
        except OSError:
            return ""

    def stop(self, api: ZapApi | None = None) -> None:
        process = self.process
        if process is None or process.poll() is not None:
            return
        if api is None:
            process.terminate()
        else:
            try:
                api.call("core", "action", "shutdown")
            except ZapError:
                process.terminate()
        try:
            process.wait(10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=None)
    args = parser.parse_args(argv)
    try:
        return _run(args.input)
    except Exception as exc:
        print(f"testmaster dast adapter blocked: {exc}", file=sys.stderr)
        return 9


def _run(input_path: str | None) -> int:
    from testmaster_runner.forwarder import Forwarder
    from testmaster_runner.protocol import ProtocolClient, ProtocolError, load_input

    data = load_input(input_path)
    protocol = ProtocolClient(data["attemptId"], data["nonce"])
    stop = threading.Event()
    key = secrets.token_hex(16)
    api = ZapApi(key)
    zap: ZapProcess | None = None

    def terminate(outcome: str, reason: str, exit_code: int) -> None:
        if not stop.is_set():
            try:
                if zap is not None:
                    zap.stop()
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
                if event.get("type") == "secret.value":
                    protocol.deliver_secret(event.get("payload") or {})
        except (OSError, ValueError, ProtocolError):
            if not stop.is_set():
                os._exit(1)

    threading.Thread(target=listen, daemon=True).start()
    forwarder = None
    work = Path(tempfile.mkdtemp(prefix="dast-", dir=WORK_ROOT))
    try:
        forwarder = Forwarder()
        credentials: list[tuple[str, str, str]] = []
        for credential in data["probe"].get("credentials") or []:
            credentials.append((credential["header"], credential["secretRef"], protocol.secret(credential["secretRef"], credential["secretVersion"])))
        scrub = Scrubber([(ref, value) for _, ref, value in credentials])
        zap = ZapProcess(work, key)
        zap.start()
        try:
            zap.wait_ready(api)
        except ZapError as exc:
            protocol.emit("log", {"level": "error", "message": f"zap_unavailable: {exc}"[:8000]})
            protocol.emit("step.started", {"stepId": AGGREGATE_STEP, "index": AGGREGATE_INDEX, "title": AGGREGATE_STEP})
            protocol.emit("step.finished", {"stepId": AGGREGATE_STEP, "index": AGGREGATE_INDEX, "title": AGGREGATE_STEP, "status": "inconclusive",
                                            "reasonCode": "insufficient_evidence", "durationMs": 0, "evidencePaths": [],
                                            "error": {"code": "zap_unavailable", "message": "the ZAP daemon did not start"}})
            outcome, reason = "inconclusive", "insufficient_evidence"
        else:
            outcome, reason = Runner(data, protocol, api, scrub, work).run(credentials)
        protocol.emit("runner.finished", {"outcome": outcome, "reasonCode": reason, "cleanupOutcome": "not_required"})
        return 0 if outcome == "passed" else 1
    except ProtocolError as exc:
        protocol.emit("log", {"level": "error", "message": str(exc)[:8000]})
        protocol.emit("runner.finished", {"outcome": "inconclusive", "reasonCode": "insufficient_evidence"})
        return 1
    finally:
        stop.set()
        if zap is not None:
            zap.stop(api)
        if forwarder:
            forwarder.close()
        protocol.close()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
