"""Property-based API testing with Schemathesis and Hypothesis (M5-05).

Each selected operation becomes one protocol step. A failing step stores the minimized example as
`property/<n>-reproduction.json` and as an HTTP `ExecutablePlan` (`property/<n>-replay.plan.json`)
that reproduces the failure without a model. Secret values reach the target only as request
headers; every string written to an event, artifact or log is redacted first.
"""
from __future__ import annotations

import json
import re
import shutil
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, unquote, urlsplit

from .protocol import ProtocolError

try:
    import hypothesis
    import requests
    import schemathesis
    from hypothesis import HealthCheck, Phase, Verbosity
    from schemathesis import checks as st_checks
    from schemathesis.core.errors import SchemathesisError
    from schemathesis.core.failures import Failure, FailureGroup
    from schemathesis.core.result import Err
    from schemathesis.core.transport import status_code_matches

    _IMPORT_ERROR: Exception | None = None
except ImportError as exc:  # pragma: no cover - exercised only in an image without the packages
    _IMPORT_ERROR = exc

CHECK_ORDER = (
    "not_a_server_error",
    "status_code_conformance",
    "content_type_conformance",
    "response_schema_conformance",
    "ignored_auth",
)
PLAN_METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"})
HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
MESSAGE_LIMIT = 2000
STATEFUL_STEP = "property:stateful"
AGGREGATE_STEP = "property"
AGGREGATE_INDEX = 1000000
STATEFUL_STEP_COUNT = 10


class _Failed(AssertionError):
    """Raised inside a Hypothesis test body so the example is shrunk; one raise site keeps one bug."""


@dataclass
class Sent:
    """One request as it went on the wire, secrets already replaced by markers."""

    method: str
    segments: list[str]
    query: list[tuple[str, str]]
    headers: dict[str, Any]
    body: dict[str, Any] | None
    status: int
    content_type: str | None
    template: str
    operation: str


@dataclass
class Finding:
    check: str
    message: str
    requests: list[Sent]


@dataclass
class Outcome:
    status: str  # passed | failed | blocked | inconclusive
    reason: str
    check: str | None = None
    message: str | None = None
    finding: Finding | None = None


@dataclass
class Context:
    protocol: Any
    spec: dict[str, Any]
    seed: int
    base_url: str
    raw: dict[str, Any]
    checks: list[str]
    session: Any = None
    credentials: list[tuple[str, str, str]] = field(default_factory=list)  # (header, secretRef, value)
    failures: int = 0
    tmp: Path | None = None
    prefix: str = ""  # path of the environment base URL, stripped from sent paths

    @property
    def credential_headers(self) -> dict[str, str]:
        return {header: value for header, _, value in self.credentials}

    def redact(self, value: Any) -> Any:
        if isinstance(value, str):
            for _, ref, secret in self.credentials:
                if secret:
                    value = value.replace(secret, f"[secret:{ref}]")
            return value
        if isinstance(value, list):
            return [self.redact(item) for item in value]
        if isinstance(value, dict):
            return {self.redact(key): self.redact(item) for key, item in value.items()}
        return value

    def marker(self, header: str) -> dict[str, str] | None:
        for name, ref, _ in self.credentials:
            if name.lower() == header.lower():
                return {"secretRef": ref}
        return None


def run(data: dict[str, Any], protocol: Any) -> tuple[str, str]:
    """Run the property probe described by `data["property"]`; returns (outcome, reasonCode).

    One aggregate `property` step wraps the per-operation steps, like `imported-code` wraps pytest.
    """
    protocol.emit("step.started", {"stepId": AGGREGATE_STEP, "index": AGGREGATE_INDEX, "title": AGGREGATE_STEP})
    started = time.monotonic()
    try:
        verdict = _execute(data, protocol)
    except ProtocolError as exc:
        verdict = Outcome("inconclusive", "insufficient_evidence", "protocol_error", str(exc))
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
        payload["error"] = {"code": verdict.check or verdict.reason, "message": (verdict.message or verdict.reason)[:MESSAGE_LIMIT]}
    protocol.emit("step.finished", payload)
    return verdict.status, verdict.reason


