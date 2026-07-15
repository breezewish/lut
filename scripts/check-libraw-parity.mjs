import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import createLibRaw from "../web/src/libraw/libraw.js";

const root = resolve(import.meta.dirname, "..");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "raw-alchemy-"));
const nativeOutput = join(temporaryDirectory, "native.rgb16");

try {
  await promisify(execFile)(
    "cargo",
    [
      "run",
      "--quiet",
      "-p",
      "alchemy-libraw",
      "--example",
      "decode_rgb16",
      "--",
      "tests/fixtures/linear.dng",
      nativeOutput,
    ],
    { cwd: root },
  );

  const [rawBytes, wasmBytes, nativeBytes] = await Promise.all([
    readFile(join(root, "tests/fixtures/linear.dng")),
    readFile(join(root, "web/src/libraw/libraw.wasm")),
    readFile(nativeOutput),
  ]);
  const module = await createLibRaw({ wasmBinary: wasmBytes });
  const raw = new module.LibRaw();
  try {
    raw.open(new Uint8Array(rawBytes), false);
    const image = raw.imageInfo();
    const pixels = raw.imageView(0, image.sampleCount);
    const firstPixel = raw.imageView(0, 3);
    const lastPixel = raw.imageView(image.sampleCount - 3, 3);
    if (
      firstPixel.buffer !== pixels.buffer ||
      lastPixel.buffer !== pixels.buffer
    ) {
      throw new Error("LibRaw RGB16 slices are copies instead of WASM views");
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
        "LibRaw accepted an RGB16 view outside the decoded image",
      );
    }
    const nativeWidth = nativeBytes.readUInt32LE(0);
    const nativeHeight = nativeBytes.readUInt32LE(4);
    if (image.width !== nativeWidth || image.height !== nativeHeight) {
      throw new Error(
        `LibRaw dimensions differ: WASM ${image.width}x${image.height}, native ${nativeWidth}x${nativeHeight}`,
      );
    }
    if (nativeBytes.length !== 8 + pixels.length * 2) {
      throw new Error("Native LibRaw returned an unexpected RGB16 buffer size");
    }
    for (let index = 0; index < pixels.length; index += 1) {
      const nativeSample = nativeBytes.readUInt16LE(8 + index * 2);
      if (pixels[index] !== nativeSample) {
        throw new Error(
          `LibRaw RGB16 differs at sample ${index}: WASM ${pixels[index]}, native ${nativeSample}`,
        );
      }
    }
  } finally {
    raw.delete();
  }
  console.log("LibRaw native/WASM RGB16 parity: exact");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
