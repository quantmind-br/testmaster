"""Dependency-free code summary. User modules are parsed, never imported."""
from __future__ import annotations

import argparse
import ast
import json
import os
import stat
import sys
from pathlib import Path
from typing import Any


def _methods(call: ast.Call, default: str) -> list[str]:
    for keyword in call.keywords:
        if keyword.arg == "methods" and isinstance(keyword.value, (ast.List, ast.Tuple)):
            return [item.value.upper() for item in keyword.value.elts if isinstance(item, ast.Constant) and isinstance(item.value, str)]
    return [default]


_ROUTE_OPERATIONS = {"route", "api_route", "get", "post", "put", "patch", "delete", "options", "head"}
_FACTORIES = {
    "fastapi.FastAPI": ("fastapi", "app"),
    "fastapi.APIRouter": ("fastapi", "router"),
    "flask.Flask": ("flask", "app"),
    "flask.Blueprint": ("flask", "router"),
}
_FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)


def _dotted(node: ast.AST) -> str | None:
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name):
        return None
    parts.append(node.id)
    return ".".join(reversed(parts))


def _qualified(callee: ast.AST, imports: dict[str, str]) -> str:
    if isinstance(callee, ast.Name):
        return imports.get(callee.id, "")
    if isinstance(callee, ast.Attribute) and isinstance(callee.value, ast.Name):
        return f"{imports.get(callee.value.id, '')}.{callee.attr}"
    return ""


def _scope_nodes(body: list[ast.stmt]) -> list[ast.AST]:
    """The nodes of one scope: a nested function body is the scope of that function, not of this one."""
    found: list[ast.AST] = []
    stack: list[ast.AST] = list(reversed(body))
    while stack:
        node = stack.pop()
        found.append(node)
        if isinstance(node, ast.Lambda):
            continue
        children = [*node.decorator_list, node.args] if isinstance(node, _FUNCTIONS) else list(ast.iter_child_nodes(node))
        stack.extend(reversed(children))
    return found


class _Scope:
    def __init__(self, parent: _Scope | None, body: list[ast.stmt], function: str | None) -> None:
        self.parent = parent
        self.nodes = _scope_nodes(body)
        self.function = function
        self.definition: ast.AST | None = None
        self.router_parameters: dict[str, int] = {}
        self.bindings: dict[str, dict[str, Any]] = {}

    def bind(self, name: str, binding: dict[str, Any]) -> None:
        self.bindings[name] = {"kind": "ambiguous"} if name in self.bindings else binding

    def lookup(self, name: str) -> dict[str, Any] | None:
        scope: _Scope | None = self
        while scope is not None:
            if name in scope.bindings:
                return scope.bindings[name]
            scope = scope.parent
        return None

    def router(self, node: ast.AST) -> int | None:
        binding = self.lookup(node.id) if isinstance(node, ast.Name) else None
        return binding["id"] if binding is not None and binding["kind"] == "router" else None

    def text(self, node: ast.AST | None) -> str | None:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        binding = self.lookup(node.id) if isinstance(node, ast.Name) else None
        return binding["value"] if binding is not None and binding["kind"] == "text" else None


def _keyword(call: ast.Call, name: str) -> ast.expr | None:
    return next((item.value for item in call.keywords if item.arg == name), None)


def _is_router_annotation(annotation: ast.AST | None, imports: dict[str, str]) -> bool:
    if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
        try:
            annotation = ast.parse(annotation.value, mode="eval").body
        except SyntaxError:
            return False
    return annotation is not None and _qualified(annotation, imports) == "fastapi.APIRouter"


