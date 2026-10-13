import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseServerConfig } from "@testmaster/application";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const compose = read("deploy/compose/compose.yaml");

describe("reference deployment files (ADR-016, ADR-019)", () => {
  it("SEC-036 pins the ADR-016 images by digest and publishes PostgreSQL on loopback only", () => {
    expect(compose).toContain(
      "postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24",
    );
    expect(compose).toContain(
      "caddy:2-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f",
    );
    expect(read("containers/server/Dockerfile")).toContain(
      "node:24@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584",
    );
    expect(compose).toContain('"127.0.0.1:${TESTMASTER_PG_PORT:-55432}:5432"');
    // Negative control: no service publishes a port without naming an address, except Caddy.
    const unbound = [...compose.matchAll(/^\s+- "(?!127\.0\.0\.1)([^"]*:\d+)"$/gmu)].map(
      (match) => match[1],
    );
    expect(unbound).toEqual(["${TESTMASTER_PUBLIC_PORT:-8443}:8443"]);
  });

  it("SEC-036 PostgreSQL accepts TLS only and the shipped example configuration is a valid verify-full server profile", () => {
    const hba = read("deploy/compose/pg_hba.conf")
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));
    expect(hba.filter((line) => /^host\s/u.test(line))).toEqual([]);
    expect(hba.filter((line) => /^hostssl\s/u.test(line)).length).toBeGreaterThan(0);
    expect(compose).toContain("ssl=on");
    const config = parseServerConfig(JSON.parse(read("deploy/compose/server.example.json")));
    expect(config.database.url).toContain("sslmode=verify-full");
    expect(config.database.caFile).toBe("/etc/testmaster/tls/ca.crt");
    expect(config.security.atRestEncryption).toEqual({
      database: "operator-volume",
      evidence: "operator-volume",
    });
    // Negative control: the same document with S3 storage is refused, never served from disk.
    const s3 = {
      ...JSON.parse(read("deploy/compose/server.example.json")),
      storage: { kind: "s3" },
    };
    expect(() => parseServerConfig(s3)).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }),
    );
  });

  it("SEC-036 Caddy terminates TLS and the worker unit restarts after a schema refusal", () => {
    expect(read("deploy/compose/Caddyfile")).toContain("tls internal");
    const worker = read("deploy/systemd/testmaster-worker@.service");
    expect(worker).toContain("Restart=on-failure");
    expect(worker).toContain("StartLimitIntervalSec=0");
    expect(worker).toContain("worker start --mode server");
    expect(statSync(resolve(root, "deploy/compose/gen-tls.sh")).mode & 0o111).not.toBe(0);
  });
});
