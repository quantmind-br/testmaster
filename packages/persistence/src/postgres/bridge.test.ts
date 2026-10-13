import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConnection } from "./bridge.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function secretFile(content: string, mode: number): string {
  const directory = mkdtempSync(join(tmpdir(), "tm-bridge-"));
  directories.push(directory);
  const path = join(directory, "password");
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

describe("PostgreSQL connection configuration", () => {
  it("OPS-005 refuses a password embedded in the URL", () => {
    expect(() => resolveConnection({ url: "postgres://owner:secret@127.0.0.1/db" }, {})).toThrow(
      "must not contain a password",
    );
  });

  it("OPS-005 refuses plaintext connections to non-loopback hosts and accepts loopback and sockets", () => {
    expect(() => resolveConnection({ url: "postgres://owner@db.internal/app" }, {})).toThrow(
      "require sslmode=verify-full",
    );
    expect(() =>
      resolveConnection(
        { url: "postgres://owner@db.internal/app?sslmode=require", caFile: "/dev/null" },
        {},
      ),
    ).toThrow("require sslmode=verify-full");
    expect(resolveConnection({ url: "postgres://owner@127.0.0.1:5432/app" }, {}).ssl).toBe(false);
    expect(resolveConnection({ url: "postgres://owner@localhost/app" }, {}).ssl).toBe(false);
    expect(
      resolveConnection({ url: "postgres://owner@localhost/app?host=/run/postgresql" }, {}),
    ).toMatchObject({
      host: "/run/postgresql",
      ssl: false,
    });
  });

  it("OPS-005 requires a CA file for verify-full and then enables TLS", () => {
    const url = "postgres://owner@db.internal/app?sslmode=verify-full";
    expect(() => resolveConnection({ url }, {})).toThrow("requires database.caFile");
    expect(resolveConnection({ url, caFile: "/dev/null" }, {})).toMatchObject({
      ssl: true,
      host: "db.internal",
    });
  });

  it("OPS-005 reads the password from a 0600 file and refuses looser modes", () => {
    const good = secretFile("s3cret\n", 0o600);
    expect(
      resolveConnection({ url: "postgres://owner@127.0.0.1/app", passwordFile: good }, {}).password,
    ).toBe("s3cret");
    const loose = secretFile("s3cret\n", 0o640);
    expect(() =>
      resolveConnection({ url: "postgres://owner@127.0.0.1/app", passwordFile: loose }, {}),
    ).toThrow("mode 0600");
  });

  it("OPS-005 falls back to PGPASSWORD only when no password file is configured", () => {
    expect(
      resolveConnection({ url: "postgres://owner@127.0.0.1/app" }, { PGPASSWORD: "env-secret" })
        .password,
    ).toBe("env-secret");
    const file = secretFile("file-secret", 0o600);
    expect(
      resolveConnection(
        { url: "postgres://owner@127.0.0.1/app", passwordFile: file },
        { PGPASSWORD: "env-secret" },
      ).password,
    ).toBe("file-secret");
  });

  it("OPS-005 rejects non-postgres schemes and URLs without a database name", () => {
    expect(() => resolveConnection({ url: "mysql://owner@127.0.0.1/app" }, {})).toThrow(
      "postgres:// scheme",
    );
    expect(() => resolveConnection({ url: "postgres://owner@127.0.0.1/" }, {})).toThrow(
      "must name a database",
    );
  });
});
