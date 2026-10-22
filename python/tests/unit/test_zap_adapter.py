import importlib.util
import json
from pathlib import Path

import pytest

ADAPTER = Path(__file__).resolve().parents[3] / "containers" / "zap" / "adapter.py"
SPEC = importlib.util.spec_from_file_location("zap_adapter", ADAPTER)
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)

SECRET_REF = "sec_01900000-0000-7000-8000-000000000001"
SECRET_VALUE = "Bearer topsecret-dast-value"
BASE_URL = "http://shop.test:8080"


def alert(plugin, name, risk, url=f"{BASE_URL}/a", **extra):
    return {
        "pluginId": plugin, "alert": name, "risk": risk, "confidence": "Medium", "method": "GET", "url": url,
        "param": "q", "cweid": "79", "evidence": "<script>EVIDENCE</script>", "attack": "ATTACK-PAYLOAD",
        "other": "OTHER", "description": "DESCRIPTION", **extra,
    }


class FakeZap:
    """Answers the ZAP API calls the adapter makes; `calls` records every one."""

    def __init__(self, alerts=(), urls=(f"{BASE_URL}/",), statuses=(100,), report=None):
        self.alerts = list(alerts)
        self.urls = list(urls)
        self.statuses = list(statuses)
        self.report = report if report is not None else {"site": []}
        self.calls = []

    def call(self, component, kind, name, **params):
        self.calls.append((component, name, params))
        match (component, name):
            case ("spider", "scan") | ("ascan", "scan"):
                return {"scan": "1"}
            case ("spider", "status") | ("ascan", "status"):
                return {"status": str(self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0])}
            case ("spider", "results"):
                return {"results": self.urls}
            case ("pscan", "recordsToScan"):
                return {"recordsToScan": "0"}
            case ("core", "alerts"):
                return {"alerts": self.alerts[params["start"]:params["start"] + params["count"]]}
            case ("reports", "generate"):
                (Path(params["reportDir"]) / f"{params['reportFileName']}.json").write_text(json.dumps(self.report), encoding="utf-8")
                return {"generate": "ok"}
            case _:
                return {"Result": "OK"}

    def named(self, component, name):
        return [params for c, n, params in self.calls if (c, n) == (component, name)]


class FakeProtocol:
    def __init__(self):
        self.events = []
        self.artifacts = {}

    def emit(self, event_type, payload):
        self.events.append((event_type, payload))

    def artifact(self, path, relative_path, kind="file", mime_type="application/octet-stream"):
        self.artifacts[relative_path] = Path(path).read_text(encoding="utf-8")

    def finished(self):
        return {payload["stepId"]: payload for event_type, payload in self.events if event_type == "step.finished"}


def probe(**overrides):
    base = {
        "kind": "dast", "startPaths": ["/"], "spider": {"maxDurationMinutes": 3, "maxChildren": 50},
        "activeScan": True, "policy": "default", "failOn": "medium",
    }
    return {**base, **overrides}


def run(tmp_path, zap, spec, credentials=(), sleep=lambda seconds: None):
    protocol = FakeProtocol()
    scrub = adapter.Scrubber([(ref, value) for _, ref, value in credentials])
    runner = adapter.Runner({"probe": spec, "baseUrl": BASE_URL}, protocol, zap, scrub, tmp_path, sleep)
    verdict = runner.run(list(credentials))
    return verdict, protocol


def test_risks_at_or_above_fail_on_fail_the_matching_steps_and_the_aggregate(tmp_path):
    zap = FakeZap([
        alert("40012", "Cross Site Scripting (Reflected)", "High"),
        alert("10038", "Content Security Policy (CSP) Header Not Set", "Medium"),
        alert("10038", "Content Security Policy (CSP) Header Not Set", "Medium", url=f"{BASE_URL}/b"),
        alert("10020", "Missing Anti-clickjacking Header", "Low"),
    ])
    verdict, protocol = run(tmp_path, zap, probe(failOn="medium"))
    steps = protocol.finished()
    assert verdict == ("failed", "assertion_mismatch")
    assert {step_id: step["status"] for step_id, step in steps.items()} == {
        "dast:spider": "passed", "dast:active-scan": "passed", "dast:high": "failed", "dast:medium": "failed",
        "dast:low": "passed", "dast:informational": "passed", "dast": "failed",
    }
    assert steps["dast:high"]["error"] == {"code": "dast_alert", "message": "1 high alerts: Cross Site Scripting (Reflected)"}
    assert steps["dast:medium"]["error"]["message"] == "2 medium alerts: Content Security Policy (CSP) Header Not Set"
    assert steps["dast:medium"]["evidencePaths"] == ["dast/alerts.json"]
    assert steps["dast"]["reasonCode"] == "assertion_mismatch"


