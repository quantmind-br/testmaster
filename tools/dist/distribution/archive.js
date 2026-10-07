import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readlink, realpath, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
export const LICENSE_ASSETS = ["LICENSE", "NOTICE", "containers/NOTICE"];
export const MAX_PART_SIZE = 1024 ** 3;
export const MAX_IMAGE_SIZE = 64 * MAX_PART_SIZE;
export const MAX_RUNTIME_SIZE = 16 * MAX_PART_SIZE;
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function digestFile(path) {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
        size += chunk.length;
    }
    return { sha256: hash.digest("hex"), size };
}
export function safeArchivePath(path) {
    if (!path ||
        isAbsolute(path) ||
        path.includes("\\") ||
        path.includes("\0") ||
        /^[A-Za-z]:/u.test(path) ||
        path.split("/").some((part) => part === ".." || part === "." || part === ""))
        throw new Error(`Unsafe archive path: ${JSON.stringify(path)}`);
    return path;
}
export function safeLink(path, target) {
    safeArchivePath(path);
    if (!target ||
        isAbsolute(target) ||
        target.includes("\\") ||
        target.includes("\0") ||
        /^[A-Za-z]:/u.test(target))
        throw new Error("Unsafe archive symlink");
    const bound = posix.normalize(posix.join(posix.dirname(path), target));
    if (bound === ".." || bound.startsWith("../") || bound === ".")
        throw new Error("Escaping archive symlink");
    return bound;
}
function octal(header, offset, length, value) {
    const text = value.toString(8).padStart(length - 1, "0");
    if (text.length >= length)
        throw new Error("Tar numeric field overflow");
    header.write(text + "\0", offset, length, "ascii");
}
export function tarHeader(path, size, type = "0", link = "", mode = 0o644) {
    safeArchivePath(path);
    const header = Buffer.alloc(512);
    let name = path;
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
        const split = path.lastIndexOf("/");
        prefix = path.slice(0, split);
        name = path.slice(split + 1);
    }
    if (Buffer.byteLength(name) > 100 ||
        Buffer.byteLength(prefix) > 155 ||
        Buffer.byteLength(link) > 100)
        throw new Error(`Tar path too long: ${path}`);
    header.write(name, 0, 100);
    header.write(prefix, 345, 155);
    octal(header, 100, 8, mode);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, size);
    octal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write(link, 157, 100);
    header.write("ustar\0", 257);
    header.write("00", 263);
    octal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
    return header;
}
export async function writeDeterministicArchive(root, paths, output) {
    async function* entries() {
        for (const path of [...paths].sort()) {
            safeArchivePath(path);
            const full = join(root, path);
            const stat = await lstat(full);
            if (stat.isSymbolicLink()) {
                const target = await readlink(full);
                safeLink(path, target);
                yield tarHeader(path, 0, "2", target, 0o777);
            }
            else if (stat.isFile()) {
                yield tarHeader(path, stat.size, "0", "", stat.mode & 0o111 ? 0o755 : 0o644);
                for await (const chunk of createReadStream(full))
                    yield chunk;
                const padding = (512 - (stat.size % 512)) % 512;
                if (padding)
                    yield Buffer.alloc(padding);
            }
            else
                throw new Error(`Unsupported archive entry: ${path}`);
        }
        yield Buffer.alloc(1024);
    }
    await pipeline(Readable.from(entries()), createGzip({ level: 9 }), createWriteStream(output, { flags: "wx", mode: 0o600 }));
    return digestFile(output);
}
class ByteReader {
    iterator;
    buffer = Buffer.alloc(0);
    constructor(stream) {
        this.iterator = stream[Symbol.asyncIterator]();
    }
    async take(count) {
        const parts = [];
        let remaining = count;
        while (remaining) {
            if (!this.buffer.length) {
                const next = await this.iterator.next();
                if (next.done)
                    throw new Error("Truncated tar archive");
                this.buffer = next.value;
            }
            const length = Math.min(remaining, this.buffer.length);
            parts.push(this.buffer.subarray(0, length));
            this.buffer = this.buffer.subarray(length);
            remaining -= length;
        }
        return parts.length === 1 ? parts[0] : Buffer.concat(parts, count);
    }
    async assertEnd() {
        if (this.buffer.some((byte) => byte !== 0))
            throw new Error("Data after tar terminator");
        let trailingSize = this.buffer.length;
        for (;;) {
            const next = await this.iterator.next();
            if (next.done)
                return;
            trailingSize += next.value.length;
            if (trailingSize > 1024 * 1024 || next.value.some((byte) => byte !== 0))
                throw new Error("Excess data after tar terminator");
        }
    }
}
function field(bytes) {
    const zero = bytes.indexOf(0);
    return bytes.subarray(0, zero < 0 ? bytes.length : zero).toString("utf8");
}
function numberField(bytes) {
    const value = field(bytes).trim();
    if (!/^[0-7]+$/u.test(value))
        throw new Error("Invalid tar number");
    const parsed = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(parsed))
        throw new Error("Oversized tar number");
    return parsed;
}
export async function extractSafeArchive(archive, root) {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw new Error("Extraction root must be a directory, not a symlink");
    const input = createReadStream(archive);
    const gzip = createGunzip();
    input.on("error", (error) => gzip.destroy(error));
    input.pipe(gzip);
    const reader = new ByteReader(gzip);
    const seen = new Set();
    const links = new Map();
    const files = [];
    let total = 0;
    let count = 0;
    try {
        for (;;) {
            const header = await reader.take(512);
            if (header.every((byte) => byte === 0)) {
                if (!(await reader.take(512)).every((byte) => byte === 0))
                    throw new Error("Invalid tar terminator");
                await reader.assertEnd();
                break;
            }
            const checksum = numberField(header.subarray(148, 156));
            const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
            if (checksum !== actual || field(header.subarray(257, 263)) !== "ustar")
                throw new Error("Invalid tar header");
            const prefix = field(header.subarray(345, 500));
            const name = field(header.subarray(0, 100));
            const path = safeArchivePath(prefix ? `${prefix}/${name}` : name);
            if (seen.has(path) || ++count > 200_000)
                throw new Error("Duplicate or excessive tar entries");
            seen.add(path);
            const size = numberField(header.subarray(124, 136));
            const type = header.toString("ascii", 156, 157);
            if (!["0", "2", "5"].includes(type))
                throw new Error("Unsupported tar entry (hardlinks and devices forbidden)");
            if (type !== "0" && size !== 0)
                throw new Error("Invalid tar entry size");
            total += size;
            if (total > MAX_RUNTIME_SIZE)
                throw new Error("Runtime archive exceeds extraction bound");
            const full = join(root, path);
            let parent = root;
            for (const component of path.split("/").slice(0, -1)) {
                parent = join(parent, component);
                try {
                    const stat = await lstat(parent);
                    if (!stat.isDirectory() || stat.isSymbolicLink())
                        throw new Error("Archive parent is not a confined directory");
                }
                catch (error) {
                    if (error.code !== "ENOENT")
                        throw error;
                    await mkdir(parent, { mode: 0o700 });
                }
            }
            if (type === "2") {
                const target = field(header.subarray(157, 257));
                safeLink(path, target);
                links.set(path, target);
                files.push({ path, sha256: sha256(target), size: Buffer.byteLength(target) });
            }
            else if (type === "5")
                await mkdir(full, { recursive: true, mode: 0o700 });
            else {
                const handle = await open(full, "wx", numberField(header.subarray(100, 108)) & 0o111 ? 0o700 : 0o600);
                const hash = createHash("sha256");
                try {
                    for (let remaining = size; remaining > 0;) {
                        const bytes = await reader.take(Math.min(remaining, 64 * 1024));
                        hash.update(bytes);
                        await handle.writeFile(bytes);
                        remaining -= bytes.length;
                    }
                }
                finally {
                    await handle.close();
                }
                files.push({ path, sha256: hash.digest("hex"), size });
                const padding = (512 - (size % 512)) % 512;
                if (padding)
                    await reader.take(padding);
            }
        }
        for (const [path, target] of links) {
            for (const other of seen)
                if (other.startsWith(`${path}/`))
                    throw new Error("Tar entry traverses a symlink");
            await symlink(target, join(root, path));
        }
        for (const path of links.keys()) {
            const target = await realpath(join(root, path));
            const rel = relative(resolve(root), target);
            if (rel === ".." ||
                rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
                isAbsolute(rel))
                throw new Error("Symlink resolves outside runtime");
        }
        return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }
    finally {
        input.destroy();
        gzip.destroy();
    }
}
//# sourceMappingURL=archive.js.map