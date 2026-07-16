import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import createLibRaw from "../web/src/libraw/libraw.js";

const root = resolve(import.meta.dirname, "..");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "raw-alchemy-"));
const nativeOutput = join(temporaryDirectory, "native.rgb16");
const fixtures = [
  {
    name: "linear DNG",
    path: "tests/fixtures/linear.dng",
    dimensions: { full: [64, 48], half: [64, 48] },
  },
  {
    name: "lossy DNG",
    path: "vendor/LibRaw-Wasm/test/integration/lossy.dng",
    dimensions: { full: [256, 168], half: [256, 168] },
  },
  {
    name: "Leica M8 DNG",
    path: "tests/fixtures/leica-m8.dng",
    dimensions: { full: [3920, 2638], half: [1960, 1319] },
  },
  {
    name: "Sony ARW",
    path: "vendor/LibRaw-Wasm/example-sony.ARW",
    dimensions: { full: [6240, 4168], half: [3120, 2084] },
  },
];

try {
  const wasmBytes = await readFile(join(root, "web/src/libraw/libraw.wasm"));
  const module = await createLibRaw({ wasmBinary: wasmBytes });

  for (const fixture of fixtures) {
    for (const halfSize of [false, true]) {
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
      await promisify(execFile)("cargo", nativeArguments, { cwd: root });

      const [rawBytes, nativeBytes] = await Promise.all([
        readFile(join(root, fixture.path)),
        readFile(nativeOutput),
      ]);
      const raw = new module.LibRaw();
      try {
        raw.open(new Uint8Array(rawBytes), halfSize);
        const image = raw.imageInfo();
        const mode = halfSize ? "half" : "full";
        const expected = fixture.dimensions[mode];
        if (image.width !== expected[0] || image.height !== expected[1]) {
          throw new Error(
            `${fixture.name} ${mode} dimensions are ${image.width}x${image.height}, expected ${expected[0]}x${expected[1]}`,
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
            `${fixture.name} RGB16 slices are copies instead of WASM views`,
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
            `${fixture.name} accepted an RGB16 view outside the decoded image`,
          );
        }

        const nativeWidth = nativeBytes.readUInt32LE(0);
        const nativeHeight = nativeBytes.readUInt32LE(4);
        if (image.width !== nativeWidth || image.height !== nativeHeight) {
          throw new Error(
            `${fixture.name} dimensions differ: WASM ${image.width}x${image.height}, native ${nativeWidth}x${nativeHeight}`,
          );
        }
        if (nativeBytes.length !== 8 + pixels.length * 2) {
          throw new Error(
            `${fixture.name} native RGB16 buffer has an unexpected size`,
          );
        }
        for (let index = 0; index < pixels.length; index += 1) {
          const nativeSample = nativeBytes.readUInt16LE(8 + index * 2);
          if (pixels[index] !== nativeSample) {
            throw new Error(
              `${fixture.name} ${mode} RGB16 differs at sample ${index}: WASM ${pixels[index]}, native ${nativeSample}`,
            );
          }
        }
        console.log(`${fixture.name} ${mode} native/WASM RGB16 parity: exact`);
      } finally {
        raw.delete();
      }
    }
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