def test_a_higher_fail_on_lets_lower_risks_pass(tmp_path):
    zap = FakeZap([alert("10038", "Content Security Policy (CSP) Header Not Set", "Medium"), alert("10020", "Missing Anti-clickjacking Header", "Low")])
    verdict, protocol = run(tmp_path, zap, probe(failOn="high"))
    assert verdict == ("passed", "assertions_satisfied")
    assert {step["status"] for step in protocol.finished().values()} == {"passed"}


def test_the_aggregate_step_is_started_first_and_finished_last(tmp_path):
    verdict, protocol = run(tmp_path, FakeZap(), probe())
    assert verdict == ("passed", "assertions_satisfied")
    sequence = [(event_type, payload["stepId"]) for event_type, payload in protocol.events]
    assert sequence[0] == ("step.started", "dast")
    assert sequence[-1] == ("step.finished", "dast")
    finished = [step_id for event_type, step_id in sequence if event_type == "step.finished"]
    assert finished == ["dast:spider", "dast:active-scan", "dast:high", "dast:medium", "dast:low", "dast:informational", "dast"]
    assert sorted(protocol.artifacts) == ["dast/alerts.json", "dast/report.json"]


def test_without_an_active_scan_no_active_scan_step_runs(tmp_path):
    zap = FakeZap()
    verdict, protocol = run(tmp_path, zap, probe(activeScan=False))
    assert "dast:active-scan" not in protocol.finished()
    assert zap.named("ascan", "scan") == []
    assert verdict == ("passed", "assertions_satisfied")


def test_the_default_policy_scans_with_zaps_default_policy(tmp_path):
    zap = FakeZap()
    run(tmp_path, zap, probe(policy="default"))
    assert [call["scanPolicyName"] for call in zap.named("ascan", "scan")] == ["Default Policy"]
    assert zap.named("ascan", "addScanPolicy") == []


def test_api_minimal_enables_only_the_injection_and_traversal_rules(tmp_path):
    zap = FakeZap()
    run(tmp_path, zap, probe(policy="api-minimal"))
    policy = adapter.API_MINIMAL_POLICY
    assert zap.named("ascan", "addScanPolicy") == [{"scanPolicyName": policy}]
    assert zap.named("ascan", "disableAllScanners") == [{"scanPolicyName": policy}]
    enabled = zap.named("ascan", "enableScanners")
    assert len(enabled) == 1 and enabled[0]["scanPolicyName"] == policy
    assert sorted(int(rule) for rule in enabled[0]["ids"].split(",")) == sorted(adapter.API_MINIMAL_RULES)
    assert {6, 7, 20019, 40003, 40012, 40018, 90020, 90035} <= set(adapter.API_MINIMAL_RULES)
    assert [call["scanPolicyName"] for call in zap.named("ascan", "scan")] == [policy]
    names = [name for _, name, _ in zap.calls]
    assert names.index("disableAllScanners") < names.index("enableScanners") < names.index("scan")


def test_alerts_keep_only_triage_fields_and_never_a_secret(tmp_path):
    url = f"{BASE_URL}/echo?token={SECRET_VALUE.replace(' ', '%20')}"
    zap = FakeZap([alert("40012", "Cross Site Scripting (Reflected)", "High", url=url, evidence=SECRET_VALUE, attack=SECRET_VALUE)],
                  report={"site": [{"alerts": [{"evidence": SECRET_VALUE, "uri": url}]}]})
    verdict, protocol = run(tmp_path, zap, probe(), credentials=[("Authorization", SECRET_REF, SECRET_VALUE)])
    stored = json.loads(protocol.artifacts["dast/alerts.json"])
    assert stored == [{
        "confidence": "medium", "cweid": 79, "method": "GET", "name": "Cross Site Scripting (Reflected)", "param": "q",
        "pluginId": "40012", "risk": "high", "url": f"{BASE_URL}/echo?token=[secret:{SECRET_REF}]",
    }]
    everything = json.dumps(protocol.events) + protocol.artifacts["dast/alerts.json"] + protocol.artifacts["dast/report.json"]
    assert "topsecret-dast-value" not in everything
    assert "EVIDENCE" not in protocol.artifacts["dast/alerts.json"] and "ATTACK-PAYLOAD" not in protocol.artifacts["dast/alerts.json"]
    assert f"[secret:{SECRET_REF}]" in protocol.artifacts["dast/report.json"]


