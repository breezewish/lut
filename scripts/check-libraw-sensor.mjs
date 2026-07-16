import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import createLibRaw from "../web/src/libraw/libraw.js";

const root = resolve(import.meta.dirname, "..");
const fixtures = [
  {
    name: "Sony ILME-FX30 ARW",
    path: "vendor/LibRaw-Wasm/example-sony.ARW",
    width: 6240,
    height: 4168,
    sensorType: "bayer",
    cfaSize: 2,
    cfa: [0, 1, 3, 2],
    blackLevels: [512, 512, 512, 512],
    whiteLevel: 16380,
    orientation: 0,
    whiteBalance: [2643, 1024, 1590, 1024],
    xyzToCamera: [
      0.6972, -0.2408, -0.06, -0.433, 1.2101, 0.2515, -0.0388, 0.1277, 0.5847,
      0, 0, 0,
    ],
    sum: 28170738174,
    samples: [702, 940, 622, 1036, 642, 518],
  },
];
if (process.env.XTRANS_FIXTURE) {
  fixtures.push({
    name: "Fujifilm X-T1 RAF",
    path: process.env.XTRANS_FIXTURE,
    width: 4934,
    height: 3296,
    sensorType: "xtrans",
    cfaSize: 6,
    cfa: [
      0, 2, 1, 2, 0, 1, 1, 1, 0, 1, 1, 2, 1, 1, 2, 1, 1, 0, 2, 0, 1, 0, 2, 1, 1,
      1, 2, 1, 1, 0, 1, 1, 0, 1, 1, 2,
    ],
    blackLevels: [1023, 1023, 1023, 1023],
    whiteLevel: 16383,
    orientation: 0,
    whiteBalance: [581, 302, 482, 0],
    xyzToCamera: [
      0.8458, -0.2451, -0.0855, -0.4597, 1.2447, 0.2407, -0.1475, 0.2482,
      0.6526, 0, 0, 0,
    ],
    sum: 56057963413,
    samples: [2653, 4891, 5299, 4840, 1893, 7488],
  });
}

const wasmBytes = await readFile(resolve(root, "web/src/libraw/libraw.wasm"));
const module = await createLibRaw({ wasmBinary: wasmBytes });

for (const fixture of fixtures) {
  const raw = new module.LibRaw();
  try {
    raw.open(new Uint8Array(await readFile(fixture.path)), false);
    const info = raw.sensorInfo();
    if (process.env.PRINT_SENSOR_INFO === "1")
      console.log(JSON.stringify(info));
    const mosaic = raw.sensorView(0, info.sampleCount);
    const positions = [
      0,
      1,
      2,
      3,
      Math.floor(mosaic.length / 2),
      mosaic.length - 1,
    ];

    assertEqual(info.width, fixture.width, `${fixture.name} width`);
    assertEqual(info.height, fixture.height, `${fixture.name} height`);
    assertEqual(
      info.sampleCount,
      fixture.width * fixture.height,
      `${fixture.name} sample count`,
    );
    assertEqual(
      info.sensorType,
      fixture.sensorType,
      `${fixture.name} sensor type`,
    );
    assertEqual(info.cfaSize, fixture.cfaSize, `${fixture.name} CFA size`);
    assertArray(info.cfaPattern, fixture.cfa, `${fixture.name} visible CFA`);
    assertArray(
      info.blackLevels,
      fixture.blackLevels,
      `${fixture.name} black levels`,
    );
    assertEqual(
      info.whiteLevel,
      fixture.whiteLevel,
      `${fixture.name} white level`,
    );
    assertEqual(
      info.orientation,
      fixture.orientation,
      `${fixture.name} orientation`,
    );
    assertArray(
      info.cameraWhiteBalance,
      fixture.whiteBalance,
      `${fixture.name} camera WB`,
    );
    assertArray(
      info.xyzToCamera,
      fixture.xyzToCamera,
      `${fixture.name} camera matrix`,
      1e-6,
    );
    assertArray(
      positions.map((position) => mosaic[position]),
      fixture.samples,
      `${fixture.name} mosaic samples`,
    );

    let sum = 0;
    for (const sample of mosaic) sum += sample;
    assertEqual(sum, fixture.sum, `${fixture.name} mosaic checksum`);
    if (raw.sensorView(0, 1).buffer !== mosaic.buffer) {
      throw new Error(
        `${fixture.name} sensor slices are copies instead of WASM views`,
      );
    }
    const timings = raw.sensorTimings();
    for (const phase of [
      "inputCopyMs",
      "openMs",
      "unpackMs",
      "mosaicCopyMs",
      "totalMs",
    ]) {
      if (!Number.isFinite(timings[phase]) || timings[phase] < 0) {
        throw new Error(
          `${fixture.name} has invalid ${phase}: ${timings[phase]}`,
        );
      }
    }
    console.log(
      `${fixture.name} sensor mosaic and metadata match rawpy exactly`,
    );
  } finally {
    raw.delete();
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: got ${actual}, expected ${expected}`);
  }
}

function assertArray(actual, expected, label, tolerance = 0) {
  if (actual.length !== expected.length) {
    throw new Error(
      `${label}: got ${actual.length} values, expected ${expected.length}`,
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (Math.abs(actual[index] - expected[index]) > tolerance) {
      throw new Error(
        `${label}[${index}]: got ${actual[index]}, expected ${expected[index]}`,
      );
    }
  }
}
