from testmaster_runner.code_summary import parse_file


def routes(summary):
    return [(item["method"], item["path"], item["handler"], item["router"]) for item in summary["routes"]]


def test_factory_router_is_returned_and_routes_belong_to_its_local_scope():
    summary = parse_file(
        "from fastapi import APIRouter\n"
        "def create_auth_router():\n"
        "    router = APIRouter()\n"
        "    @router.post('/login')\n"
        "    def login(): pass\n"
        "    return router\n"
        "def create_other_router():\n"
        "    router = APIRouter(prefix='/other')\n"
        "    @router.get('/ping')\n"
        "    def ping(): pass\n"
        "    return router\n",
        "auth.py",
    )
    assert [(item["name"], item["prefix"], item["module"]) for item in summary["routers"]] == [("router", "", False), ("router", "/other", False)]
    assert routes(summary) == [("POST", "/login", "login", 0), ("GET", "/ping", "ping", 1)]
    assert [(item["name"], item["returns"]) for item in summary["functions"]] == [("create_auth_router", [0]), ("create_other_router", [1])]


def test_include_router_forms_and_prefix_constants():
    summary = parse_file(
        "from fastapi import FastAPI\n"
        "from app.routes.auth import create_auth_router\n"
        "from app.routes import sessions\n"
        "import app.routes.legacy as legacy\n"
        "API = '/v1'\n"
        "def create_app():\n"
        "    app = FastAPI()\n"
        "    app.include_router(create_auth_router(), prefix='/auth')\n"
        "    app.include_router(sessions.router, prefix=API)\n"
        "    app.include_router(legacy.router, prefix=settings.base)\n"
        "    app.include_router(legacy.other)\n"
        "    app.mount('/sub', sessions.sub_app)\n"
        "    return app\n",
        "main.py",
    )
    assert [(item["kind"], item["name"]) for item in summary["routers"]] == [("app", "app")]
    assert [(item["child"], item["prefix"]) for item in summary["includes"]] == [
        ({"name": "create_auth_router", "call": True}, "/auth"),
        ({"name": "sessions.router", "call": False}, "/v1"),
        ({"name": "legacy.router", "call": False}, None),
        ({"name": "legacy.other", "call": False}, ""),
        ({"name": "sessions.sub_app", "call": False}, "/sub"),
    ]
    assert sorted(item["local"] for item in summary["imports"]) == ["create_auth_router", "legacy", "sessions"]


def test_router_parameter_nested_router_and_router_passing_call():
    summary = parse_file(
        "from fastapi import APIRouter\n"
        "def register_events_routes(router: APIRouter, store=None):\n"
        "    event_router = APIRouter(prefix='/events')\n"
        "    @event_router.get('/{id}')\n"
        "    def read(): pass\n"
        "    @router.get('/sessions')\n"
        "    def listing(): pass\n"
        "    router.include_router(event_router)\n"
        "def create_sessions_router():\n"
        "    router = APIRouter()\n"
        "    register_events_routes(router, store=1)\n"
        "    return router\n"
        "def unrelated(router):\n"
        "    @router.get('/not-fastapi')\n"
        "    def other(): pass\n",
        "sessions.py",
    )
    assert [(item["kind"], item["name"]) for item in summary["routers"]] == [("parameter", "router"), ("router", "event_router"), ("router", "router")]
    assert routes(summary) == [("GET", "/{id}", "read", 1), ("GET", "/sessions", "listing", 0)]
    assert summary["includes"] == [{"parent": 0, "child": {"router": 1}, "prefix": "", "line": 8}]
    assert summary["calls"] == [{"callee": "register_events_routes", "arguments": [{"router": 2, "index": 0, "keyword": None}], "line": 11}]
    assert summary["functions"][0] == {"name": "register_events_routes", "parameters": ["router", "store"], "routerParameters": {"router": 0}, "returns": []}


def test_flask_routes_keep_working_and_carry_no_router():
    summary = parse_file(
        "from flask import Flask\napp = Flask(__name__)\n@app.route('/a', methods=['POST'])\ndef a(): pass\n",
        "app.py",
    )
    assert routes(summary) == [("POST", "/a", "a", None)]
    assert summary["routers"] == []