def test_credentials_become_request_header_replacer_rules(tmp_path):
    zap = FakeZap()
    run(tmp_path, zap, probe(), credentials=[("X-Api-Key", SECRET_REF, SECRET_VALUE)])
    rules = zap.named("replacer", "addRule")
    assert len(rules) == 1
    assert (rules[0]["matchType"], rules[0]["matchString"], rules[0]["replacement"], rules[0]["initiators"]) == ("REQ_HEADER", "X-Api-Key", SECRET_VALUE, "")
    assert SECRET_VALUE not in rules[0]["description"]


def test_a_spider_that_finds_nothing_is_inconclusive_and_proves_nothing_about_risks(tmp_path):
    verdict, protocol = run(tmp_path, FakeZap(urls=[]), probe())
    steps = protocol.finished()
    assert verdict == ("inconclusive", "insufficient_evidence")
    assert steps["dast:spider"]["status"] == "inconclusive"
    assert steps["dast:spider"]["error"]["code"] == "spider_empty"
    assert steps["dast:active-scan"]["status"] == "passed"
    assert [steps[f"dast:{risk}"]["status"] for risk in adapter.RISKS] == ["inconclusive"] * 4
    assert steps["dast"]["error"]["code"] == "spider_empty"


def test_an_alert_found_after_an_empty_spider_still_fails(tmp_path):
    zap = FakeZap([alert("40012", "Cross Site Scripting (Reflected)", "High")], urls=[])
    verdict, protocol = run(tmp_path, zap, probe())
    assert verdict == ("failed", "assertion_mismatch")
    assert protocol.finished()["dast:high"]["status"] == "failed"


def test_a_zap_failure_during_the_spider_is_inconclusive_not_a_crash(tmp_path):
    class Broken(FakeZap):
        def call(self, component, kind, name, **params):
            if (component, name) == ("spider", "scan"):
                raise adapter.ZapError("spider.scan: URL Not Found in the Scan Tree")
            return super().call(component, kind, name, **params)

    verdict, protocol = run(tmp_path, Broken(), probe())
    steps = protocol.finished()
    assert verdict == ("inconclusive", "insufficient_evidence")
    assert steps["dast:spider"]["error"]["code"] == "zap_error"
    assert steps["dast"]["status"] == "inconclusive"


def test_scans_are_polled_until_done_with_no_deadline(tmp_path):
    zap = FakeZap(statuses=[0, 10, 50, 99, 100])
    slept = []
    verdict, protocol = run(tmp_path, zap, probe(), sleep=slept.append)
    assert verdict == ("passed", "assertions_satisfied")
    assert len(zap.named("spider", "status")) == 5
    assert slept == [adapter.POLL_SECONDS] * 4
    assert zap.named("ascan", "setOptionMaxScanDurationInMins") == [{"Integer": 0}]
    assert zap.named("spider", "setOptionMaxDuration") == [{"Integer": 3}]


def test_a_secret_that_reaches_an_artifact_is_refused(tmp_path):
    protocol = FakeProtocol()
    runner = adapter.Runner({"probe": probe(), "baseUrl": BASE_URL}, protocol, FakeZap(), adapter.Scrubber([(SECRET_REF, SECRET_VALUE)]), tmp_path)
    with pytest.raises(RuntimeError, match="secret value"):
        runner._publish(tmp_path / "x.json", f'{{"value": "{SECRET_VALUE}"}}', "dast/x.json", "dast-report")
    assert protocol.artifacts == {}


def test_the_scrubber_covers_json_and_url_encoded_forms():
    scrub = adapter.Scrubber([(SECRET_REF, 'Bearer "quoted" value')])
    assert scrub.text(json.dumps({"k": 'Bearer "quoted" value'})) == f'{{"k": "[secret:{SECRET_REF}]"}}'
    assert scrub.text("a=Bearer%20%22quoted%22%20value") == f"a=[secret:{SECRET_REF}]"
