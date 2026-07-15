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

  const [rawBytes, wasmBytes, settingsBytes, nativeBytes] = await Promise.all([
    readFile(join(root, "tests/fixtures/linear.dng")),
    readFile(join(root, "web/src/libraw/libraw.wasm")),
    readFile(join(root, "web/src/libraw-settings.json"), "utf8"),
    readFile(nativeOutput),
  ]);
  const module = await createLibRaw({ wasmBinary: wasmBytes });
  const raw = new module.LibRaw();
  try {
    raw.open(new Uint8Array(rawBytes), {
      ...JSON.parse(settingsBytes),
      halfSize: 0,
    });
    const image = raw.imageData();
    const nativeWidth = nativeBytes.readUInt32LE(0);
    const nativeHeight = nativeBytes.readUInt32LE(4);
    if (image.width !== nativeWidth || image.height !== nativeHeight) {
      throw new Error(
        `LibRaw dimensions differ: WASM ${image.width}x${image.height}, native ${nativeWidth}x${nativeHeight}`,
      );
    }
    if (nativeBytes.length !== 8 + image.data.length * 2) {
      throw new Error("Native LibRaw returned an unexpected RGB16 buffer size");
    }
    for (let index = 0; index < image.data.length; index += 1) {
      const nativeSample = nativeBytes.readUInt16LE(8 + index * 2);
      if (image.data[index] !== nativeSample) {
        throw new Error(
          `LibRaw RGB16 differs at sample ${index}: WASM ${image.data[index]}, native ${nativeSample}`,
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
