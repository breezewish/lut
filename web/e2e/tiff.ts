interface TiffImage {
  width: number;
  height: number;
  rgb: Uint16Array;
}

interface TiffComparison {
  width: number;
  height: number;
  maxCodeDifference: number;
}

interface TiffLayout {
  width: number;
  height: number;
  samplesPerPixel: number;
  stripOffsets: number[];
  stripByteCounts: number[];
}

const SHORT = 3;
const LONG = 4;

export function decodeRgb16Tiff(bytes: Buffer): TiffImage {
  const layout = readRgb16TiffLayout(bytes);
  const { width, height, samplesPerPixel, stripOffsets } = layout;

  const raw = Buffer.concat(
    stripOffsets.map((_, index) => decodeStrip(bytes, layout, index)),
  );
  const expectedBytes = width * height * samplesPerPixel * 2;
  if (raw.byteLength !== expectedBytes)
    throw new Error(
      `Expected ${expectedBytes} decoded TIFF bytes, got ${raw.byteLength}.`,
    );

  const rgb = new Uint16Array(width * height * samplesPerPixel);
  for (let index = 0; index < rgb.length; index += 1)
    rgb[index] = raw.readUInt16LE(index * 2);
  return { width, height, rgb };
}

export function compareRgb16Tiffs(
  actualBytes: Buffer,
  expectedBytes: Buffer,
): TiffComparison {
  const actual = readRgb16TiffLayout(actualBytes);
  const expected = readRgb16TiffLayout(expectedBytes);
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(
      `TIFF dimensions differ: ${actual.width}x${actual.height} and ${expected.width}x${expected.height}.`,
    );
  }
  if (actual.stripOffsets.length !== expected.stripOffsets.length) {
    throw new Error("TIFF strip counts differ.");
  }

  let maxCodeDifference = 0;
  let comparedBytes = 0;
  for (let index = 0; index < actual.stripOffsets.length; index += 1) {
    const actualStrip = decodeStrip(actualBytes, actual, index);
    const expectedStrip = decodeStrip(expectedBytes, expected, index);
    if (actualStrip.length !== expectedStrip.length) {
      throw new Error(`TIFF strip ${index} decoded to different lengths.`);
    }
    for (let offset = 0; offset < actualStrip.length; offset += 2) {
      const difference = Math.abs(
        actualStrip.readUInt16LE(offset) - expectedStrip.readUInt16LE(offset),
      );
      maxCodeDifference = Math.max(maxCodeDifference, difference);
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
  };
}

export function readRgb16TiffDimensions(bytes: Buffer): {
  width: number;
  height: number;
} {
  const { width, height } = readRgb16TiffLayout(bytes);
  return { width, height };
}

function readRgb16TiffLayout(bytes: Buffer): TiffLayout {
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

  if (bits.some((value) => value !== 16) || samplesPerPixel !== 3)
    throw new Error("Expected an RGB16 TIFF.");
  if (compression !== 1)
    throw new Error(`Expected uncompressed TIFF data, got ${compression}.`);
  if (stripOffsets.length !== stripByteCounts.length)
    throw new Error("TIFF strip offsets and byte counts do not match.");
  return {
    width,
    height,
    samplesPerPixel,
    stripOffsets,
    stripByteCounts,
  };
}

function decodeStrip(bytes: Buffer, layout: TiffLayout, index: number): Buffer {
  const offset = layout.stripOffsets[index];
  return bytes.subarray(offset, offset + layout.stripByteCounts[index]);
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
