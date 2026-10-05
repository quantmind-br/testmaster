import { writeFile } from "node:fs/promises";

function pdf(objects) {
  const parts = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [0];
  let length = parts[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(length);
    const object = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      Buffer.isBuffer(objects[i]) ? objects[i] : Buffer.from(objects[i]),
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(object);
    length += object.length;
  }
  const xref = length;
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}
function stream(content, properties = "") {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([
    Buffer.from(`<< /Length ${bytes.length} ${properties} >>\nstream\n`),
    bytes,
    Buffer.from("\nendstream"),
  ]);
}
const common = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"];
await writeFile(
  new URL("./requirements-text.pdf", import.meta.url),
  pdf([
    ...common,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream(
      "BT /F1 16 Tf 50 740 Td (Reference Shop Requirements) Tj 0 -30 Td (Empty carts must not create orders.) Tj 0 -25 Td (Orders persist after reload.) Tj ET",
    ),
  ]),
);
await writeFile(
  new URL("./requirements-image-only.pdf", import.meta.url),
  pdf([
    ...common,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
    stream(
      Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0]),
      "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8",
    ),
    stream("q 400 0 0 400 50 200 cm /Im1 Do Q"),
  ]),
);

// The corpus baseline digest covers ordered path names and the exact application bytes.
const { createHash } = await import("node:crypto");
const { readFile } = await import("node:fs/promises");
const manifestUrl = new URL("../../../evals/corpus/manifest.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const root = new URL("../../../", import.meta.url);
const hash = createHash("sha256");
for (const path of manifest.cases[0].baseline.files) {
  hash.update(`${path}\0`);
  hash.update(await readFile(new URL(path, root)));
}
const digest = hash.digest("hex");
for (const entry of manifest.cases) entry.baseline.digest = digest;
await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
