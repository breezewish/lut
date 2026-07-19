import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import createRegularLibRaw from "../web/src/libraw/libraw.js";
import createThreadedLibRaw from "./libraw-node-runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const samples = Number.parseInt(process.env.RAW_UNPACK_SAMPLES ?? "5", 10);
if (!Number.isInteger(samples) || samples < 1) {
  throw new Error("RAW_UNPACK_SAMPLES must be a positive integer");
}

const fixtures = [
  {
    name: "Sony ILME-FX30 ARW2",
    path: "vendor/LibRaw-Wasm/example-sony.ARW",
  },
  { name: "Leica M8 packed DNG", path: "tests/fixtures/leica-m8.dng" },
];
const [regularWasm, threadedWasm] = await Promise.all([
  readFile(resolve(root, "web/src/libraw/libraw.wasm")),
  readFile(resolve(root, "web/src/libraw/threaded/libraw.wasm")),
]);
const regular = await createRegularLibRaw({ wasmBinary: regularWasm });
const threaded = await createThreadedLibRaw({ wasmBinary: threadedWasm });

const results = [];
for (const fixture of fixtures) {
  const bytes = new Uint8Array(await readFile(resolve(root, fixture.path)));
  const regularResult = measure(regular, bytes);
  const threadedResult = measure(threaded, bytes);
  results.push({
    fixture: fixture.name,
    bytes: bytes.byteLength,
    unpackSpeedup: regularResult.medianUnpackMs / threadedResult.medianUnpackMs,
    totalSpeedup: regularResult.medianTotalMs / threadedResult.medianTotalMs,
    regular: regularResult,
    threaded: threadedResult,
  });
}
console.log(JSON.stringify({ schemaVersion: 1, samples, results }, null, 2));

function measure(module, bytes) {
  const runs = [];
  for (let index = 0; index <= samples; index += 1) {
    const raw = new module.LibRaw();
    try {
      raw.open(bytes, false);
      const selectedForParallelRuntime = raw.usesParallelUnpack();
      const info = raw.sensorInfo();
      if (index > 0) {
        runs.push({
          selectedForParallelRuntime,
          pixels: info.sampleCount,
          ...raw.sensorTimings(),
        });
      }
    } finally {
      raw.delete();
    }
  }
  return {
    medianUnpackMs: median(runs.map((run) => run.unpackMs)),
    medianTotalMs: median(runs.map((run) => run.totalMs)),
    runs,
  };
}

function median(values) {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
