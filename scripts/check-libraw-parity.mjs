import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import createLibRaw from "../web/src/libraw/libraw.js";

const root = resolve(import.meta.dirname, "..");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "raw-alchemy-"));
const fixtures = [
  {
    name: "synthetic LinearRaw DNG",
    path: "tests/fixtures/linear.dng",
    halfSize: false,
  },
  {
    name: "synthetic lossy LinearRaw DNG",
    path: "vendor/LibRaw-Wasm/test/integration/lossy.dng",
    halfSize: false,
  },
  {
    name: "real Leica M8 CFA DNG",
    path: "tests/fixtures/leica-m8.dng",
    halfSize: false,
    aahdBoundary: { maxDifferentPixels: 1, maxSampleDelta: 4_096 },
  },
  {
    name: "real Leica M8 CFA DNG half-size",
    path: "tests/fixtures/leica-m8.dng",
    halfSize: true,
  },
];

try {
  const wasmBytes = await readFile(join(root, "web/src/libraw/libraw.wasm"));
  const module = await createLibRaw({ wasmBinary: wasmBytes });

  for (const [fixtureIndex, fixture] of fixtures.entries()) {
    const nativeOutput = join(temporaryDirectory, `${fixtureIndex}.rgb16`);
    const nativeArguments = [
      "run",
      "--quiet",
      "-p",
      "alchemy-libraw",
      "--example",
      "decode_rgb16",
      "--",
      fixture.path,
      nativeOutput,
    ];
    if (fixture.halfSize) nativeArguments.push("--half-size");
    await promisify(execFile)("cargo", nativeArguments, { cwd: root });

    const [rawBytes, nativeBytes] = await Promise.all([
      readFile(join(root, fixture.path)),
      readFile(nativeOutput),
    ]);
    const raw = new module.LibRaw();
    try {
      raw.open(new Uint8Array(rawBytes), fixture.halfSize);
      const image = raw.imageInfo();
      const pixels = raw.imageView(0, image.sampleCount);
      const firstPixel = raw.imageView(0, 3);
      const lastPixel = raw.imageView(image.sampleCount - 3, 3);
      if (
        firstPixel.buffer !== pixels.buffer ||
        lastPixel.buffer !== pixels.buffer
      ) {
        throw new Error(
          `${fixture.name}: LibRaw RGB16 slices are copies instead of WASM views`,
        );
      }
      let rejectedOutOfBoundsView = false;
      try {
        raw.imageView(image.sampleCount, 1);
      } catch (error) {
        rejectedOutOfBoundsView = true;
        if (typeof error === "object" && error !== null && "excPtr" in error) {
          module.decrementExceptionRefcount(error);
        }
      }
      if (!rejectedOutOfBoundsView) {
        throw new Error(
          `${fixture.name}: LibRaw accepted an RGB16 view outside the decoded image`,
        );
      }

      const nativeWidth = nativeBytes.readUInt32LE(0);
      const nativeHeight = nativeBytes.readUInt32LE(4);
      if (image.width !== nativeWidth || image.height !== nativeHeight) {
        throw new Error(
          `${fixture.name}: WASM ${image.width}x${image.height} differs from native ${nativeWidth}x${nativeHeight}`,
        );
      }
      if (nativeBytes.length !== 8 + pixels.length * 2) {
        throw new Error(`${fixture.name}: unexpected native RGB16 buffer size`);
      }
      const differentBoundaryPixels = new Set();
      let maxSampleDelta = 0;
      for (let index = 0; index < pixels.length; index += 1) {
        const nativeSample = nativeBytes.readUInt16LE(8 + index * 2);
        const delta = Math.abs(pixels[index] - nativeSample);
        if (delta === 0) continue;
        if (!fixture.aahdBoundary) {
          throw new Error(
            `${fixture.name}: RGB16 differs at sample ${index}: WASM ${pixels[index]}, native ${nativeSample}`,
          );
        }
        const pixel = Math.floor(index / 3);
        const row = Math.floor(pixel / image.width);
        const column = pixel % image.width;
        const isBoundary =
          row === 0 ||
          row === image.height - 1 ||
          column === 0 ||
          column === image.width - 1;
        if (!isBoundary) {
          throw new Error(
            `${fixture.name}: interior RGB16 differs at (${column}, ${row}), channel ${index % 3}`,
          );
        }
        differentBoundaryPixels.add(pixel);
        maxSampleDelta = Math.max(maxSampleDelta, delta);
      }
      if (
        fixture.aahdBoundary &&
        (differentBoundaryPixels.size >
          fixture.aahdBoundary.maxDifferentPixels ||
          maxSampleDelta > fixture.aahdBoundary.maxSampleDelta)
      ) {
        throw new Error(
          `${fixture.name}: ${differentBoundaryPixels.size} boundary pixels differ with maximum delta ${maxSampleDelta}`,
        );
      }
      const result = fixture.aahdBoundary
        ? `interior exact; ${differentBoundaryPixels.size} bounded AAHD edge pixel differs`
        : "exact";
      console.log(
        `${fixture.name}: native/WASM RGB16 ${result} at ${image.width}x${image.height}`,
      );
    } finally {
      raw.delete();
    }
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
