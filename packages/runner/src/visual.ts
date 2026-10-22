import { Buffer } from "node:buffer";
import { deflateSync, inflateSync } from "node:zlib";

/** A decoded raster: `data` is RGBA, 8 bits per channel, row-major, length `width * height * 4`. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** A rectangle in image pixels; fractional and out-of-bounds values are allowed and clamped when painted. */
export interface MaskRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Thrown for any PNG outside the supported subset or corrupt, so callers can block the step instead of guessing. */
export class UnsupportedPngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedPngError";
  }
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Largest inflated pixel payload accepted; bounds memory for a hostile baseline. */
const MAX_RAW_BYTES = 1 << 30;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(parts: readonly Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      crc = (CRC_TABLE[(crc ^ (part[i] as number)) & 0xff] as number) ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

/** Decodes a non-interlaced 8-bit RGB/RGBA PNG into RGBA, verifying every chunk CRC, and rejects everything else with `UnsupportedPngError`. */
export function decodePng(bytes: Uint8Array): RgbaImage {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < SIGNATURE.length || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new UnsupportedPngError("not a PNG: bad signature");
  }
  let offset = 8;
  let header: { width: number; height: number; channels: 3 | 4 } | undefined;
  const idat: Buffer[] = [];
  let sawEnd = false;
  while (!sawEnd) {
    if (offset + 12 > buffer.length) {
      throw new UnsupportedPngError("truncated PNG: chunk header or IEND missing");
    }
    const length = buffer.readUInt32BE(offset);
    const typeBytes = buffer.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("latin1");
    if (offset + 12 + length > buffer.length) {
      throw new UnsupportedPngError(`truncated PNG: chunk ${type} exceeds the input`);
    }
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    const stored = buffer.readUInt32BE(offset + 8 + length);
    if (crc32([typeBytes, body]) !== stored) {
      throw new UnsupportedPngError(`corrupt PNG: CRC mismatch in chunk ${type}`);
    }
    offset += 12 + length;
    if (header === undefined && type !== "IHDR") {
      throw new UnsupportedPngError(`corrupt PNG: first chunk is ${type}, expected IHDR`);
    }
    if (type === "IHDR") {
      if (header !== undefined) {
        throw new UnsupportedPngError("corrupt PNG: duplicate IHDR");
      }
      if (length !== 13) {
        throw new UnsupportedPngError(`corrupt PNG: IHDR length ${length}, expected 13`);
      }
      const width = body.readUInt32BE(0);
      const height = body.readUInt32BE(4);
      const depth = body[8];
      const colorType = body[9];
      if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) {
        throw new UnsupportedPngError(`corrupt PNG: invalid dimensions ${width}x${height}`);
      }
      if (depth !== 8) {
        throw new UnsupportedPngError(`unsupported PNG bit depth ${depth}, only 8 is supported`);
      }
      if (colorType !== 2 && colorType !== 6) {
        throw new UnsupportedPngError(
          `unsupported PNG color type ${colorType}, only 2 (RGB) and 6 (RGBA) are supported`,
        );
      }
      if (body[10] !== 0) {
        throw new UnsupportedPngError(`unsupported PNG compression method ${body[10]}`);
      }
      if (body[11] !== 0) {
        throw new UnsupportedPngError(`unsupported PNG filter method ${body[11]}`);
      }
      if (body[12] !== 0) {
        throw new UnsupportedPngError(
          `unsupported PNG interlace method ${body[12]}, only non-interlaced is supported`,
        );
      }
      header = { width, height, channels: colorType === 2 ? 3 : 4 };
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      sawEnd = true;
    } else if ((typeBytes[0] as number) & 0x20) {
      // Ancillary chunk: safe to ignore.
    } else if (type !== "PLTE") {
      // A PLTE chunk is legal (advisory) in truecolor images; any other unknown critical chunk is not.
      throw new UnsupportedPngError(`unsupported critical PNG chunk ${type}`);
    }
  }
  if (header === undefined) {
    throw new UnsupportedPngError("corrupt PNG: IHDR missing");
  }
  if (idat.length === 0) {
    throw new UnsupportedPngError("corrupt PNG: no IDAT chunk");
  }
  const { width, height, channels } = header;
  const stride = width * channels;
  const expected = height * (stride + 1);
  if (expected > MAX_RAW_BYTES) {
    throw new UnsupportedPngError(
      `unsupported PNG: ${width}x${height} exceeds the ${MAX_RAW_BYTES} byte decode limit`,
    );
  }
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch (error) {
    throw new UnsupportedPngError(
      `corrupt PNG: IDAT data cannot be inflated to ${expected} bytes (${(error as Error).message})`,
    );
  }
  if (raw.length !== expected) {
    throw new UnsupportedPngError(
      `corrupt PNG: inflated ${raw.length} bytes, expected ${expected}`,
    );
  }

  const pixels = new Uint8Array(width * height * 4);
  const current = new Uint8Array(stride);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart] as number;
    if (filter > 4) {
      throw new UnsupportedPngError(`corrupt PNG: filter type ${filter} on row ${y}`);
    }
    for (let i = 0; i < stride; i++) {
      const x = raw[rowStart + 1 + i] as number;
      const left = i >= channels ? (current[i - channels] as number) : 0;
      const up = previous[i] as number;
      const upLeft = i >= channels ? (previous[i - channels] as number) : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + left;
          break;
        case 2:
          value = x + up;
          break;
        case 3:
          value = x + ((left + up) >> 1);
          break;
        default:
          value = x + paeth(left, up, upLeft);
      }
      current[i] = value & 0xff;
    }
    for (let px = 0; px < width; px++) {
      const src = px * channels;
      const dst = (y * width + px) * 4;
      pixels[dst] = current[src] as number;
      pixels[dst + 1] = current[src + 1] as number;
      pixels[dst + 2] = current[src + 2] as number;
      pixels[dst + 3] = channels === 4 ? (current[src + 3] as number) : 255;
    }
    previous = Uint8Array.from(current);
  }
  return { width, height, data: pixels };
}

function chunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "latin1");
  out.set(body, 8);
  out.writeUInt32BE(crc32([out.subarray(4, 8), body]), 8 + body.length);
  return out;
}

/** Encodes RGBA as an unfiltered, level-9 PNG so equal pixels always produce identical bytes. */
export function encodePng(image: RgbaImage): Buffer {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) {
    throw new RangeError(`RGBA data length ${data.length} does not match ${width}x${height}`);
  }
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Paints each mask opaque magenta on a copy, so identical masks on two images hide every change beneath them. */
export function paintMasks(image: RgbaImage, masks: readonly MaskRect[]): RgbaImage {
  const data = Uint8Array.from(image.data);
  for (const mask of masks) {
    if (![mask.x, mask.y, mask.width, mask.height].every(Number.isFinite)) {
      continue;
    }
    const x0 = Math.max(0, Math.floor(mask.x));
    const y0 = Math.max(0, Math.floor(mask.y));
    const x1 = Math.min(image.width, Math.ceil(mask.x + mask.width));
    const y1 = Math.min(image.height, Math.ceil(mask.y + mask.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * image.width + x) * 4;
        data[i] = 255;
        data[i + 1] = 0;
        data[i + 2] = 255;
        data[i + 3] = 255;
      }
    }
  }
  return { width: image.width, height: image.height, data };
}

/** The outcome of comparing two images; `diff` is a viewable overlay whose size always matches `totalPixels`. */
export interface VisualDiff {
  readonly sizeMismatch: boolean;
  readonly diffPixels: number;
  readonly totalPixels: number;
  readonly diff: RgbaImage;
}

/** pixelmatch's default tolerance (threshold 0.1) applied to the maximum YIQ delta. */
const MAX_DELTA = 35215 * 0.1 * 0.1;

function blendOverWhite(channel: number, alpha: number): number {
  return 255 + (channel - 255) * alpha;
}

function yiqDelta(a: Uint8Array, b: Uint8Array, i: number): number {
  const alphaA = (a[i + 3] as number) / 255;
  const alphaB = (b[i + 3] as number) / 255;
  const r1 = blendOverWhite(a[i] as number, alphaA);
  const g1 = blendOverWhite(a[i + 1] as number, alphaA);
  const b1 = blendOverWhite(a[i + 2] as number, alphaA);
  const r2 = blendOverWhite(b[i] as number, alphaB);
  const g2 = blendOverWhite(b[i + 1] as number, alphaB);
  const b2 = blendOverWhite(b[i + 2] as number, alphaB);
  const y = 0.29889531 * (r1 - r2) + 0.58662247 * (g1 - g2) + 0.11448223 * (b1 - b2);
  const iDelta = 0.59597799 * (r1 - r2) - 0.2741761 * (g1 - g2) - 0.32180189 * (b1 - b2);
  const q = 0.21147017 * (r1 - r2) - 0.52261711 * (g1 - g2) + 0.31114694 * (b1 - b2);
  return 0.5053 * y * y + 0.299 * iDelta * iDelta + 0.1957 * q * q;
}

/** Counts perceptually different pixels with pixelmatch's YIQ delta; differently sized images are wholly different, never partially compared. */
export function diffImages(actual: RgbaImage, baseline: RgbaImage): VisualDiff {
  if (actual.width !== baseline.width || actual.height !== baseline.height) {
    const width = Math.max(actual.width, baseline.width);
    const height = Math.max(actual.height, baseline.height);
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255;
      data[i + 3] = 255;
    }
    const totalPixels = width * height;
    return {
      sizeMismatch: true,
      diffPixels: totalPixels,
      totalPixels,
      diff: { width, height, data },
    };
  }
  const totalPixels = actual.width * actual.height;
  const data = new Uint8Array(totalPixels * 4);
  let diffPixels = 0;
  for (let p = 0; p < totalPixels; p++) {
    const i = p * 4;
    if (yiqDelta(actual.data, baseline.data, i) > MAX_DELTA) {
      diffPixels++;
      data[i] = 255;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 255;
      continue;
    }
    const alpha = (actual.data[i + 3] as number) / 255;
    const luma =
      0.29889531 * blendOverWhite(actual.data[i] as number, alpha) +
      0.58662247 * blendOverWhite(actual.data[i + 1] as number, alpha) +
      0.11448223 * blendOverWhite(actual.data[i + 2] as number, alpha);
    const faded = Math.round(blendOverWhite(luma, 0.1));
    data[i] = faded;
    data[i + 1] = faded;
    data[i + 2] = faded;
    data[i + 3] = 255;
  }
  return {
    sizeMismatch: false,
    diffPixels,
    totalPixels,
    diff: { width: actual.width, height: actual.height, data },
  };
}

/** Passes only a same-size comparison whose differing fraction is at most `threshold` (inclusive), 0..1. */
export function visualPasses(diff: VisualDiff, threshold: number): boolean {
  return !diff.sizeMismatch && diff.diffPixels / diff.totalPixels <= threshold;
}
