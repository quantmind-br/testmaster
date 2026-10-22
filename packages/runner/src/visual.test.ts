import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decodePng,
  diffImages,
  encodePng,
  type MaskRect,
  paintMasks,
  type RgbaImage,
  UnsupportedPngError,
  type VisualDiff,
  visualPasses,
} from "./visual.js";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Independent bitwise CRC-32 (the module uses a table), so a shared table bug cannot hide itself.
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const out = Buffer.alloc(8 + body.length + 4);
  out.writeUInt32BE(body.length, 0);
  typed.copy(out, 4);
  out.writeUInt32BE(crc32(typed), 8 + body.length);
  return out;
}

function ihdr(
  width: number,
  height: number,
  depth: number,
  colorType: number,
  interlace: number,
): Buffer {
  const body = Buffer.alloc(13);
  body.writeUInt32BE(width, 0);
  body.writeUInt32BE(height, 4);
  body[8] = depth;
  body[9] = colorType;
  body[12] = interlace;
  return body;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

/** Forward-filters one scanline (PNG spec section 9) for the given type. */
function filterRow(type: number, row: Uint8Array, prior: Uint8Array, bpp: number): Buffer {
  const out = Buffer.alloc(1 + row.length);
  out[0] = type;
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? (row[i - bpp] as number) : 0;
    const b = prior[i] as number;
    const c = i >= bpp ? (prior[i - bpp] as number) : 0;
    const predicted = [0, a, b, (a + b) >> 1, paethPredictor(a, b, c)][type] as number;
    out[1 + i] = ((row[i] as number) - predicted) & 0xff;
  }
  return out;
}

/** Builds a PNG from channel rows, one filter type per row. */
function buildPng(rows: Uint8Array[], channels: 3 | 4, filters: number[]): Buffer {
  const width = (rows[0] as Uint8Array).length / channels;
  let prior: Uint8Array = new Uint8Array(width * channels);
  const filtered = rows.map((row, y) => {
    const out = filterRow(filters[y] as number, row, prior, channels);
    prior = row;
    return out;
  });
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr(width, rows.length, 8, channels === 3 ? 2 : 6, 0)),
    chunk("IDAT", deflateSync(Buffer.concat(filtered))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Deterministic pseudo-random bytes with large inter-pixel steps so Sub/Up/Average/Paeth all differ from None
// and byte wrap-around is exercised.
function channelRows(width: number, height: number, channels: 3 | 4): Uint8Array[] {
  let state = 12345;
  return Array.from({ length: height }, () =>
    Uint8Array.from({ length: width * channels }, () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return (state >> 16) & 0xff;
    }),
  );
}

function solid(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data.set(rgba, i);
  }
  return { width, height, data };
}

function withPixel(
  image: RgbaImage,
  x: number,
  y: number,
  rgba: [number, number, number, number],
): RgbaImage {
  const data = Uint8Array.from(image.data);
  data.set(rgba, (y * image.width + x) * 4);
  return { width: image.width, height: image.height, data };
}

