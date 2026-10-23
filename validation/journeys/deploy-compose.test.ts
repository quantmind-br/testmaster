import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    // Negative control: S3 storage without its location is refused, never served from disk.
    const s3 = {
      ...JSON.parse(read("deploy/compose/server.example.json")),
      storage: { kind: "s3" },
    };
    expect(() => parseServerConfig(s3)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
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

describe("distributed reference deployment files (ADR-035)", () => {
  const distributed = read("deploy/compose/compose.distributed.yaml");
  /** The text of one service of the compose file, from its key to the next top-level entry. */
  const service = (name: string): string => {
    const start = distributed.search(new RegExp(`^  ${name}:$`, "mu"));
    if (start < 0) throw new Error(`no service ${name}`);
    const rest = distributed.slice(distributed.indexOf("\n", start) + 1);
    const next = rest.search(/^ {0,2}[A-Za-z][\w-]*:/mu);
    return next < 0 ? rest : rest.slice(0, next);
  };

  it("SEC-036 every image is pinned by digest, nothing runs privileged or on the host network, and only Caddy is public", () => {
    const images = [...distributed.matchAll(/^\s+image: (\S+)$/gmu)].map((match) => match[1] ?? "");
    expect(images.length).toBeGreaterThan(0);
    // The controller image is built from containers/server/Dockerfile, whose base is pinned.
    expect(images.filter((image) => !image.includes("@sha256:"))).toEqual([
      "testmaster-server:local",
    ]);
    expect(distributed).toContain(
      "minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e",
    );
    expect(distributed).toContain(
      "caddy:2-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f",
    );
    for (const forbidden of [
      /network_mode:/u,
      /privileged:/u,
      /docker\.sock/u,
      /pid:\s*host/u,
      /cap_add:/u,
      /ipc:\s*host/u,
    ])
      expect(distributed).not.toMatch(forbidden);
    const unbound = [...distributed.matchAll(/^\s+- "(?!127\.0\.0\.1)([^"]*:\d+)"$/gmu)].map(
      (match) => match[1],
    );
    expect(unbound).toEqual(["${TESTMASTER_PUBLIC_PORT:-8443}:8443"]);
    expect(service("caddy")).toContain("TESTMASTER_PUBLIC_PORT");
    // Negative control: the scan sees a host-network service when one exists.
    expect(`${distributed}\n    network_mode: host`).toMatch(/network_mode:/u);
  });

  it("SEC-030 OPS-026 credentials are files, and the backup bucket credential is only read by the bootstrap", () => {
    expect(distributed).not.toMatch(/MINIO_ROOT_(?:USER|PASSWORD):/u);
    expect(distributed).not.toMatch(/POSTGRES_PASSWORD:/u);
    expect(service("minio")).toContain("MINIO_ROOT_USER_FILE");
    expect(service("minio")).toContain("MINIO_ROOT_PASSWORD_FILE");
    for (const name of ["server", "server-2"]) {
      const block = service(name)
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
      expect(block, name).toContain("TESTMASTER_S3_EVIDENCE_ID_FILE");
      expect(block, name).not.toMatch(/BACKUP|backup/u);
      expect(block, name).toContain("--mode");
      expect(block, name).toContain("distributed");
    }
    const holders = ["minio", "minio-init", "server", "server-2", "caddy", "postgres"].filter(
      (name) => /s3_backup_|TESTMASTER_S3_BACKUP_(?:ID|SECRET)_FILE/u.test(service(name)),
    );
    expect(holders).toEqual(["minio-init"]);
    // Negative control: the check would notice a controller that mounted the backup credential.
    expect(
      /TESTMASTER_S3_BACKUP_ID_FILE/u.test(
        `${service("server")}\n      - \${TESTMASTER_S3_BACKUP_ID_FILE}:/x`,
      ),
    ).toBe(true);
  });

  it("OPS-001 the two controllers differ only in their own configuration, scratch and published port", () => {
    const first = service("server");
    const second = service("server-2");
    expect(first).toContain("*controller");
    expect(second).toContain("*controller");
    expect(first).toContain("TESTMASTER_CONFIG:");
    expect(second).toContain("TESTMASTER_CONFIG_2:");
    expect(first).toContain("TESTMASTER_STAGING_DIR:");
    expect(second).toContain("TESTMASTER_STAGING_DIR_2:");
    expect(first).toContain("TESTMASTER_CONTROLLER_PORT:");
    expect(second).toContain("TESTMASTER_CONTROLLER_PORT_2:");
    // Shared state is PostgreSQL and the bucket: no controller mounts a data directory both write.
    expect(first).not.toMatch(/TESTMASTER_DATA_DIR/u);
    expect(second).not.toMatch(/TESTMASTER_DATA_DIR/u);
  });

  it("OPS-001 Caddy balances both controllers, probes their health and relays upgrades", () => {
    const caddy = read("deploy/compose/Caddyfile.distributed");
    const upstreams = /reverse_proxy ((?:\S+:\d+\s*)+)\{/u.exec(caddy)?.[1]?.trim().split(/\s+/u);
    expect(upstreams).toEqual(["server:7331", "server-2:7331"]);
    expect(caddy).toContain("lb_policy round_robin");
    expect(caddy).toContain("health_uri /v1/health/live");
    expect(caddy).toContain("tls internal");
    // The access log must never carry a header: a worker's signed proof and a session cookie.
    expect(caddy).toContain("request>headers delete");
  });

  it("OPS-026 the bootstrap makes a COMPLIANCE-locked backup bucket and two identities limited to one bucket each", () => {
    const script = read("deploy/compose/minio-init.sh");
    expect(script).toContain('mc mb --ignore-existing --with-lock "tm/${backup_bucket}"');
    expect(script).toContain("mc retention set --default COMPLIANCE");
    const policies = [...script.matchAll(/^policy "\$(\w+)"/gmu)].map((match) => match[1]);
    expect(policies).toEqual(["evidence_bucket", "backup_bucket"]);
    // Each policy's resources name its own bucket and never a wildcard bucket.
    expect(script).toContain('"Resource":["arn:aws:s3:::$1","arn:aws:s3:::$1/*"]');
    expect(script).not.toMatch(/arn:aws:s3:::\*/u);
  });

  it("SEC-036 gen-tls.sh issues a MinIO certificate from the deployment CA that only its own user can read", () => {
    const out = mkdtempSync(join(tmpdir(), "tm-gen-tls-"));
    try {
      execFileSync("bash", [resolve(root, "deploy/compose/gen-tls.sh"), join(out, "tls"), "2"]);
      const tls = join(out, "tls");
      execFileSync("openssl", [
        "verify",
        "-CAfile",
        join(tls, "ca.crt"),
        join(tls, "minio/public.crt"),
      ]);
      const names = execFileSync("openssl", [
        "x509",
        "-in",
        join(tls, "minio/public.crt"),
        "-noout",
        "-ext",
        "subjectAltName",
      ]).toString();
      expect(names).toContain("DNS:minio");
      expect(names).toContain("IP Address:127.0.0.1");
      expect(statSync(join(tls, "minio/private.key")).mode & 0o077).toBe(0);
      // Negative control: the PostgreSQL certificate does not verify the MinIO name.
      expect(() =>
        execFileSync(
          "openssl",
          [
            "verify",
            "-CAfile",
            join(tls, "ca.crt"),
            "-verify_hostname",
            "postgres",
            join(tls, "minio/public.crt"),
          ],
          { stdio: "pipe" },
        ),
      ).toThrow();
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("OPS-001 the shipped distributed example is a valid distributed profile and refuses to degrade", () => {
    const example = JSON.parse(read("deploy/compose/server.distributed.example.json"));
    const config = parseServerConfig(example);
    expect(config.mode).toBe("distributed");
    expect(config.storage.kind).toBe("s3");
    expect(config.server.internalOrigin).toBe("http://server:7331");
    // Negative controls: filesystem storage and a missing internal origin are refused, never served.
    expect(() =>
      parseServerConfig({ ...example, storage: { kind: "filesystem", root: "/srv/evidence" } }),
    ).toThrowError(
      expect.objectContaining({ details: { reasonCode: "distributed_requires_shared_storage" } }),
    );
    expect(() =>
      parseServerConfig({ ...example, server: { ...example.server, internalOrigin: undefined } }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});
