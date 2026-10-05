"""No policy here: all TCP bytes are relayed to the host egress guard."""
from __future__ import annotations

import socket
import threading


class Forwarder:
    def __init__(self, path: str = "/run/testmaster/sockets/egress.sock", port: int = 3128) -> None:
        self.path = path
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind(("127.0.0.1", port))
        self.listener.listen(32)
        self._closed = False
        self._connections: set[socket.socket] = set()
        self._lock = threading.Lock()
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self) -> None:
        while not self._closed:
            try:
                incoming, _ = self.listener.accept()
            except OSError:
                return
            threading.Thread(target=self._relay, args=(incoming,), daemon=True).start()

    def _relay(self, incoming: socket.socket) -> None:
        outgoing = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        with self._lock:
            self._connections.update((incoming, outgoing))
        try:
            outgoing.connect(self.path)
            def copy(source: socket.socket, destination: socket.socket) -> None:
                try:
                    while chunk := source.recv(65536):
                        destination.sendall(chunk)
                except OSError:
                    pass
                finally:
                    try:
                        destination.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
            reverse = threading.Thread(target=copy, args=(outgoing, incoming), daemon=True)
            reverse.start()
            copy(incoming, outgoing)
            reverse.join()
        finally:
            with self._lock:
                self._connections.discard(incoming)
                self._connections.discard(outgoing)
            incoming.close()
            outgoing.close()

    def close(self) -> None:
        self._closed = True
        self.listener.close()
        with self._lock:
            for connection in self._connections:
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                connection.close()
