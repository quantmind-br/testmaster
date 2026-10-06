import { pbkdf2 } from "node:crypto";
import { renameSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import tar from "tar-stream";
import { expect, it } from "vitest";
import { ConfinedRoot, extractTar, extractZip } from "./index.js";

async function archive(entries: { name: string; content: Buffer }[]) {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const collected = (async () => {
    for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  })();
  for (const entry of entries) pack.entry({ name: entry.name }, entry.content);
  pack.finalize();
  await collected;
  return Buffer.concat(chunks);
}

function storedZip(content: Buffer): Buffer {
  const name = Buffer.from("large.txt");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(content), 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(content), 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + content.length, 16);
  return Buffer.concat([local, name, content, central, name, end]);
}

it("pins the validated ancestor while an attacker swaps it before asynchronous file open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tm-race-"));
  const root = join(directory, "root");
  const outside = join(directory, "outside");
  await mkdir(join(root, "ancestor"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, "ancestor", "value"), "approved");
  await writeFile(join(outside, "value"), "external-secret");
  const confined = new ConfinedRoot(root);
  try {
    // Occupy the libuv pool so ancestor validation finishes while the actual open is queued.
    // Synchronous attacker swaps then run strictly before the queued file opens, without timers.
    let poolCompleted = false;
    const pool = Promise.all(
      Array.from({ length: Number(process.env.UV_THREADPOOL_SIZE ?? 4) }, () =>
        promisify(pbkdf2)("barrier", "salt", 200_000, 32, "sha256"),
      ),
    ).then(() => {
      poolCompleted = true;
    });
    const pending = confined.openFile("ancestor/value");
    const pendingWrite = confined.openFile("ancestor/created", true);
    expect(poolCompleted).toBe(false);
    renameSync(join(root, "ancestor"), join(root, "pinned"));
    symlinkSync(outside, join(root, "ancestor"));
    await pool;
    const file = await pending;
    try {
      expect(await file.readFile("utf8")).toBe("approved");
    } finally {
      await file.close();
    }
    const output = await pendingWrite;
    try {
      await output.writeFile("confined-write");
    } finally {
      await output.close();
    }
    expect(await readFile(join(root, "pinned", "created"), "utf8")).toBe("confined-write");
    await expect(confined.openFile("ancestor/value")).rejects.toThrow();
    await expect(confined.openFile("ancestor/new", true)).rejects.toThrow();
    expect(await readdir(outside)).toEqual(["value"]);
    expect(await readFile(join(outside, "value"), "utf8")).toBe("external-secret");
  } finally {
    confined.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects corrupted ZIP/tar and both extension and magic-disguised nested archives without residual staging", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tm-archive-matrix-"));
  try {
    const valid = await archive([{ name: "safe.txt", content: Buffer.from("safe") }]);
    await extractTar(valid, join(directory, "positive"));
    expect(await readFile(join(directory, "positive", "safe.txt"), "utf8")).toBe("safe");
    await rm(join(directory, "positive"), { recursive: true });
    for (const bytes of [valid.subarray(0, 600), Buffer.from("corrupt")])
      await expect(extractTar(bytes, join(directory, "corrupt"))).rejects.toThrow();
    await expect(extractZip(Buffer.from("corrupt"), join(directory, "zip"))).rejects.toThrow();
    const zip = storedZip(Buffer.from("safe bytes"));
    await extractZip(zip, join(directory, "valid-zip"));
    expect(await readFile(join(directory, "valid-zip", "large.txt"), "utf8")).toBe("safe bytes");
    await rm(join(directory, "valid-zip"), { recursive: true });
    zip[39] = (zip[39] ?? 0) ^ 0xff;
    await expect(extractZip(zip, join(directory, "bad-crc"))).rejects.toThrow("CRC");
    for (const name of ["nested.tar", "disguised.txt"])
      await expect(
        extractTar(await archive([{ name, content: valid }]), join(directory, "nested")),
      ).rejects.toThrow("Nested");
    await expect(extractZip(storedZip(valid), join(directory, "nested-zip"))).rejects.toThrow(
      "Nested",
    );
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["tar", "zip"] as const)(
  "cancels in-progress %s extraction and removes incomplete staging and destination",
  async (format) => {
    const directory = await mkdtemp(join(tmpdir(), "tm-extract-cancel-"));
    const controller = new AbortController();
    try {
      const input = join(directory, `input.${format}`);
      const content = Buffer.alloc(32 * 1024 * 1024, 65);
      await writeFile(
        input,
        format === "tar" ? await archive([{ name: "large.bin", content }]) : storedZip(content),
      );
      const extraction = (format === "tar" ? extractTar : extractZip)(
        input,
        join(directory, "result"),
        { signal: controller.signal },
      );
      const rejection = expect(extraction).rejects.toThrow();
      let observedPartial = false;
      while (!observedPartial) {
        for (const name of await readdir(directory)) {
          if (!name.startsWith(".tm-archive-")) continue;
          if (
            (await readdir(join(directory, name))).includes(
              format === "tar" ? "large.bin" : "large.txt",
            )
          )
            observedPartial = true;
        }
        if (!observedPartial) await setImmediate();
      }
      controller.abort(new Error("operator cancelled extraction"));
      await rejection;
      expect(await readdir(directory)).toEqual([`input.${format}`]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