def _execute(data: dict[str, Any], protocol: Any) -> Outcome:
    if _IMPORT_ERROR is not None:
        message = f"{type(_IMPORT_ERROR).__name__}: {_IMPORT_ERROR}"
        protocol.emit("log", {"level": "error", "message": f"property_dependency_missing: {message}"})
        return Outcome("blocked", "property_dependency_missing", "property_dependency_missing", message)
    spec = data["property"]
    seed = int(data.get("seed") or 0)
    try:
        schema = _load_schema(spec)
        schema.config.update(base_url=data["baseUrl"])
        operations = _select_operations(schema, spec)
    except Exception as exc:
        message = f"{type(exc).__name__}: {str(exc)[:MESSAGE_LIMIT]}"
        protocol.emit("log", {"level": "error", "message": f"property_schema_invalid: {message}"})
        return Outcome("blocked", "property_schema_invalid", "property_schema_invalid", message)
    graphql = spec["api"] == "graphql"
    wanted = spec.get("checks") or list(CHECK_ORDER)
    checks = [name for name in CHECK_ORDER if name in wanted]
    if graphql:
        checks = ["not_a_server_error"]
    base_url = data["baseUrl"]
    if graphql and urlsplit(base_url).path in ("", "/"):
        # Schemathesis posts GraphQL operations to `base_url` itself. An environment origin without a
        # path means the conventional `/graphql` endpoint; a base URL that has a path already is the endpoint.
        base_url = base_url.rstrip("/") + "/graphql"
    context = Context(protocol, spec, seed, base_url, {} if graphql else schema.raw_schema, checks)
    context.prefix = urlsplit(data["baseUrl"]).path.rstrip("/")
    context.tmp = Path(tempfile.mkdtemp(prefix="property-"))
    context.session = requests.Session()
    try:
        for credential in spec.get("credentials") or []:
            value = protocol.secret(credential["secretRef"], credential["secretVersion"])
            context.credentials.append((credential["header"], credential["secretRef"], value))
        results = []
        index = 0
        for operation in operations:
            results.append(_run_step(context, index, f"property:{_label(operation, graphql)}", lambda op=operation: _test_operation(context, op)))
            index += 1
        if spec.get("stateful") and not graphql:
            results.append(_run_step(context, index, STATEFUL_STEP, lambda: _test_stateful(context, schema)))
    finally:
        context.session.close()
        shutil.rmtree(context.tmp, ignore_errors=True)
    for status, reason in (("failed", "assertion_mismatch"), ("blocked", "property_schema_invalid"), ("inconclusive", "insufficient_evidence")):
        first = next((result for result in results if result.status == status), None)
        if first is not None:
            return Outcome(status, reason, first.check, first.message)
    return Outcome("passed", "assertions_satisfied")


def _load_schema(spec: dict[str, Any]) -> Any:
    path = spec["schemaPath"]
    if spec["api"] == "graphql":
        return schemathesis.graphql.from_path(path)
    return schemathesis.openapi.from_path(path)


def _label(operation: Any, graphql: bool) -> str:
    return operation.definition.field_name if graphql else operation.label


def _select_operations(schema: Any, spec: dict[str, Any]) -> list[Any]:
    graphql = spec["api"] == "graphql"
    found = []
    for result in schema.get_all_operations():
        if isinstance(result, Err):
            raise result.err()
        found.append(result.ok())
    selected = spec.get("operations") or []
    if not selected:
        if not found:
            raise ValueError("the schema declares no operations")
        return found
    chosen = []
    for name in selected:
        wanted = name.strip()
        if not graphql and " " in wanted:
            method, path = wanted.split(" ", 1)
            wanted = f"{method.upper()} {path.strip()}"
        match = next((op for op in found if _label(op, graphql) == wanted or op.label == wanted), None)
        if match is None:
            raise ValueError(f"operation {name!r} is not declared by the schema")
        chosen.append(match)
    return chosen


