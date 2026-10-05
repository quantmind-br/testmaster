import base64
import hashlib
import json
import socket
import threading
import uuid

import pytest

from testmaster_runner.protocol import ProtocolClient, ProtocolError
from testmaster_runner.plugin import PythonPlugin
from testmaster_runner.code_summary import summarize


@pytest.fixture
def channel(tmp_path):
    path = str(tmp_path / "protocol.sock")
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen()
    events = []
    finished = threading.Event()
    def receive():
        connection, _ = server.accept()
        with connection, connection.makefile("rb") as stream:
            for line in stream:
                events.append(json.loads(line))
        finished.set()
    thread = threading.Thread(target=receive)
    thread.start()
    client = ProtocolClient(f"att_{uuid.uuid4()}", "a" * 32, path)
    yield client, events, finished
    client.close()
    thread.join(3)
    server.close()
    assert not thread.is_alive()


def test_artifact_integrity_sequence_and_ndjson(channel, tmp_path):
    client, events, finished = channel
    value = b"abc" * 90000
    source = tmp_path / "file.bin"
    source.write_bytes(value)
    client.artifact(source, "evidence/file.bin")
    client.emit("runner.finished", {"outcome": "passed", "reasonCode": "assertions_satisfied"})
    client._file.flush()
    client._socket.shutdown(socket.SHUT_WR)
    assert finished.wait(3)
    assert [event["seq"] for event in events] == list(range(7))
    assert events[0]["type"] == "runner.hello"
    chunks = [base64.b64decode(event["payload"]["data"]) for event in events if event["type"] == "artifact.chunk"]
    assert b"".join(chunks) == value
    terminal = next(event for event in events if event["type"] == "artifact.end")
    assert terminal["payload"]["sha256"] == hashlib.sha256(value).hexdigest()
    assert terminal["payload"]["sizeBytes"] == len(value)


def test_path_and_oversize_rejected(channel, tmp_path):
    client, _, _ = channel
    source = tmp_path / "file"
    source.write_text("test")
    with pytest.raises(ProtocolError):
        client.artifact(source, "../escape")
    with pytest.raises(ProtocolError):
        client.emit("log", {"level": "info", "message": "a" * 262144})
    assert client._seq == 1


def test_step_failure_is_observable(channel):
    client, _, _ = channel
    plugin = PythonPlugin(client, {})
    with pytest.raises(AssertionError):
        with plugin.step("assert_business"):
            assert False, "business mismatch"
    assert plugin.failed
    assert client._seq == 3


def test_summary_never_executes_and_confines_symlink(tmp_path):
    source = tmp_path / "app.py"
    source.write_text('from fastapi import FastAPI\napp=FastAPI()\n@app.get("/health")\nasync def health(): pass\ndef test_health(): pass\nraise RuntimeError("never execute")\n')
    (tmp_path / "link.py").symlink_to(source)
    result = summarize(str(tmp_path), ["app.py", "link.py", "../escape.py"])
    assert result["files"][0]["routes"][0]["method"] == "GET"
    assert result["files"][0]["tests"][0]["name"] == "test_health"
    assert len(result["diagnostics"]) == 2
