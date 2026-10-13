# TestMaster server profile image (ADR-016). The image holds only the Node runtime and the
# PostgreSQL client tools that backups need (pg_dump, pg_restore); the built TestMaster runtime is
# mounted read-only at /opt/testmaster so one image serves every release.
FROM node:24@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TESTMASTER_NO_TELEMETRY=true

WORKDIR /opt/testmaster
ENTRYPOINT ["node", "/opt/testmaster/apps/cli/dist/main.js"]
CMD ["server", "start", "--mode", "server", "--config", "/etc/testmaster/server.json"]