def _build_scopes(tree: ast.Module, imports: dict[str, str], routers: list[dict[str, Any]]) -> list[_Scope]:
    """Scopes with their bindings: FastAPI/Flask objects, string constants and APIRouter parameters.

    Router prefixes are filled in once every scope is bound, so a constant may follow its use.
    """
    top_level = {id(node) for node in tree.body}
    root = _Scope(None, tree.body, None)
    scopes = [root]
    prefixes: list[tuple[dict[str, Any], ast.Call, _Scope]] = []
    for scope in scopes:
        for node in scope.nodes:
            if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None:
                names = [target.id for target in (node.targets if isinstance(node, ast.Assign) else [node.target]) if isinstance(target, ast.Name)]
                factory = _FACTORIES.get(_qualified(node.value.func, imports)) if isinstance(node.value, ast.Call) else None
                if factory is not None:
                    for name in names:
                        if factory[0] == "flask":
                            scope.bind(name, {"kind": "flask"})
                            continue
                        router = {"id": len(routers), "kind": factory[1], "name": name, "line": node.lineno, "prefix": "", "module": scope.parent is None}
                        routers.append(router)
                        prefixes.append((router, node.value, scope))
                        scope.bind(name, {"kind": "router", "id": router["id"]})
                elif isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                    for name in names:
                        scope.bind(name, {"kind": "text", "value": node.value.value})
            elif isinstance(node, _FUNCTIONS):
                function = _Scope(scope, node.body, node.name if id(node) in top_level else None)
                function.definition = node
                scopes.append(function)
                arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs, *[a for a in (node.args.vararg, node.args.kwarg) if a is not None]]
                for argument in arguments:
                    function.bindings[argument.arg] = {"kind": "other"}
                    if function.function is not None and _is_router_annotation(argument.annotation, imports):
                        router = {"id": len(routers), "kind": "parameter", "name": argument.arg, "line": argument.lineno, "prefix": "", "module": False}
                        routers.append(router)
                        function.bindings[argument.arg] = {"kind": "router", "id": router["id"]}
                        function.router_parameters[argument.arg] = router["id"]
    for router, call, scope in prefixes:
        keyword = _keyword(call, "prefix") if router["kind"] == "router" else None
        router["prefix"] = "" if keyword is None else scope.text(keyword)
    return scopes


def _router_reference(node: ast.expr, scope: _Scope) -> dict[str, Any] | None:
    """The router an include/mount argument names: a local router, or a name to resolve across modules."""
    router = scope.router(node)
    if router is not None:
        return {"router": router}
    if isinstance(node, ast.Call):
        name = _dotted(node.func)
        return None if name is None else {"name": name, "call": True}
    name = _dotted(node)
    binding = scope.lookup(name) if isinstance(node, ast.Name) and name is not None else None
    return None if name is None or binding is not None else {"name": name, "call": False}


def _composition(node: ast.Call, scope: _Scope, includes: list[dict[str, Any]], calls: list[dict[str, Any]]) -> None:
    """Record `parent.include_router(child, prefix=...)`, `parent.mount(path, child)` and router-passing calls."""
    function = node.func
    parent = scope.router(function.value) if isinstance(function, ast.Attribute) else None
    if parent is not None and isinstance(function, ast.Attribute) and function.attr in {"include_router", "mount"}:
        mounted = function.attr == "mount"
        if mounted:
            child = node.args[1] if len(node.args) > 1 else _keyword(node, "app")
            path = node.args[0] if node.args else _keyword(node, "path")
            prefix = scope.text(path)
        else:
            child = node.args[0] if node.args else _keyword(node, "router")
            given = _keyword(node, "prefix")
            prefix = "" if given is None else scope.text(given)
        reference = None if child is None else _router_reference(child, scope)
        if reference is not None:
            includes.append({"parent": parent, "child": reference, "prefix": prefix, "line": node.lineno})
        return
    callee = _dotted(function)
    if callee is None:
        return
    arguments = [{"router": router, "index": index, "keyword": None} for index, item in enumerate(node.args) if (router := scope.router(item)) is not None]
    arguments += [{"router": router, "index": None, "keyword": item.arg} for item in node.keywords if item.arg and (router := scope.router(item.value)) is not None]
    if arguments:
        calls.append({"callee": callee, "arguments": arguments, "line": node.lineno})


