FROM mcr.microsoft.com/playwright/python:v1.63.0-noble@sha256:72bd171a9ffc2b4b59532aaa6210e21014d07093120dc25528870c0b840da1f0
RUN python -m pip install --no-cache-dir uv==0.12.23
COPY python/ /opt/testmaster/python/
WORKDIR /opt/testmaster/python
RUN uv sync --frozen --no-dev --python python3.12 --no-editable \
    && chmod -R a+rX /opt/testmaster/python \
    && python -m pip uninstall -y pip uv \
    && rm -f /usr/local/bin/uv /usr/local/bin/uvx /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.12
ENV HOME=/tmp/home PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/opt/testmaster/python \
    PATH=/opt/testmaster/python/.venv/bin:$PATH UV_OFFLINE=1 PIP_NO_INDEX=1
USER 1000:1000
ENTRYPOINT ["python", "-m", "testmaster_runner"]
