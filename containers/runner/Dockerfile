FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55 AS ffmpeg
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       build-essential ca-certificates curl nasm pkg-config xz-utils \
    && rm -rf /var/lib/apt/lists/*
COPY ffmpeg/ /recipe/
RUN sh /recipe/build.sh /out && cp /recipe/provenance.json /out/TESTMASTER_FFMPEG_BUILD.json

FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 AS base
COPY --from=ffmpeg /out/ /ms-playwright/ffmpeg-1011/
# Security updates for fixable findings (OpenSSL), and drop the image-global npm: nothing in the
# runner invokes npm or npx, and its bundled dependencies carry unfixed advisories.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --only-upgrade openssl libssl3t64 \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/lib/node_modules/npm /usr/bin/npm /usr/bin/npx /usr/local/bin/npm /usr/local/bin/npx

# Flatten so the replaced vendor ffmpeg binary (no public build recipe) is not redistributed
# in a lower layer. Environment mirrors the base image configuration.
FROM scratch
COPY --from=base / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
LABEL org.opencontainers.image.version=24.04
COPY --chown=1000:1000 runner/ /opt/testmaster/runner/
WORKDIR /opt/testmaster/runner
ENV HOME=/tmp/home
USER 1000:1000
ENTRYPOINT ["node", "/opt/testmaster/runner/dist/harness.js"]