def _run_step(context: Context, index: int, step_id: str, body: Any) -> Outcome:
    protocol = context.protocol
    step_id = step_id if len(step_id) <= 200 else f"{step_id[:190]}~{index}"
    title = step_id[len("property:"):][:500]
    protocol.emit("step.started", {"stepId": step_id, "index": index, "title": title})
    started = time.monotonic()
    try:
        outcome = body()
    except _Failed:
        outcome = Outcome("inconclusive", "insufficient_evidence", "flaky", "the failure did not reproduce on replay")
    except SchemathesisError as exc:
        outcome = Outcome("blocked", "property_schema_invalid", type(exc).__name__, str(exc))
    except Exception as exc:
        outcome = Outcome("inconclusive", "insufficient_evidence", type(exc).__name__, str(exc))
    payload: dict[str, Any] = {
        "stepId": step_id,
        "index": index,
        "title": title,
        "status": outcome.status,
        "reasonCode": outcome.reason,
        "evidencePaths": [],
    }
    if outcome.finding is not None:
        payload["evidencePaths"] = _write_finding(context, outcome.finding)
    if outcome.status != "passed":
        outcome.message = context.redact((outcome.message or outcome.reason))[:MESSAGE_LIMIT]
        payload["error"] = {"code": outcome.check or outcome.reason, "message": outcome.message}
    payload["durationMs"] = max(0, round((time.monotonic() - started) * 1000))
    protocol.emit("step.finished", payload)
    return outcome


def _settings(context: Context, **extra: Any) -> Any:
    return hypothesis.settings(
        max_examples=int(context.spec.get("maxExamples") or 100),
        database=None,
        derandomize=False,
        deadline=None,
        suppress_health_check=list(HealthCheck),
        report_multiple_bugs=False,
        phases=extra.pop("phases", [Phase.explicit, Phase.reuse, Phase.generate, Phase.target, Phase.shrink]),
        verbosity=Verbosity.quiet,
        print_blob=False,
        **extra,
    )


def _validate(context: Context, case: Any, response: Any, kwargs: dict[str, Any]) -> tuple[str, str] | None:
    """Run the resolved checks one by one so the failing check is known exactly."""
    st_checks.load_all_checks()
    headers = kwargs.get("headers")
    for name in context.checks:
        function = st_checks.CHECKS.get_one(name)
        try:
            case.validate_response(response, checks=[function], headers=headers, transport_kwargs=kwargs or None)
        except (Failure, FailureGroup, AssertionError) as exc:
            return name, _failure_message(exc)
    return None


def _failure_message(exc: BaseException) -> str:
    # `FailureGroup.__str__` embeds a curl command that carries the request headers; the
    # individual failures state the problem only.
    failures = list(exc.exceptions) if isinstance(exc, FailureGroup) else [exc]
    return "\n".join(str(failure) for failure in failures)[:MESSAGE_LIMIT]


def _call_kwargs(context: Context) -> dict[str, Any]:
    # Fresh header dict per use: schemathesis may mutate what it is given.
    kwargs: dict[str, Any] = {"base_url": context.base_url, "session": context.session}
    if context.credentials:
        kwargs["headers"] = dict(context.credential_headers)
    return kwargs


def _test_operation(context: Context, operation: Any) -> Outcome:
    strategy = operation.as_strategy()
    state: dict[str, Any] = {"finding": None, "network": None, "unmet": None}

    @hypothesis.seed(context.seed)
    @_settings(context)
    @hypothesis.given(case=strategy)
    def example(case: Any) -> None:
        if state["network"] is not None:
            return
        try:
            response = case.call(**_call_kwargs(context))
            verdict = _validate(context, case, response, _call_kwargs(context))
        except requests.RequestException as exc:
            state["network"] = f"{type(exc).__name__}: {exc}"
            return
        if verdict is not None:
            state["finding"] = Finding(verdict[0], verdict[1], [_describe(context, case, response)])
            raise _Failed(verdict[0])

    try:
        example()
    except Exception as exc:
        if state["finding"] is None:
            if isinstance(exc, hypothesis.errors.Unsatisfiable):
                return Outcome("inconclusive", "insufficient_evidence", "unsatisfiable", str(exc))
            raise
    if state["network"] is not None:
        return Outcome("inconclusive", "insufficient_evidence", "network_error", state["network"])
    finding = state["finding"]
    if finding is not None:
        return Outcome("failed", "assertion_mismatch", finding.check, finding.message, finding)
    return Outcome("passed", "assertions_satisfied")


