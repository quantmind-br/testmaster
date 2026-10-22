FROM ghcr.io/zaproxy/zaproxy@sha256:5ccfff9a411743ab2615136a2edd7416bec9ce41572fa94e935df38c14adb2b6
USER root
# The adapter and the three protocol modules it shares with the Python runner; no network access at build.
COPY python/testmaster_runner/__init__.py python/testmaster_runner/protocol.py python/testmaster_runner/forwarder.py /opt/testmaster/zap/testmaster_runner/
COPY containers/zap/adapter.py /opt/testmaster/zap/adapter.py
RUN chmod -R a+rX /opt/testmaster \
    && rm -f /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.11
# The base image probes ZAP on port 8080; the adapter runs ZAP on loopback 8090, reachable only inside the container.
HEALTHCHECK NONE
WORKDIR /opt/testmaster/zap
ENV HOME=/tmp/home PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/opt/testmaster/zap
USER 1000:1000
ENTRYPOINT ["python3", "/opt/testmaster/zap/adapter.py"]