describe("PNG codec", () => {
  it("round-trips a 37x23 image with varied colours and alpha and re-encodes to identical bytes", () => {
    const width = 37;
    const height = 23;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        data.set(
          [
            (x * 7) & 0xff,
            (y * 11) & 0xff,
            (x * y) & 0xff,
            x % 5 === 0 ? 0 : 255 - ((x + y) % 4) * 60,
          ],
          (y * width + x) * 4,
        );
      }
    }
    const image = { width, height, data };
    const first = encodePng(image);
    const decoded = decodePng(first);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(Buffer.from(decoded.data).equals(Buffer.from(data))).toBe(true);
    expect(encodePng(decoded).equals(first)).toBe(true);
  });

  for (const channels of [3, 4] as const) {
    it(`decodes filter types 0-4 on ${channels === 3 ? "RGB" : "RGBA"} rows to the original pixels`, () => {
      const width = 9;
      const rows = channelRows(width, 5, channels);
      const decoded = decodePng(buildPng(rows, channels, [0, 1, 2, 3, 4]));
      expect(decoded.width).toBe(width);
      expect(decoded.height).toBe(5);
      const expected = new Uint8Array(width * 5 * 4);
      rows.forEach((row, y) => {
        for (let x = 0; x < width; x++) {
          const alpha = channels === 4 ? (row[x * 4 + 3] as number) : 255;
          expected.set(
            [
              row[x * channels] as number,
              row[x * channels + 1] as number,
              row[x * channels + 2] as number,
              alpha,
            ],
            (y * width + x) * 4,
          );
        }
      });
      expect(Buffer.from(decoded.data).equals(Buffer.from(expected))).toBe(true);
    });

    for (const [type, name] of [
      [1, "Sub"],
      [2, "Up"],
      [3, "Average"],
      [4, "Paeth"],
    ] as const) {
      it(`decodes ${name} on every row of a ${channels}-channel image, including row 0 with no prior row`, () => {
        const rows = channelRows(6, 4, channels);
        const decoded = decodePng(buildPng(rows, channels, [type, type, type, type]));
        const reference = decodePng(buildPng(rows, channels, [0, 0, 0, 0]));
        expect(Buffer.from(decoded.data).equals(Buffer.from(reference.data))).toBe(true);
      });
    }
  }

  it("rejects a corrupted chunk CRC", () => {
    const png = encodePng(solid(3, 3, [1, 2, 3, 255]));
    const corrupt = Buffer.from(png);
    // Flip a bit inside the IDAT body: the CRC no longer matches, but inflating might still succeed.
    corrupt[corrupt.length - 12 - 6] = (corrupt[corrupt.length - 12 - 6] as number) ^ 0x01;
    expect(() => decodePng(corrupt)).toThrow(UnsupportedPngError);
    expect(() => decodePng(corrupt)).toThrow(/CRC mismatch/);
  });

  it("rejects an interlaced PNG", () => {
    const png = Buffer.concat([
      SIGNATURE,
      chunk("IHDR", ihdr(1, 1, 8, 6, 1)),
      chunk("IDAT", deflateSync(Buffer.from([0, 1, 2, 3, 4]))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(() => decodePng(png)).toThrow(UnsupportedPngError);
    expect(() => decodePng(png)).toThrow(/interlace/);
  });

  it("rejects a 16-bit PNG", () => {
    const png = Buffer.concat([
      SIGNATURE,
      chunk("IHDR", ihdr(1, 1, 16, 6, 0)),
      chunk("IDAT", deflateSync(Buffer.alloc(9))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(() => decodePng(png)).toThrow(UnsupportedPngError);
    expect(() => decodePng(png)).toThrow(/bit depth 16/);
  });

  it("rejects a palette PNG, a filter byte above 4, truncation, a wrong inflated length and an unknown critical chunk", () => {
    const base = (idat: Buffer) => [
      SIGNATURE,
      chunk("IHDR", ihdr(1, 1, 8, 6, 0)),
      chunk("IDAT", idat),
    ];
    const end = chunk("IEND", Buffer.alloc(0));
    const palette = Buffer.concat([
      SIGNATURE,
      chunk("IHDR", ihdr(1, 1, 8, 3, 0)),
      chunk("IDAT", deflateSync(Buffer.alloc(2))),
      end,
    ]);
    expect(() => decodePng(palette)).toThrow(/color type 3/);
    const badFilter = Buffer.concat([...base(deflateSync(Buffer.from([5, 0, 0, 0, 0]))), end]);
    expect(() => decodePng(badFilter)).toThrow(/filter type 5/);
    const good = Buffer.concat([...base(deflateSync(Buffer.from([0, 0, 0, 0, 0]))), end]);
    expect(() => decodePng(good.subarray(0, good.length - 5))).toThrow(UnsupportedPngError);
    const short = Buffer.concat([...base(deflateSync(Buffer.from([0, 0, 0, 0]))), end]);
    expect(() => decodePng(short)).toThrow(UnsupportedPngError);
    const long = Buffer.concat([...base(deflateSync(Buffer.from([0, 0, 0, 0, 0, 0]))), end]);
    expect(() => decodePng(long)).toThrow(UnsupportedPngError);
    const unknown = Buffer.concat([
      ...base(deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
      chunk("ABCD", Buffer.alloc(0)),
      end,
    ]);
    expect(() => decodePng(unknown)).toThrow(/critical PNG chunk ABCD/);
    const ancillary = Buffer.concat([
      ...base(deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
      chunk("abCD", Buffer.alloc(0)),
      end,
    ]);
    expect(Array.from(decodePng(ancillary).data)).toEqual([0, 0, 0, 0]);
    expect(() => decodePng(Buffer.from("not a png at all"))).toThrow(/signature/);
  });
});

describe("visual diff", () => {
  const base = solid(10, 10, [200, 200, 200, 255]);

  it("counts one pixel for a strong change and none for a change below the YIQ tolerance", () => {
    const changed = diffImages(withPixel(base, 4, 5, [0, 0, 0, 255]), base);
    expect(changed.sizeMismatch).toBe(false);
    expect(changed.diffPixels).toBe(1);
    expect(changed.totalPixels).toBe(100);
    expect(Array.from(changed.diff.data.subarray((5 * 10 + 4) * 4, (5 * 10 + 4) * 4 + 4))).toEqual([
      255, 0, 0, 255,
    ]);
    // Unchanged pixels are never red.
    expect(Array.from(changed.diff.data.subarray(0, 4))[0]).not.toBe(255);

    expect(diffImages(withPixel(base, 4, 5, [201, 200, 200, 255]), base).diffPixels).toBe(0);
    expect(diffImages(base, base).diffPixels).toBe(0);
  });

  it("treats transparent pixels as white when comparing", () => {
    const transparent = solid(2, 2, [0, 0, 0, 0]);
    expect(diffImages(transparent, solid(2, 2, [255, 255, 255, 255])).diffPixels).toBe(0);
    expect(diffImages(transparent, solid(2, 2, [0, 0, 0, 255])).diffPixels).toBe(4);
  });

  it("reports a size mismatch as fully different with a red larger-size diff", () => {
    const diff = diffImages(solid(3, 2, [1, 1, 1, 255]), solid(2, 4, [1, 1, 1, 255]));
    expect(diff.sizeMismatch).toBe(true);
    expect(diff.totalPixels).toBe(12);
    expect(diff.diffPixels).toBe(12);
    expect(diff.diff.width).toBe(3);
    expect(diff.diff.height).toBe(4);
    expect(Array.from(diff.diff.data.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(diff.diff.data.subarray(44, 48))).toEqual([255, 0, 0, 255]);
  });
});

describe("paintMasks", () => {
  const baseline = solid(10, 10, [200, 200, 200, 255]);
  const actual = withPixel(baseline, 4, 5, [0, 0, 0, 255]);
  const mask = (over: MaskRect[]) =>
    diffImages(paintMasks(actual, over), paintMasks(baseline, over)).diffPixels;

  it("hides a change under a mask painted on both images and keeps a change outside it", () => {
    expect(mask([{ x: 3, y: 4, width: 3, height: 3 }])).toBe(0);
    expect(mask([{ x: 0, y: 0, width: 3, height: 3 }])).toBe(1);
    expect(mask([])).toBe(1);
  });

  it("covers fractional rectangles outwards and clamps to the image", () => {
    const painted = paintMasks(baseline, [{ x: 1.5, y: 1.2, width: 1, height: 1 }]);
    const magenta = (x: number, y: number) =>
      Array.from(painted.data.subarray((y * 10 + x) * 4, (y * 10 + x) * 4 + 4)).join(",") ===
      "255,0,255,255";
    // x 1.5..2.5 covers columns 1,2 ; y 1.2..2.2 covers rows 1,2.
    expect([
      magenta(1, 1),
      magenta(2, 2),
      magenta(0, 1),
      magenta(3, 1),
      magenta(1, 0),
      magenta(1, 3),
    ]).toEqual([true, true, false, false, false, false]);

    const clamped = paintMasks(baseline, [{ x: -5, y: 8, width: 100, height: 100 }]);
    expect(Array.from(clamped.data.subarray(0, 4))).toEqual([200, 200, 200, 255]);
    expect(Array.from(clamped.data.subarray((9 * 10 + 9) * 4, (9 * 10 + 9) * 4 + 4))).toEqual([
      255, 0, 255, 255,
    ]);
    expect(Array.from(clamped.data.subarray(8 * 10 * 4, 8 * 10 * 4 + 4))).toEqual([
      255, 0, 255, 255,
    ]);
  });

  it("ignores masks fully outside and never mutates its input", () => {
    const snapshot = Uint8Array.from(baseline.data);
    const painted = paintMasks(baseline, [
      { x: 20, y: 20, width: 5, height: 5 },
      { x: -10, y: -10, width: 5, height: 5 },
    ]);
    expect(Buffer.from(painted.data).equals(Buffer.from(snapshot))).toBe(true);
    paintMasks(baseline, [{ x: 0, y: 0, width: 10, height: 10 }]);
    expect(Buffer.from(baseline.data).equals(Buffer.from(snapshot))).toBe(true);
  });
});

describe("visualPasses", () => {
  const oneOfHundred: VisualDiff = diffImages(
    withPixel(solid(10, 10, [200, 200, 200, 255]), 0, 0, [0, 0, 0, 255]),
    solid(10, 10, [200, 200, 200, 255]),
  );

  it("accepts a differing fraction equal to the threshold and rejects one above it", () => {
    expect(oneOfHundred.diffPixels).toBe(1);
    expect(visualPasses(oneOfHundred, 0.01)).toBe(true);
    expect(visualPasses(oneOfHundred, 0.0099)).toBe(false);
    expect(visualPasses(oneOfHundred, 0)).toBe(false);
  });

  it("passes identical images at threshold 0 and never passes a size mismatch", () => {
    const base = solid(4, 4, [9, 9, 9, 255]);
    expect(visualPasses(diffImages(base, base), 0)).toBe(true);
    expect(visualPasses(diffImages(base, solid(4, 5, [9, 9, 9, 255])), 1)).toBe(false);
  });
});
