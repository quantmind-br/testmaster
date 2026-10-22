"""Trusted NDJSON client for the TestMaster attempt protocol."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import stat
import time
import uuid
import threading
from pathlib import Path
from typing import Any


class ProtocolError(RuntimeError):
    """Raised when the attempt protocol cannot be used safely."""


class _PendingSecret:
    def __init__(self, secret_ref: str, secret_version: int) -> None:
        self.secret_ref = secret_ref
        self.secret_version = secret_version
        self.event = threading.Event()
        self.value: str | None = None


class ProtocolClient:
    def __init__(self, attempt_id: str, nonce: str, socket_path: str = "/run/testmaster/sockets/protocol.sock") -> None:
        self.attempt_id = attempt_id
        self._seq = 0
        self._lock = threading.Lock()
        self._socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._socket.settimeout(10)
        self._socket.connect(socket_path)
        self._file = self._socket.makefile("wb")
        self._secret_counter = 0
        self._secret_lock = threading.Lock()
        self._pending_secrets: dict[str, _PendingSecret] = {}
        self.emit("runner.hello", {"nonce": nonce, "capabilities": ["python", "pytest", "requests", "playwright", "property"]})

    def emit(self, event_type: str, payload: dict[str, Any]) -> None:
        with self._lock:
            event = {
                "protocolVersion": "1.0.0",
                "seq": self._seq,
                "attemptId": self.attempt_id,
                "type": event_type,
                "occurredAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
                "payload": payload,
            }
            encoded = (json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
            if len(encoded) > 256 * 1024:
                raise ProtocolError("protocol event exceeds 256 KiB")
            self._file.write(encoded)
            self._file.flush()
            self._seq += 1

    def artifact(self, path: str | Path, relative_path: str, kind: str = "file", mime_type: str = "application/octet-stream") -> None:
        target = Path(relative_path)
        if not target.parts or target.is_absolute() or ".." in target.parts or "\\" in relative_path or "\x00" in relative_path:
            raise ProtocolError("artifact path is not confined")
        source = Path(path).absolute()
        descriptors = []
        try:
            directory = os.open(source.anchor, os.O_RDONLY | os.O_DIRECTORY)
            descriptors.append(directory)
            for part in source.parts[1:-1]:
                directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                descriptors.append(directory)
            fd = os.open(source.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            descriptors.append(fd)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 64 * 1024 * 1024:
                raise ProtocolError("artifact must be a bounded regular file without links")
            artifact_id = f"art_{uuid.uuid4()}"
            digest = hashlib.sha256()
            size = 0
            self.emit("artifact.begin", {"artifactId": artifact_id, "relativePath": relative_path, "kind": kind, "mimeType": mime_type, "sizeBytes": info.st_size})
            with os.fdopen(os.dup(fd), "rb") as stream:
                while chunk := stream.read(128 * 1024):
                    size += len(chunk)
                    if size > 64 * 1024 * 1024:
                        raise ProtocolError("artifact grew beyond quota")
                    digest.update(chunk)
                    self.emit("artifact.chunk", {"artifactId": artifact_id, "data": base64.b64encode(chunk).decode("ascii")})
            self.emit("artifact.end", {"artifactId": artifact_id, "sha256": digest.hexdigest(), "sizeBytes": size})
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)

    def secret(self, secret_ref: str, secret_version: int) -> str:
        """Ask the host for a secret value and block until the listener delivers it."""
        with self._secret_lock:
            request_id = f"secret-{self._secret_counter}"
            self._secret_counter += 1
            pending = _PendingSecret(secret_ref, secret_version)
            self._pending_secrets[request_id] = pending
        self.emit("secret.request", {"requestId": request_id, "secretRef": secret_ref, "secretVersion": secret_version})
        pending.event.wait()
        if pending.value is None:
            raise ProtocolError("secret value unavailable: protocol closed or the value did not match its request")
        return pending.value

    def deliver_secret(self, payload: dict[str, Any]) -> None:
        """Route a `secret.value` supervisor event to the waiting `secret` call."""
        with self._secret_lock:
            pending = self._pending_secrets.pop(payload.get("requestId"), None)
        if pending is None:
            raise ProtocolError("unsolicited secret.value")
        value = payload.get("value")
        if payload.get("secretRef") != pending.secret_ref or payload.get("secretVersion") != pending.secret_version or not isinstance(value, str):
            pending.event.set()  # the waiter fails with a protocol error instead of hanging
            raise ProtocolError("secret.value does not match its request")
        pending.value = value
        pending.event.set()

    def close(self) -> None:
        with self._secret_lock:
            waiting = list(self._pending_secrets.values())
            self._pending_secrets.clear()
        for pending in waiting:
            pending.event.set()
        try:
            self._file.close()
        finally:
            self._socket.close()


def load_input(path: str | None = None) -> dict[str, Any]:
    value = path or os.environ.get("TESTMASTER_INPUT", "/run/testmaster/input/python.json")
    with open(value, encoding="utf-8") as stream:
        data = json.load(stream)
    if not isinstance(data, dict) or not isinstance(data.get("attemptId"), str) or not isinstance(data.get("nonce"), str):
        raise ProtocolError("python input requires attemptId and nonce")
    return data
