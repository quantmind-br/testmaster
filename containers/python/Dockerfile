FROM mcr.microsoft.com/playwright/python:v1.63.0-noble@sha256:72bd171a9ffc2b4b59532aaa6210e21014d07093120dc25528870c0b840da1f0
RUN install -d -o 1000 -g 1000 /opt/testmaster/python
COPY --chown=1000:1000 python/ /opt/testmaster/python/
WORKDIR /opt/testmaster/python
ENV HOME=/tmp/home PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/opt/testmaster/python
USER 1000:1000
ENTRYPOINT ["python", "/opt/testmaster/python/harness.py"]