def _test_stateful(context: Context, schema: Any) -> Outcome:
    base = schema.as_state_machine()
    state: dict[str, Any] = {"finding": None, "error": None, "sequence": [], "completed": 0}

    class Machine(base):  # type: ignore[valid-type, misc]
        def setup(self) -> None:
            state["sequence"] = []

        def teardown(self) -> None:
            state["completed"] += 1

        def step(self, input: Any) -> Any:
            try:
                return super().step(input)
            except _Failed:
                raise
            except Exception as exc:
                # Recorded before Hypothesis replays the scenario: a replay against a server whose
                # state moved on may raise `Flaky` and hide this error otherwise.
                if state["error"] is None:
                    state["error"] = exc
                raise

        def get_call_kwargs(self, case: Any) -> dict[str, Any]:
            return _call_kwargs(context)

        def after_call(self, response: Any, case: Any) -> None:
            state["sequence"].append(_describe(context, case, response))

        def validate_response(self, response: Any, case: Any, additional_checks: Any = None, **kwargs: Any) -> None:
            verdict = _validate(context, case, response, kwargs)
            if verdict is not None:
                state["finding"] = Finding(verdict[0], verdict[1], list(state["sequence"]))
                raise _Failed(verdict[0])

    hypothesis.seed(context.seed)(Machine)
    # Generation only, as Schemathesis runs state machines: the scenarios depend on server state, so
    # a shrinking or targeting replay cannot reproduce them.
    settings = _settings(context, stateful_step_count=STATEFUL_STEP_COUNT, phases=[Phase.generate])
    try:
        from schemathesis.generation.stateful import run_state_machine_as_test

        run_state_machine_as_test(Machine, settings=settings)
    except Exception as exc:
        if state["finding"] is None:
            error = state["error"]
            if isinstance(error, requests.RequestException):
                return Outcome("inconclusive", "insufficient_evidence", "network_error", f"{type(error).__name__}: {error}")
            if error is not None:
                raise error from exc
            # A replay that diverged from a run in which every check held finds nothing; the
            # scenarios that completed before it are the evidence.
            if not (_replay_diverged(exc) and state["completed"] > 0):
                raise
    finding = state["finding"]
    if finding is not None:
        return Outcome("failed", "assertion_mismatch", finding.check, finding.message, finding)
    if state["completed"] == 0:
        return Outcome("inconclusive", "insufficient_evidence", "no_scenarios", "no stateful scenario completed")
    return Outcome("passed", "assertions_satisfied")


def _replay_diverged(exc: BaseException) -> bool:
    """Hypothesis's own signal that a replay drew differently from the run it repeats."""
    if isinstance(exc, hypothesis.errors.Flaky):
        return True
    if not isinstance(exc, AssertionError):
        return False
    trace = exc.__traceback__
    while trace is not None and trace.tb_next is not None:
        trace = trace.tb_next
    return trace is not None and trace.tb_frame.f_globals.get("__name__") == "hypothesis.internal.conjecture.datatree"


def _describe(context: Context, case: Any, response: Any) -> Sent:
    request = response.request
    url = urlsplit(request.url)
    prefix = context.prefix
    path = url.path[len(prefix):] if prefix and url.path.startswith(prefix) else url.path
    segments = [unquote(part) for part in path.split("/")[1:]]
    while len(segments) > 1 and segments[-1] == "":
        segments.pop()
    generated = {name.lower() for name in case.headers} | {"cookie", "content-type"}
    credential = {name.lower() for name in context.credential_headers}
    headers: dict[str, Any] = {}
    for name, value in request.headers.items():
        lowered = name.lower()
        if lowered in credential:
            marker = context.marker(name)
            if marker is not None:
                headers[name] = marker
        elif lowered in generated and HEADER_NAME.match(name) and not lowered.startswith("x-schemathesis"):
            headers[name] = context.redact(value if isinstance(value, str) else value.decode("latin-1"))
    content_type = request.headers.get("Content-Type")
    return Sent(
        method=request.method.upper(),
        segments=context.redact(segments),
        query=[(context.redact(k), context.redact(v)) for k, v in parse_qsl(url.query, keep_blank_values=True)],
        headers=headers,
        body=_body(context, request.body, content_type),
        status=response.status_code,
        content_type=(response.headers.get("content-type") or [None])[0],
        template=case.operation.path,
        operation=case.operation.label,
    )


def _body(context: Context, raw: Any, content_type: str | None) -> dict[str, Any] | None:
    if raw is None or raw == b"" or raw == "":
        return None
    text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
    media = (content_type or "").split(";")[0].strip().lower()
    if media.endswith("json"):
        try:
            return {"kind": "json", "value": context.redact(json.loads(text))}
        except ValueError:
            pass
    if media == "application/x-www-form-urlencoded":
        return {"kind": "form", "fields": [[context.redact(k), context.redact(v)] for k, v in parse_qsl(text, keep_blank_values=True)]}
    return {"kind": "text", "value": context.redact(text)}


