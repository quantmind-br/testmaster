import re
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import pytest

from testmaster_runner import property as property_runner

SECRET_REF = "sec_01900000-0000-7000-8000-000000000001"
SECRET_VALUE = "Bearer topsecret-property-value"
SOURCE_REVISION = "svr_01900000-0000-7000-8000-000000000002"

ITEM = {"type": "object", "required": ["id", "name"], "properties": {"id": {"type": "integer"}, "name": {"type": "string"}}}


def json_response(schema, description="ok"):
    return {"description": description, "content": {"application/json": {"schema": schema}}}


OPENAPI = {
    "openapi": "3.0.3",
    "info": {"title": "Tiny", "version": "1"},
    "components": {"securitySchemes": {"key": {"type": "apiKey", "in": "header", "name": "Authorization"}}},
    "paths": {
        "/health": {"get": {"responses": {"200": json_response({"type": "object", "required": ["status"], "properties": {"status": {"type": "string"}}})}}},
        "/items": {
            "get": {
                "parameters": [{"name": "limit", "in": "query", "required": False, "schema": {"type": "integer"}}],
                "responses": {"200": json_response({"type": "array", "items": ITEM}), "400": {"description": "bad"}},
            }
        },
        "/shape": {"get": {"responses": {"200": json_response(ITEM)}}},
        "/status": {"get": {"responses": {"200": json_response({"type": "object"})}}},
        "/secure": {"get": {"security": [{"key": []}], "responses": {"200": json_response({"type": "object"}), "401": {"description": "no"}}}},
        "/leak": {"get": {"responses": {"200": json_response(ITEM)}}},
        "/typed": {"get": {"responses": {"200": json_response({"type": "object"})}}},
        "/search": {
            "get": {
                "parameters": [{"name": "q", "in": "query", "required": False, "schema": {"type": "string"}}],
                "responses": {"200": json_response({"type": "array", "items": ITEM})},
            }
        },
        "/things": {
            "post": {
                "requestBody": {
                    "required": True,
                    "content": {"application/json": {"schema": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string", "maxLength": 5}}, "additionalProperties": False}}},
                },
                "responses": {
                    "201": {
                        **json_response({"type": "object", "required": ["id"], "properties": {"id": {"type": "integer"}}}),
                        "links": {"get": {"operationId": "getThing", "parameters": {"thingId": "$response.body#/id"}}},
                    },
                    "422": {"description": "invalid"},
                },
            }
        },
        "/things/{thingId}": {
            "get": {
                "operationId": "getThing",
                "parameters": [{"name": "thingId", "in": "path", "required": True, "schema": {"type": "integer"}}],
                "responses": {"200": json_response({"type": "object"}), "404": {"description": "missing"}},
            }
        },
    },
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    seen_authorization: list = []
    things: dict = {}
    searches: list = []

    def log_message(self, *args):
        pass

    def reply(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        url = urlsplit(self.path)
        Handler.seen_authorization.append(self.headers.get("Authorization"))
        if url.path == "/health":
            self.reply(200, {"status": "ok"})
        elif url.path == "/items":
            limit = parse_qs(url.query).get("limit", ["1"])[0]
            try:
                number = int(limit)
            except ValueError:
                return self.reply(400, {"error": "limit"})
            if number < 0:
                return self.reply(500, {"error": "negative"})
            self.reply(200, [{"id": index, "name": "item"} for index in range(min(number, 3))])
        elif url.path == "/shape":
            self.reply(200, {"id": "not-an-integer", "name": "x"})
        elif url.path == "/status":
            self.reply(202, {})
        elif url.path == "/secure":
            self.reply(200, {})  # never checks the credential: ignored_auth
        elif url.path == "/leak":
            self.reply(200, {"id": self.headers.get("Authorization") or 1, "name": "x"})
        elif url.path == "/search":
            Handler.searches.append(url.query)
            self.reply(200, [])
        elif url.path == "/typed":
            payload = b"plain text"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        elif url.path.startswith("/things/"):
            stored = Handler.things.get(int(url.path.rsplit("/", 1)[1]))
            if stored is None:
                self.reply(404, {})
            elif stored == "":
                self.reply(500, {"error": "empty name"})  # the stateful bug: needs the created thing
            else:
                self.reply(200, {"name": stored})
        else:
            self.reply(404, {})

    def do_POST(self):
        url = urlsplit(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        try:
            document = json.loads(self.rfile.read(length) or b"null")
        except ValueError:
            return self.reply(422, {})
        if url.path == "/things" and isinstance(document, dict) and isinstance(document.get("name"), str):
            identifier = len(Handler.things) + 1
            Handler.things[identifier] = document["name"]
            self.reply(201, {"id": identifier})
        elif url.path == "/graphql" and isinstance(document, dict):
            negative = re.search(r"limit:\s*-\d+", document.get("query", ""))
            self.reply(500 if negative else 200, {"data": {"products": []}})
        else:
            self.reply(422, {})


@pytest.fixture
def server():
    Handler.seen_authorization = []
    Handler.things = {}
    Handler.searches = []
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()


class FakeProtocol:
    def __init__(self):
        self.events = []
        self.artifacts = {}
        self.secret_requests = []

    def emit(self, event_type, payload):
        self.events.append((event_type, payload))

    def artifact(self, path, relative_path, kind="file", mime_type="application/octet-stream"):
        with open(path, "rb") as stream:
            self.artifacts[relative_path] = (kind, mime_type, stream.read())

    def secret(self, secret_ref, secret_version):
        self.secret_requests.append((secret_ref, secret_version))
        return SECRET_VALUE

    def finished_steps(self):
        return {payload["stepId"]: payload for kind, payload in self.events if kind == "step.finished"}

    def everything(self):
        text = json.dumps(self.events, default=str)
        return text + b"".join(data for _, _, data in self.artifacts.values()).decode()


@pytest.fixture(autouse=True)
def no_proxy(monkeypatch):
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")


def probe(tmp_path, base_url, *, document=OPENAPI, operations=None, checks=None, credentials=None, stateful=False, max_examples=25, name="schema.json"):
    schema = tmp_path / name
    schema.write_text(document if isinstance(document, str) else json.dumps(document), encoding="utf-8")
    spec = {
        "kind": "property",
        "api": "openapi",
        "stateful": stateful,
        "maxExamples": max_examples,
        "checks": checks or ["not_a_server_error", "status_code_conformance", "content_type_conformance", "response_schema_conformance"],
        "sourceRevisionId": SOURCE_REVISION,
        "schemaPath": str(schema),
    }
    if operations is not None:
        spec["operations"] = operations
    if credentials:
        spec["credentials"] = [{"header": "Authorization", "secretRef": SECRET_REF, "secretVersion": 1}]
    return {"baseUrl": base_url, "seed": 7, "property": spec}


def execute(data):
    protocol = FakeProtocol()
    outcome = property_runner.run(data, protocol)
    return outcome, protocol


def artifact(protocol, relative):
    return json.loads(protocol.artifacts[relative][2])


def test_healthy_operations_pass_with_one_step_each(tmp_path, server):
    outcome, protocol = execute(probe(tmp_path, server, operations=["GET /health"]))
    assert outcome == ("passed", "assertions_satisfied")
    steps = protocol.finished_steps()
    assert list(steps) == ["property:GET /health", "property"]
    assert steps["property"]["status"] == "passed"
    assert (steps["property"]["index"], steps["property"]["title"]) == (1000000, "property")
    kinds = [(kind, payload["stepId"]) for kind, payload in protocol.events if kind.startswith("step.")]
    assert kinds[0] == ("step.started", "property") and kinds[-1] == ("step.finished", "property")
    assert steps["property:GET /health"]["status"] == "passed"
    assert protocol.artifacts == {}


def test_server_error_is_shrunk_and_replay_plan_lists_documented_statuses(tmp_path, server):
    outcome, protocol = execute(probe(tmp_path, server, operations=["GET /items"]))
    assert outcome == ("failed", "assertion_mismatch")
    step = protocol.finished_steps()["property:GET /items"]
    assert step["status"] == "failed"
    assert step["error"]["code"] == "not_a_server_error"
    aggregate = protocol.finished_steps()["property"]
    assert (aggregate["status"], aggregate["reasonCode"], aggregate["error"]["code"]) == ("failed", "assertion_mismatch", "not_a_server_error")
    assert step["evidencePaths"] == ["property/1-reproduction.json", "property/1-replay.plan.json"]
    reproduction = artifact(protocol, "property/1-reproduction.json")
    assert (reproduction["method"], reproduction["path"], reproduction["check"], reproduction["seed"]) == ("GET", "/items", "not_a_server_error", 7)
    assert reproduction["query"] == [{"name": "limit", "value": "-1"}]
    plan = artifact(protocol, "property/1-replay.plan.json")
    assert (plan["schemaVersion"], plan["kind"], plan["type"], plan["runner"], plan["requirementRefs"]) == ("1.0.0", "executable", "backend", "http", [])
    request, check = plan["steps"]
    assert request["input"]["method"] == "GET"
    assert request["input"]["pathSegments"] == [{"literal": "items"}]
    assert request["input"]["query"] == [{"name": {"literal": "limit"}, "value": {"literal": "-1"}}]
    assert check["input"] == {"responseStepId": request["id"]}
    assert check["expectation"] == {"predicate": "statusIn", "values": [200, 400]}
    assert protocol.artifacts["property/1-reproduction.json"][:2] == ("property-reproduction", "application/json")
    assert protocol.artifacts["property/1-replay.plan.json"][:2] == ("replay-plan", "application/json")


def test_undocumented_status_yields_status_conformance_plan(tmp_path, server):
    outcome, protocol = execute(probe(tmp_path, server, operations=["GET /status"], checks=["status_code_conformance"]))
    assert outcome == ("failed", "assertion_mismatch")
    plan = artifact(protocol, "property/1-replay.plan.json")
    assert plan["steps"][-1]["expectation"] == {"predicate": "statusIn", "values": [200]}
    assert artifact(protocol, "property/1-reproduction.json")["check"] == "status_code_conformance"


def test_response_schema_failure_points_at_the_source_document_schema(tmp_path, server):
    outcome, protocol = execute(probe(tmp_path, server, operations=["GET /shape"], checks=["response_schema_conformance"]))
    assert outcome == ("failed", "assertion_mismatch")
    plan = artifact(protocol, "property/1-replay.plan.json")
    assert plan["steps"][-1]["expectation"] == {
        "predicate": "jsonSchema",
        "sourceRevisionId": SOURCE_REVISION,
        "pointer": "/paths/~1shape/get/responses/200/content/application~1json/schema",
    }


def test_ignored_auth_replays_without_credentials_and_never_leaks_the_secret(tmp_path, server):
    data = probe(tmp_path, server, operations=["GET /secure"], checks=["ignored_auth"], credentials=True)
    outcome, protocol = execute(data)
    assert outcome == ("failed", "assertion_mismatch")
    assert protocol.secret_requests == [(SECRET_REF, 1)]
    assert SECRET_VALUE in Handler.seen_authorization
    reproduction = artifact(protocol, "property/1-reproduction.json")
    assert reproduction["check"] == "ignored_auth"
    assert reproduction["headers"] == {"Authorization": {"secretRef": SECRET_REF}}
    plan = artifact(protocol, "property/1-replay.plan.json")
    request, check = plan["steps"]
    assert "headers" not in request["input"]
    assert check["expectation"] == {"predicate": "statusIn", "values": [401, 403]}
    assert "topsecret" not in protocol.everything()


def test_credentials_in_a_replay_plan_are_secret_references(tmp_path, server):
    data = probe(tmp_path, server, operations=["GET /items"], credentials=True)
    outcome, protocol = execute(data)
    assert outcome == ("failed", "assertion_mismatch")
    plan = artifact(protocol, "property/1-replay.plan.json")
    assert plan["steps"][0]["input"]["headers"] == {"Authorization": {"secretRef": SECRET_REF}}
    reproduction = artifact(protocol, "property/1-reproduction.json")
    assert reproduction["headers"] == {"Authorization": {"secretRef": SECRET_REF}}
    assert "topsecret" not in protocol.everything()
    assert SECRET_VALUE not in protocol.everything()


def test_invalid_schema_blocks_the_run(tmp_path, server):
    outcome, protocol = execute(probe(tmp_path, server, document="{ not json", name="broken.json"))
    assert outcome == ("blocked", "property_schema_invalid")
    steps = protocol.finished_steps()
    assert list(steps) == ["property"]
    assert steps["property"]["status"] == "blocked"
    assert steps["property"]["reasonCode"] == "property_schema_invalid"


def test_missing_dependencies_block_with_an_aggregate_step(tmp_path, server, monkeypatch):
    monkeypatch.setattr(property_runner, "_IMPORT_ERROR", ImportError("no schemathesis"))
    outcome, protocol = execute(probe(tmp_path, server))
    assert outcome == ("blocked", "property_dependency_missing")
    assert protocol.finished_steps()["property"]["reasonCode"] == "property_dependency_missing"
    assert protocol.secret_requests == []

def test_unknown_operation_blocks_the_run(tmp_path, server):
    outcome, _ = execute(probe(tmp_path, server, operations=["GET /missing"]))
    assert outcome == ("blocked", "property_schema_invalid")


def test_content_type_failure_replays_with_a_media_type_pattern(tmp_path, server):
    outcome, protocol = execute(probe(tmp_path, server, operations=["GET /typed"], checks=["content_type_conformance"]))
    assert outcome == ("failed", "assertion_mismatch")
    assert protocol.finished_steps()["property:GET /typed"]["error"]["code"] == "content_type_conformance"
    expectation = artifact(protocol, "property/1-replay.plan.json")["steps"][-1]["expectation"]
    assert expectation["predicate"] == "headerMatches"
    assert expectation["header"] == "Content-Type"
    assert "application/json" in expectation["pattern"]


def test_request_bodies_are_minimized_and_carried_into_the_plan(tmp_path, server):
    document = json.loads(json.dumps(OPENAPI))
    document["paths"]["/things"]["post"]["responses"]["201"].pop("links")
    document["paths"]["/things"]["post"]["responses"] = {"200": {"description": "only"}}
    outcome, protocol = execute(probe(tmp_path, server, document=document, operations=["POST /things"], checks=["status_code_conformance"]))
    assert outcome == ("failed", "assertion_mismatch")
    reproduction = artifact(protocol, "property/1-reproduction.json")
    assert reproduction["body"] == {"kind": "json", "value": {"name": ""}}
    request = artifact(protocol, "property/1-replay.plan.json")["steps"][0]["input"]
    assert request["method"] == "POST"
    assert request["body"] == {"kind": "json", "value": {"literal": {"name": ""}}}
    assert request["headers"] == {"Content-Type": {"literal": "application/json"}}


def test_secret_echoed_by_the_target_is_redacted_everywhere(tmp_path, server):
    outcome, protocol = execute(probe(tmp_path, server, operations=["GET /leak"], checks=["response_schema_conformance"], credentials=True))
    assert outcome == ("failed", "assertion_mismatch")
    step = protocol.finished_steps()["property:GET /leak"]
    assert f"[secret:{SECRET_REF}]" in step["error"]["message"]
    assert "topsecret" not in protocol.everything()


def test_stateful_links_report_the_failing_sequence(tmp_path, server):
    data = probe(tmp_path, server, operations=["POST /things"], checks=["not_a_server_error"], stateful=True, max_examples=60)
    outcome, protocol = execute(data)
    assert outcome == ("failed", "assertion_mismatch")
    steps = protocol.finished_steps()
    assert steps["property:POST /things"]["status"] == "passed"
    stateful = steps["property:stateful"]
    assert stateful["status"] == "failed"
    assert stateful["evidencePaths"] == ["property/1-reproduction.json", "property/1-replay.plan.json"]
    reproduction = artifact(protocol, "property/1-reproduction.json")
    # Stateful scenarios are not shrunk (server state moves between replays): the sequence is the
    # scenario as it ran, opening with the linked POST and ending with the failing GET.
    methods = [item["method"] for item in reproduction["sequence"]]
    assert methods[0] == "POST" and methods[-1] == "GET"
    plan = artifact(protocol, "property/1-replay.plan.json")
    requests = [f"request_{n}" for n in range(1, len(methods) + 1)]
    assert [step["id"] for step in plan["steps"]] == [*requests, "check"]
    assert plan["steps"][-1]["input"] == {"responseStepId": requests[-1]}


def test_graphql_runs_the_server_error_check(tmp_path, server):
    schema = tmp_path / "schema.graphql"
    schema.write_text("type Product { id: ID! }\ntype Query { products(limit: Int): [Product!]! }\n", encoding="utf-8")
    data = {
        "baseUrl": server,
        "seed": 3,
        "property": {"kind": "property", "api": "graphql", "stateful": False, "maxExamples": 50, "checks": ["not_a_server_error"], "sourceRevisionId": SOURCE_REVISION, "schemaPath": str(schema)},
    }
    outcome, protocol = execute(data)
    assert outcome == ("failed", "assertion_mismatch")
    assert list(protocol.finished_steps()) == ["property:products", "property"]
    plan = artifact(protocol, "property/1-replay.plan.json")
    request = plan["steps"][0]["input"]
    assert request["method"] == "POST"
    assert request["pathSegments"] == [{"literal": "graphql"}]
    assert "limit: -" in request["body"]["value"]["literal"]["query"]
    assert plan["steps"][-1]["expectation"] == {"predicate": "statusIn", "values": [200]}


def test_the_input_seed_fixes_the_generated_requests(tmp_path, server):
    def sequence(seed):
        Handler.searches = []
        data = probe(tmp_path, server, operations=["GET /search"], max_examples=30)
        data["seed"] = seed
        assert execute(data)[0] == ("passed", "assertions_satisfied")
        return list(Handler.searches)

    assert sequence(7) == sequence(7)
    assert sequence(7) != sequence(8)
