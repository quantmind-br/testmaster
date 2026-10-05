import socket
import subprocess
import sys
import os
import pytest


def test_raw_socket_denied():
    for host in ('169.254.169.254', '192.168.1.1', '8.8.8.8'):
        with socket.socket() as connection:
            connection.settimeout(0.5)
            with pytest.raises(OSError):
                connection.connect((host, 80))
    result = subprocess.run([sys.executable, '-c', 'import socket; s=socket.socket();s.settimeout(.5);s.connect(("169.254.169.254",80))'], capture_output=True)
    assert result.returncode != 0
    assert os.getuid() != 0
    assert not os.path.exists('/var/run/docker.sock')
    assert os.environ['PIP_NO_INDEX'] == '1'
    assert os.environ['UV_OFFLINE'] == '1'
