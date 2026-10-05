import json
import os
from pathlib import Path
import testmaster_runner as testmaster


def test_health(tm_request):
    config = json.loads(Path('/run/testmaster/input/python.json').read_text())
    with testmaster.step('service_health'):
        response = tm_request.get(config['baseUrl'] + '/health', timeout=10)
        assert response.status_code == 200
        assert response.json()['status'] == 'ok'
