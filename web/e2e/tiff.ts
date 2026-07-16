import { inflateSync } from "node:zlib";

interface TiffImage {
  width: number;
  height: number;
  rgb: Uint16Array;
}

interface TiffComparison {
  width: number;
  height: number;
  maxCodeDifference: number;
  maxInteriorCodeDifference: number;
  maxBoundaryCodeDifference: number;
  significantlyDifferentBoundaryPixels: number;
}

const SHORT = 3;
const LONG = 4;

export function decodeRgb16Tiff(bytes: Buffer): TiffImage {
  const { width, height, stripOffsets, stripByteCounts } = inspect(bytes);

  const raw = Buffer.concat(
    stripOffsets.map((offset, index) =>
      inflateSync(bytes.subarray(offset, offset + stripByteCounts[index])),
    ),
  );
  const expectedBytes = width * height * 3 * 2;
  if (raw.byteLength !== expectedBytes)
    throw new Error(
      `Expected ${expectedBytes} decoded TIFF bytes, got ${raw.byteLength}.`,
    );

  const rgb = new Uint16Array(width * height * 3);
  for (let index = 0; index < rgb.length; index += 1)
    rgb[index] = raw.readUInt16LE(index * 2);
  return { width, height, rgb };
}

export function compareRgb16Tiffs(
  actualBytes: Buffer,
  expectedBytes: Buffer,
): TiffComparison {
  const actual = inspect(actualBytes);
  const expected = inspect(expectedBytes);
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(
      `TIFF dimensions differ: ${actual.width}x${actual.height} and ${expected.width}x${expected.height}.`,
    );
  }
  if (actual.stripOffsets.length !== expected.stripOffsets.length) {
    throw new Error("TIFF strip counts differ.");
  }

  let maxCodeDifference = 0;
  let maxInteriorCodeDifference = 0;
  let maxBoundaryCodeDifference = 0;
  let comparedBytes = 0;
  const significantlyDifferentBoundaryPixels = new Set<number>();
  for (let index = 0; index < actual.stripOffsets.length; index += 1) {
    const actualStrip = inflateSync(
      actualBytes.subarray(
        actual.stripOffsets[index],
        actual.stripOffsets[index] + actual.stripByteCounts[index],
      ),
    );
    const expectedStrip = inflateSync(
      expectedBytes.subarray(
        expected.stripOffsets[index],
        expected.stripOffsets[index] + expected.stripByteCounts[index],
      ),
    );
    if (actualStrip.length !== expectedStrip.length) {
      throw new Error(`TIFF strip ${index} decoded to different lengths.`);
    }
    for (let offset = 0; offset < actualStrip.length; offset += 2) {
      const difference = Math.abs(
        actualStrip.readUInt16LE(offset) - expectedStrip.readUInt16LE(offset),
      );
      maxCodeDifference = Math.max(maxCodeDifference, difference);
      if (difference === 0) continue;
      const sample = (comparedBytes + offset) / 2;
      const pixel = Math.floor(sample / 3);
      const row = Math.floor(pixel / actual.width);
      const column = pixel % actual.width;
      const isInterior =
        row !== 0 &&
        row !== actual.height - 1 &&
        column !== 0 &&
        column !== actual.width - 1;
      if (isInterior) {
        maxInteriorCodeDifference = Math.max(
          maxInteriorCodeDifference,
          difference,
        );
      } else {
        maxBoundaryCodeDifference = Math.max(
          maxBoundaryCodeDifference,
          difference,
        );
        if (difference > 1) significantlyDifferentBoundaryPixels.add(pixel);
      }
    }
    comparedBytes += actualStrip.length;
  }
  if (comparedBytes !== actual.width * actual.height * 3 * 2) {
    throw new Error(`TIFF strips contain ${comparedBytes} unexpected bytes.`);
  }
  return {
    width: actual.width,
    height: actual.height,
    maxCodeDifference,
    maxInteriorCodeDifference,
    maxBoundaryCodeDifference,
    significantlyDifferentBoundaryPixels:
      significantlyDifferentBoundaryPixels.size,
  };
}

function inspect(bytes: Buffer) {
  if (bytes.toString("ascii", 0, 2) !== "II" || bytes.readUInt16LE(2) !== 42)
    throw new Error("Expected a little-endian TIFF.");

  const entries = readIfd(bytes);
  const width = required(entries, 256)[0];
  const height = required(entries, 257)[0];
  const bits = required(entries, 258);
  const compression = required(entries, 259)[0];
  const stripOffsets = required(entries, 273);
  const samplesPerPixel = required(entries, 277)[0];
  const stripByteCounts = required(entries, 279);
  const predictor = entries.get(317)?.[0] ?? 1;

  if (bits.some((value) => value !== 16) || samplesPerPixel !== 3)
    throw new Error("Expected an RGB16 TIFF.");
  if (compression !== 8 && compression !== 32_946)
    throw new Error(`Expected Deflate compression, got ${compression}.`);
  if (predictor !== 1)
    throw new Error(`Unsupported TIFF predictor ${predictor}.`);
  if (stripOffsets.length !== stripByteCounts.length)
    throw new Error("TIFF strip offsets and byte counts do not match.");
  return { width, height, stripOffsets, stripByteCounts };
}

function readIfd(bytes: Buffer): Map<number, number[]> {
  const offset = bytes.readUInt32LE(4);
  const count = bytes.readUInt16LE(offset);
  const entries = new Map<number, number[]>();
  for (let index = 0; index < count; index += 1) {
    const entry = offset + 2 + index * 12;
    const tag = bytes.readUInt16LE(entry);
    const type = bytes.readUInt16LE(entry + 2);
    const valueCount = bytes.readUInt32LE(entry + 4);
    const valueSize = type === SHORT ? 2 : type === LONG ? 4 : 0;
    if (valueSize === 0) continue;
    const valuesOffset =
      valueCount * valueSize <= 4 ? entry + 8 : bytes.readUInt32LE(entry + 8);
    const values = Array.from({ length: valueCount }, (_, valueIndex) =>
      type === SHORT
        ? bytes.readUInt16LE(valuesOffset + valueIndex * valueSize)
        : bytes.readUInt32LE(valuesOffset + valueIndex * valueSize),
    );
    entries.set(tag, values);
  }
  return entries;
}

function required(entries: Map<number, number[]>, tag: number): number[] {
  const values = entries.get(tag);
  if (!values) throw new Error(`Missing required TIFF tag ${tag}.`);
  return values;
}
