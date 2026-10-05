FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
COPY --chown=1000:1000 runner/ /opt/testmaster/runner/
WORKDIR /opt/testmaster/runner
ENV HOME=/tmp/home
USER 1000:1000
ENTRYPOINT ["node", "/opt/testmaster/runner/dist/harness.js"]
