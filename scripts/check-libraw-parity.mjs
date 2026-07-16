import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import createLibRaw from "../web/src/libraw/libraw.js";

const root = resolve(import.meta.dirname, "..");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "raw-alchemy-"));
const execFileAsync = promisify(execFile);
const manifest = JSON.parse(
  await readFile(join(root, "tests/fixtures/raw-manifest.json"), "utf8"),
);

try {
  const wasmBytes = await readFile(join(root, "web/src/libraw/libraw.wasm"));
  const module = await createLibRaw({ wasmBinary: wasmBytes });

  for (const fixture of manifest.fixtures) {
    for (const halfSize of [false, true]) {
      const mode = halfSize ? "half-size" : "full-size";
      const aahdBoundary =
        fixture.id === "leica-m8-cfa-dng" && !halfSize
          ? { maxDifferentPixels: 1, maxSampleDelta: 4_096 }
          : undefined;
      const nativeOutput = join(
        temporaryDirectory,
        `${fixture.id}-${mode}.rgb16`,
      );
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
      if (halfSize) nativeArguments.push("--half-size");
      await execFileAsync("cargo", nativeArguments, { cwd: root });

      const [rawBytes, nativeBytes] = await Promise.all([
        readFile(join(root, fixture.path)),
        readFile(nativeOutput),
      ]);
      const raw = new module.LibRaw();
      try {
        raw.open(new Uint8Array(rawBytes), halfSize);
        const image = raw.imageInfo();
        if (
          !halfSize &&
          (image.width !== fixture.width || image.height !== fixture.height)
        ) {
          throw new Error(
            `${fixture.id} ${mode}: decoded ${image.width}x${image.height}, expected ${fixture.width}x${fixture.height}`,
          );
        }

        const pixels = raw.imageView(0, image.sampleCount);
        const firstPixel = raw.imageView(0, 3);
        const lastPixel = raw.imageView(image.sampleCount - 3, 3);
        if (
          firstPixel.buffer !== pixels.buffer ||
          lastPixel.buffer !== pixels.buffer
        ) {
          throw new Error(
            `${fixture.id} ${mode}: RGB16 slices are copies instead of WASM views`,
          );
        }

        let rejectedOutOfBoundsView = false;
        try {
          raw.imageView(image.sampleCount, 1);
        } catch (error) {
          rejectedOutOfBoundsView = true;
          if (
            typeof error === "object" &&
            error !== null &&
            "excPtr" in error
          ) {
            module.decrementExceptionRefcount(error);
          }
        }
        if (!rejectedOutOfBoundsView) {
          throw new Error(
            `${fixture.id} ${mode}: accepted a view outside the decoded image`,
          );
        }

        const nativeWidth = nativeBytes.readUInt32LE(0);
        const nativeHeight = nativeBytes.readUInt32LE(4);
        if (image.width !== nativeWidth || image.height !== nativeHeight) {
          throw new Error(
            `${fixture.id} ${mode}: WASM ${image.width}x${image.height} differs from native ${nativeWidth}x${nativeHeight}`,
          );
        }
        if (nativeBytes.length !== 8 + pixels.length * 2) {
          throw new Error(
            `${fixture.id} ${mode}: native RGB16 buffer has an unexpected size`,
          );
        }
        const differentBoundaryPixels = new Set();
        let maxSampleDelta = 0;
        for (let index = 0; index < pixels.length; index += 1) {
          const nativeSample = nativeBytes.readUInt16LE(8 + index * 2);
          const delta = Math.abs(pixels[index] - nativeSample);
          if (delta === 0) continue;
          if (!aahdBoundary) {
            throw new Error(
              `${fixture.id} ${mode}: RGB16 differs at sample ${index}: WASM ${pixels[index]}, native ${nativeSample}`,
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
              `${fixture.id} ${mode}: interior RGB16 differs at (${column}, ${row}), channel ${index % 3}`,
            );
          }
          differentBoundaryPixels.add(pixel);
          maxSampleDelta = Math.max(maxSampleDelta, delta);
        }
        if (
          aahdBoundary &&
          (differentBoundaryPixels.size > aahdBoundary.maxDifferentPixels ||
            maxSampleDelta > aahdBoundary.maxSampleDelta)
        ) {
          throw new Error(
            `${fixture.id} ${mode}: ${differentBoundaryPixels.size} boundary pixels differ with maximum delta ${maxSampleDelta}`,
          );
        }
        const result = aahdBoundary
          ? `interior exact; ${differentBoundaryPixels.size} bounded AAHD edge pixel differs`
          : "exact";
        console.log(
          `${fixture.id} ${mode}: native/WASM RGB16 ${result} at ${image.width}x${image.height}`,
        );
      } finally {
        raw.delete();
      }
    }
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
