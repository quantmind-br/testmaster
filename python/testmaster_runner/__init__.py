"""Public helpers for approved Python tests executed by TestMaster."""
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


def step(name: str, index: int = 0) -> Iterator[None]:
    from .plugin import current_plugin
    plugin = current_plugin()
    if plugin is None:
        raise RuntimeError("testmaster.step requires the TestMaster harness")
    return plugin.step(name, index)


def artifact(path: str | Path, relative_path: str, kind: str = "file", mime_type: str = "application/octet-stream") -> None:
    from .plugin import current_plugin
    plugin = current_plugin()
    if plugin is None:
        raise RuntimeError("testmaster.artifact requires the TestMaster harness")
    plugin.protocol.artifact(path, relative_path, kind, mime_type)
