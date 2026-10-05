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


def parse_file(source: str, path: str) -> dict[str, Any]:
    tree = ast.parse(source, filename=path)
    imports: dict[str, str] = {}
    applications: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module in {"fastapi", "flask"}:
            for alias in node.names:
                imports[alias.asname or alias.name] = f"{node.module}.{alias.name}"
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in {"fastapi", "flask"}:
                    imports[alias.asname or alias.name] = alias.name
    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AnnAssign)) and isinstance(node.value, ast.Call):
            callee = node.value.func
            qualified = imports.get(callee.id, "") if isinstance(callee, ast.Name) else ""
            if isinstance(callee, ast.Attribute) and isinstance(callee.value, ast.Name):
                qualified = f"{imports.get(callee.value.id, '')}.{callee.attr}"
            if qualified in {"fastapi.FastAPI", "fastapi.APIRouter", "flask.Flask", "flask.Blueprint"}:
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    if isinstance(target, ast.Name):
                        applications[target.id] = "fastapi" if qualified.startswith("fastapi.") else "flask"
    routes: list[dict[str, Any]] = []
    tests: list[dict[str, Any]] = []
    symbols: list[dict[str, Any]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            symbols.append({"name": node.name, "kind": "class", "line": node.lineno})
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        symbols.append({"name": node.name, "kind": "function", "line": node.lineno})
        if node.name.startswith("test_"):
            tests.append({"name": node.name, "line": node.lineno, "async": isinstance(node, ast.AsyncFunctionDef)})
        for decorator in node.decorator_list:
            if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute) or not isinstance(decorator.func.value, ast.Name):
                continue
            framework = applications.get(decorator.func.value.id)
            operation = decorator.func.attr
            if framework is None or operation not in {"route", "api_route", "get", "post", "put", "patch", "delete", "options", "head"}:
                continue
            route_path = decorator.args[0] if decorator.args else next((k.value for k in decorator.keywords if k.arg in {"path", "rule"}), None)
            if not isinstance(route_path, ast.Constant) or not isinstance(route_path.value, str):
                continue
            for method in _methods(decorator, operation.upper() if operation not in {"route", "api_route"} else "GET"):
                routes.append({"framework": framework, "method": method, "path": route_path.value, "handler": node.name, "line": node.lineno})
    return {"path": path, "routes": routes, "tests": tests, "symbols": symbols}


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
    return {"version": "1.0.0", "files": summaries, "diagnostics": diagnostics}


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
