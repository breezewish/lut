import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import createLibRaw from "../web/src/libraw/libraw.js";

const algorithms = [
  { name: "AHD", quality: 3 },
  { name: "DCB", quality: 4 },
  { name: "AAHD", quality: 12 },
];
const arguments_ = process.argv.slice(2);
const fixture = resolve(
  argumentValue("--fixture") ?? "vendor/LibRaw-Wasm/example-sony.ARW",
);
const output = argumentValue("--output");
const samples = Number(argumentValue("--samples") ?? "5");
const warmups = Number(argumentValue("--warmups") ?? "1");
const halfSize = arguments_.includes("--half-size");
const crop = parseCrop(argumentValue("--crop"));
const cropDirectory = argumentValue("--crop-dir");

if ((crop === undefined) !== (cropDirectory === undefined)) {
  throw new Error("--crop and --crop-dir must be provided together");
}

if (!Number.isInteger(samples) || samples < 1) {
  throw new Error("--samples must be a positive integer");
}
if (!Number.isInteger(warmups) || warmups < 0) {
  throw new Error("--warmups must be a non-negative integer");
}

const [rawBytes, wasmBytes] = await Promise.all([
  readFile(fixture),
  readFile(resolve("web/src/libraw/libraw.wasm")),
]);
const module = await createLibRaw({ wasmBinary: wasmBytes });
const results = [];
const signatures = new Map();

for (const algorithm of algorithms) {
  const runs = [];
  for (let index = 0; index < warmups + samples; index += 1) {
    const raw = new module.LibRaw();
    try {
      raw.openWithQuality(
        new Uint8Array(rawBytes),
        halfSize,
        algorithm.quality,
      );
      const image = raw.imageInfo();
      const timings = raw.timings();
      if (index >= warmups) runs.push(timings);
      if (index === warmups + samples - 1) {
        const pixels = raw.imageView(0, image.sampleCount);
        signatures.set(
          algorithm.name,
          qualitySignature(pixels, image.width, image.height),
        );
        if (crop && cropDirectory) {
          await mkdir(resolve(cropDirectory), { recursive: true });
          await writeFile(
            resolve(cropDirectory, `${algorithm.name.toLowerCase()}.ppm`),
            renderCrop(pixels, image.width, image.height, crop),
          );
        }
      }
    } finally {
      raw.delete();
    }
  }
  results.push({
    algorithm: algorithm.name,
    quality: algorithm.quality,
    timingsMs: summarizeRuns(runs),
    imageSignature: signatures.get(algorithm.name).summary,
  });
}

const report = {
  schemaVersion: 1,
  fixture,
  fixtureBytes: rawBytes.byteLength,
  halfSize,
  warmups,
  samples,
  qualityCrop: crop
    ? {
        x: crop[0],
        y: crop[1],
        width: crop[2],
        height: crop[3],
      }
    : null,
  algorithms: results,
  pairwiseSampledDifferences: pairwiseDifferences(signatures),
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (output) await writeFile(resolve(output), json);
process.stdout.write(json);

function argumentValue(name) {
  const argument = arguments_.find((value) => value.startsWith(`${name}=`));
  return argument?.slice(name.length + 1);
}

function parseCrop(value) {
  if (!value) return undefined;
  const parts = value.split(",").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0) ||
    parts[2] === 0 ||
    parts[3] === 0
  ) {
    throw new Error("--crop must be x,y,width,height with positive dimensions");
  }
  return parts;
}

function renderCrop(pixels, imageWidth, imageHeight, [x, y, width, height]) {
  if (x + width > imageWidth || y + height > imageHeight) {
    throw new Error("--crop exceeds decoded image dimensions");
  }
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
  const data = Buffer.allocUnsafe(width * height * 3);
  let target = 0;
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      const source = (row * imageWidth + column) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const linear = Math.min(1, (pixels[source + channel] / 65_535) * 4);
        const srgb =
          linear <= 0.003_130_8
            ? linear * 12.92
            : 1.055 * linear ** (1 / 2.4) - 0.055;
        data[target] = Math.round(srgb * 255);
        target += 1;
      }
    }
  }
  return Buffer.concat([header, data]);
}

function summarizeRuns(runs) {
  const keys = Object.keys(runs[0]).filter(
    (key) => key !== "quality" && typeof runs[0][key] === "number",
  );
  return Object.fromEntries(
    keys.map((key) => {
      const values = runs.map((run) => run[key]).sort((a, b) => a - b);
      return [
        key,
        {
          median: percentile(values, 0.5),
          p95: percentile(values, 0.95),
          min: values[0],
          max: values.at(-1),
        },
      ];
    }),
  );
}

function percentile(values, fraction) {
  const position = (values.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return values[lower] * (1 - weight) + values[upper] * weight;
}

function qualitySignature(pixels, width, height) {
  const step = 16;
  const sampled = new Uint16Array(
    Math.ceil(width / step) * Math.ceil(height / step) * 3,
  );
  const sums = [0, 0, 0];
  let clipped = 0;
  let target = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const source = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = pixels[source + channel];
        sampled[target] = value;
        sums[channel] += value;
        if (value === 0 || value === 65_535) clipped += 1;
        target += 1;
      }
    }
  }
  return {
    samples: sampled,
    summary: {
      sampleStridePixels: step,
      sampleCount: sampled.length / 3,
      channelMeans: sums.map((sum) => sum / (sampled.length / 3)),
      clippedFraction: clipped / sampled.length,
    },
  };
}

function pairwiseDifferences(signatures) {
  const pairs = [];
  for (let left = 0; left < algorithms.length; left += 1) {
    for (let right = left + 1; right < algorithms.length; right += 1) {
      const a = signatures.get(algorithms[left].name).samples;
      const b = signatures.get(algorithms[right].name).samples;
      let squaredError = 0;
      let absoluteError = 0;
      let maxDifference = 0;
      for (let index = 0; index < a.length; index += 1) {
        const difference = Math.abs(a[index] - b[index]);
        absoluteError += difference;
        squaredError += difference * difference;
        maxDifference = Math.max(maxDifference, difference);
      }
      const mse = squaredError / a.length;
      pairs.push({
        left: algorithms[left].name,
        right: algorithms[right].name,
        meanAbsoluteCodeDifference: absoluteError / a.length,
        maxCodeDifference: maxDifference,
        psnrDb: mse === 0 ? null : 10 * Math.log10(65_535 ** 2 / mse),
        interpretation:
          "Pairwise difference only; this is not a ground-truth quality score.",
      });
    }
  }
  return pairs;
}