def _write_finding(context: Context, finding: Finding) -> list[str]:
    context.failures += 1
    number = context.failures
    last = finding.requests[-1]
    paths = []
    reproduction = {
        "operation": last.operation,
        "method": last.method,
        "path": "/" + "/".join(last.segments),
        "query": [{"name": name, "value": value} for name, value in last.query],
        "headers": last.headers,
        "body": last.body,
        "check": finding.check,
        "message": context.redact(finding.message),
        "seed": context.seed,
    }
    if len(finding.requests) > 1:
        reproduction["sequence"] = [_request_record(request) for request in finding.requests]
    paths.append(_write_json(context, f"property/{number}-reproduction.json", "property-reproduction", reproduction))
    plan = _replay_plan(context, finding)
    if plan is not None:
        paths.append(_write_json(context, f"property/{number}-replay.plan.json", "replay-plan", plan))
    return paths


def _request_record(sent: Sent) -> dict[str, Any]:
    return {
        "operation": sent.operation,
        "method": sent.method,
        "path": "/" + "/".join(sent.segments),
        "query": [{"name": name, "value": value} for name, value in sent.query],
        "headers": sent.headers,
        "body": sent.body,
        "status": sent.status,
    }


def _write_json(context: Context, relative: str, kind: str, value: dict[str, Any]) -> str:
    text = json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False)
    for _, ref, secret in context.credentials:
        if secret and secret in text:
            raise RuntimeError(f"a secret value reached {relative}; refusing to publish it ({ref})")
    assert context.tmp is not None
    target = context.tmp / relative.replace("/", "_")
    target.write_text(text + "\n", encoding="utf-8")
    context.protocol.artifact(target, relative, kind, "application/json")
    return relative


def _replay_plan(context: Context, finding: Finding) -> dict[str, Any] | None:
    if any(sent.method not in PLAN_METHODS for sent in finding.requests):
        return None
    last = finding.requests[-1]
    strip_auth = finding.check == "ignored_auth"
    steps: list[dict[str, Any]] = []
    for position, sent in enumerate(finding.requests):
        step_id = "request" if len(finding.requests) == 1 else f"request_{position + 1}"
        steps.append({
            "id": step_id,
            "kind": "action",
            "operation": "request",
            "description": f"{sent.method} /{'/'.join(sent.segments)}"[:500],
            "input": _request_input(context, sent, strip_auth),
        })
    expectation, description = _expectation(context, finding, last)
    steps.append({
        "id": "check",
        "kind": "assertion",
        "operation": "assert",
        "description": description,
        "input": {"responseStepId": steps[-1]["id"]},
        "expectation": expectation,
    })
    return {
        "schemaVersion": "1.0.0",
        "kind": "executable",
        "name": f"Property reproduction: {last.operation}"[:200],
        "type": "backend",
        "runner": "http",
        "requirementRefs": [],
        "steps": steps,
    }


def _request_input(context: Context, sent: Sent, strip_auth: bool) -> dict[str, Any]:
    value: dict[str, Any] = {"method": sent.method, "pathSegments": [{"literal": part} for part in sent.segments]}
    if sent.query:
        value["query"] = [{"name": {"literal": name}, "value": {"literal": item}} for name, item in sent.query]
    headers: dict[str, Any] = {}
    for name, header in sent.headers.items():
        if isinstance(header, dict):
            if not strip_auth:
                headers[name] = header
        else:
            headers[name] = {"literal": header}
    if not strip_auth:
        for name, ref, _ in context.credentials:
            headers.setdefault(name, {"secretRef": ref})
    if sent.body is not None:
        if sent.body["kind"] == "form":
            value["body"] = {"kind": "form", "fields": [{"name": {"literal": k}, "value": {"literal": v}} for k, v in sent.body["fields"]]}
        else:
            value["body"] = {"kind": sent.body["kind"], "value": {"literal": sent.body["value"]}}
    if headers:
        value["headers"] = headers
    return value


