FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55 AS ffmpeg
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       build-essential ca-certificates curl nasm pkg-config xz-utils \
    && rm -rf /var/lib/apt/lists/*
COPY ffmpeg/ /recipe/
RUN sh /recipe/build.sh /out && cp /recipe/provenance.json /out/TESTMASTER_FFMPEG_BUILD.json

FROM mcr.microsoft.com/playwright/python:v1.63.0-noble@sha256:72bd171a9ffc2b4b59532aaa6210e21014d07093120dc25528870c0b840da1f0 AS base
COPY --from=ffmpeg /out/ /ms-playwright/ffmpeg-1011/
RUN python -m pip install --no-cache-dir uv==0.12.23
COPY python/ /opt/testmaster/python/
WORKDIR /opt/testmaster/python
RUN uv sync --frozen --no-dev --python python3.12 --no-editable \
    && chmod -R a+rX /opt/testmaster/python \
    && python -m pip uninstall -y pip uv \
    && rm -f /usr/local/bin/uv /usr/local/bin/uvx /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.12

# Flatten so the replaced vendor ffmpeg binary (no public build recipe) is not redistributed
# in a lower layer. Environment mirrors the base image configuration.
FROM scratch
COPY --from=base / /
LABEL org.opencontainers.image.version=24.04
WORKDIR /opt/testmaster/python
ENV PATH=/opt/testmaster/python/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/tmp/home PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/opt/testmaster/python \
    UV_OFFLINE=1 PIP_NO_INDEX=1
USER 1000:1000
ENTRYPOINT ["python", "-m", "testmaster_runner"]
