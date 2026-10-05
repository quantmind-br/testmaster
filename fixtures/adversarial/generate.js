import { mkdir, writeFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = entry.data ?? Buffer.from("adversarial fixture\n");
    const compressed = entry.deflate ? deflateRawSync(data) : data;
    const method = entry.deflate ? 8 : 0;
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(0x0314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(checksum, 16);
    c.writeUInt32LE(compressed.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((entry.mode ?? 0o100644) * 65536) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function tar(name, { type = "0", link = "", content = Buffer.from("adversarial fixture\n") } = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write(link, 157, 100);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([
    header,
    content,
    Buffer.alloc((512 - (content.length % 512)) % 512),
    Buffer.alloc(1024),
  ]);
}
const archiveDir = new URL("./archives/", import.meta.url);
await mkdir(archiveDir, { recursive: true });
for (const [name, bytes] of [
  ["zip-slip.zip", zip([{ name: "../../escaped.txt" }])],
  [
    "duplicate-member.zip",
    zip([{ name: "same.txt" }, { name: "same.txt", data: Buffer.from("second member") }]),
  ],
  [
    "zip-bomb.zip",
    zip([{ name: "high-ratio.txt", data: Buffer.alloc(4 * 1024 * 1024, 0x61), deflate: true }]),
  ],
  [
    "symlink.zip",
    zip([{ name: "outside-link", data: Buffer.from("../../outside"), mode: 0o120777 }]),
  ],
  ["absolute-path.tar", tar("/tmp/testmaster-escaped.txt")],
  [
    "symlink.tar",
    tar("outside-link", { type: "2", link: "../../outside", content: Buffer.alloc(0) }),
  ],
])
  await writeFile(new URL(name, archiveDir), bytes);