def _expectation(context: Context, finding: Finding, sent: Sent) -> tuple[dict[str, Any], str]:
    check = finding.check
    if check == "ignored_auth":
        return {"predicate": "statusIn", "values": [401, 403]}, "The operation refuses a request without credentials"
    if check == "response_schema_conformance" and context.spec["api"] == "openapi":
        pointer = _schema_pointer(context.raw, sent)
        if pointer is not None:
            return (
                {"predicate": "jsonSchema", "sourceRevisionId": context.spec["sourceRevisionId"], "pointer": pointer},
                "The response conforms to the documented schema",
            )
    if check == "content_type_conformance" and context.spec["api"] == "openapi":
        media = _documented_media(context.raw, sent)
        if media:
            pattern = "^(?:" + "|".join(_js_escape(item) for item in media) + ")(?:;|$)"
            return {"predicate": "headerMatches", "header": "Content-Type", "pattern": pattern}, "The response media type is documented"
    return (
        {"predicate": "statusIn", "values": _documented_statuses(context, sent, check == "not_a_server_error")},
        "The response status is documented",
    )


def _js_escape(text: str) -> str:
    return re.sub(r"([.*+?^${}()|\[\]\\])", r"\\\1", text)


def _documented_statuses(context: Context, sent: Sent, without_server_errors: bool) -> list[int]:
    codes: set[int] = set()
    if context.spec["api"] == "openapi":
        for key in _responses(context.raw, sent):
            if key.isdigit():
                codes.add(int(key))
            elif re.fullmatch(r"[1-5][xX]{2}", key):
                codes.update(range(int(key[0]) * 100, int(key[0]) * 100 + 100))
    if without_server_errors:
        codes = {code for code in codes if code < 500}
    return sorted(codes) or [200]


def _operation_node(raw: dict[str, Any], sent: Sent) -> tuple[dict[str, Any], list[str]] | None:
    method = sent.operation.split(" ", 1)[0].lower()
    item = (raw.get("paths") or {}).get(sent.template)
    node = item.get(method) if isinstance(item, dict) else None
    if not isinstance(node, dict):
        return None
    return node, ["paths", sent.template, method]


def _responses(raw: dict[str, Any], sent: Sent) -> dict[str, Any]:
    found = _operation_node(raw, sent)
    responses = found[0].get("responses") if found else None
    return responses if isinstance(responses, dict) else {}


def _response_entry(raw: dict[str, Any], sent: Sent) -> tuple[dict[str, Any], list[str]] | None:
    found = _operation_node(raw, sent)
    if found is None:
        return None
    node, parts = found
    responses = node.get("responses")
    if not isinstance(responses, dict):
        return None
    code = str(sent.status)
    key = next((name for name in responses if name == code), None) \
        or next((name for name in responses if name.upper() == f"{code[0]}XX"), None) \
        or ("default" if "default" in responses else None)
    if key is None:
        return None
    entry: Any = responses[key]
    parts = [*parts, "responses", key]
    for _ in range(10):
        if not (isinstance(entry, dict) and isinstance(entry.get("$ref"), str) and entry["$ref"].startswith("#/")):
            break
        parts = [unquote(part).replace("~1", "/").replace("~0", "~") for part in entry["$ref"][2:].split("/")]
        entry = raw
        for part in parts:
            entry = entry.get(part) if isinstance(entry, dict) else None
    return (entry, parts) if isinstance(entry, dict) else None


def _pick_media(content: dict[str, Any], observed: str | None) -> str | None:
    base = (observed or "").split(";")[0].strip().lower()
    for candidate in (base, f"{base.split('/')[0]}/*", "*/*"):
        match = next((name for name in content if name.lower() == candidate), None)
        if match:
            return match
    if len(content) == 1:
        return next(iter(content))
    return next((name for name in content if "json" in name.lower()), None)


def _schema_pointer(raw: dict[str, Any], sent: Sent) -> str | None:
    found = _response_entry(raw, sent)
    if found is None:
        return None
    entry, parts = found
    content = entry.get("content")
    if isinstance(content, dict) and content:
        media = _pick_media(content, sent.content_type)
        if media is not None and isinstance(content[media], dict) and "schema" in content[media]:
            return _pointer([*parts, "content", media, "schema"])
        return None
    if "schema" in entry:  # Swagger 2.0
        return _pointer([*parts, "schema"])
    return None


def _documented_media(raw: dict[str, Any], sent: Sent) -> list[str]:
    found = _response_entry(raw, sent)
    content = found[0].get("content") if found else None
    return sorted(name.lower() for name in content) if isinstance(content, dict) else []


def _pointer(parts: list[str]) -> str:
    return "".join("/" + part.replace("~", "~0").replace("/", "~1") for part in parts)