def _import_facts(tree: ast.Module, names: set[str], package: bool) -> list[dict[str, Any]]:
    """Import bindings that cross-module router resolution may follow: the names composition refers to, or every
    import of a package `__init__` (which may re-export a router)."""
    facts: list[dict[str, Any]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            facts += [{"local": alias.asname or alias.name, "module": node.module or "", "name": alias.name, "level": node.level} for alias in node.names if alias.name != "*"]
        elif isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                facts.append({"local": alias.asname or top, "module": alias.name if alias.asname else top, "name": None, "level": 0})
    return [fact for fact in facts if package or fact["local"] in names]


def parse_file(source: str, path: str) -> dict[str, Any]:
    tree = ast.parse(source, filename=path)
    imports: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module in {"fastapi", "flask"}:
            for alias in node.names:
                imports[alias.asname or alias.name] = f"{node.module}.{alias.name}"
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in {"fastapi", "flask"}:
                    imports[alias.asname or alias.name] = alias.name
    routers: list[dict[str, Any]] = []
    scopes = _build_scopes(tree, imports, routers)
    routes: list[dict[str, Any]] = []
    includes: list[dict[str, Any]] = []
    calls: list[dict[str, Any]] = []
    functions: list[dict[str, Any]] = []
    for scope in scopes:
        returns: list[int] = []
        for node in scope.nodes:
            if isinstance(node, _FUNCTIONS):
                for decorator in node.decorator_list:
                    if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute) or not isinstance(decorator.func.value, ast.Name):
                        continue
                    binding = scope.lookup(decorator.func.value.id)
                    operation = decorator.func.attr
                    if binding is None or binding["kind"] not in {"router", "flask"} or operation not in _ROUTE_OPERATIONS:
                        continue
                    route_path = decorator.args[0] if decorator.args else next((k.value for k in decorator.keywords if k.arg in {"path", "rule"}), None)
                    if not isinstance(route_path, ast.Constant) or not isinstance(route_path.value, str):
                        continue
                    framework = "flask" if binding["kind"] == "flask" else "fastapi"
                    for method in _methods(decorator, operation.upper() if operation not in {"route", "api_route"} else "GET"):
                        routes.append({"framework": framework, "method": method, "path": route_path.value, "handler": node.name, "line": node.lineno, "router": binding.get("id")})
            elif isinstance(node, ast.Call):
                _composition(node, scope, includes, calls)
            elif isinstance(node, ast.Return) and node.value is not None and scope.router(node.value) is not None:
                returns.append(scope.router(node.value))
        if scope.function is not None:
            definition = scope.definition
            parameters = [argument.arg for argument in [*definition.args.posonlyargs, *definition.args.args]]
            router_parameters = scope.router_parameters
            if returns or router_parameters:
                functions.append({"name": scope.function, "parameters": parameters, "routerParameters": router_parameters, "returns": sorted(set(returns))})
    names = {item["child"]["name"].split(".")[0] for item in includes if "name" in item["child"]} | {call["callee"].split(".")[0] for call in calls}
    tests: list[dict[str, Any]] = []
    symbols: list[dict[str, Any]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            symbols.append({"name": node.name, "kind": "class", "line": node.lineno})
        if not isinstance(node, _FUNCTIONS):
            continue
        symbols.append({"name": node.name, "kind": "function", "line": node.lineno})
        if node.name.startswith("test_"):
            tests.append({"name": node.name, "line": node.lineno, "async": isinstance(node, ast.AsyncFunctionDef)})
    return {
        "path": path,
        "routes": routes,
        "routers": routers,
        "includes": includes,
        "calls": calls,
        "functions": functions,
        "imports": _import_facts(tree, names, Path(path).name == "__init__.py"),
        "tests": tests,
        "symbols": symbols,
    }


def summarize(repo_root: str, files: list[str]) -> dict[str, Any]:
    root = Path(repo_root).resolve(strict=True)
    summaries: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []
    for name in files:
        relative = Path(name)
        if relative.is_absolute() or not relative.parts or ".." in relative.parts or "\\" in name or relative.suffix != ".py":
            diagnostics.append({"path": name, "code": "invalid_path", "message": "only root-relative .py paths are admitted"})
            continue
        descriptors = []
        try:
            directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            descriptors.append(directory)
            for part in relative.parts[:-1]:
                directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                descriptors.append(directory)
            fd = os.open(relative.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            descriptors.append(fd)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 1024 * 1024:
                raise ValueError("only bounded regular files without hardlinks are admitted")
            with os.fdopen(os.dup(fd), "r", encoding="utf-8") as source:
                summaries.append(parse_file(source.read(1024 * 1024 + 1), relative.as_posix()))
        except (OSError, UnicodeError, SyntaxError, ValueError) as exc:
            diagnostics.append({"path": name, "code": "parse_error", "message": str(exc)[:8000]})
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)
    return {"version": "1.1.0", "files": summaries, "diagnostics": diagnostics}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("repo_root")
    parser.add_argument("files", nargs="+")
    args = parser.parse_args()
    json.dump(summarize(args.repo_root, args.files), sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
