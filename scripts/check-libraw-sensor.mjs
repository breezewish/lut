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
    demosaicScaleRange: 15868,
    orientation: 0,
    whiteBalance: [2643, 1024, 1590, 1024],
    demosaicPreMultipliers: [
      1, 0.38743850588798523, 0.6015890836715698, 0.38743850588798523,
    ],
    xyzToCamera: [
      0.6972, -0.2408, -0.06, -0.433, 1.2101, 0.2515, -0.0388, 0.1277, 0.5847,
      0, 0, 0,
    ],
    sum: 28170738174,
    samples: [702, 940, 622, 1036, 642, 518],
    webGpuAahd: true,
    webGpuXtrans: false,
  },
  {
    name: "Leica M8 DNG",
    path: "tests/fixtures/leica-m8.dng",
    width: 3920,
    height: 2638,
    sensorType: "bayer",
    cfaSize: 2,
    cfa: [0, 1, 3, 2],
    blackLevels: [0, 0, 0, 0],
    whiteLevel: 16383,
    demosaicScaleRange: 16256,
    orientation: 0,
    whiteBalance: [2.0458984375, 1, 1.29052734375, 0],
    demosaicPreMultipliers: [
      1, 0.4887828230857849, 0.6307876110076904, 0.4887828230857849,
    ],
    xyzToCamera: [
      0.7675, -0.2196, -0.0305, -0.586, 1.4119, 0.1856, -0.2425, 0.4006, 0.6578,
      0, 0, 0,
    ],
    sum: 31653712396,
    samples: [3080, 6806, 3306, 6806, 441, 812],
    webGpuAahd: true,
    webGpuXtrans: false,
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
    demosaicScaleRange: 15360,
    orientation: 0,
    whiteBalance: [581, 302, 482, 0],
    xyzToCamera: [
      0.8458, -0.2451, -0.0855, -0.4597, 1.2447, 0.2407, -0.1475, 0.2482,
      0.6526, 0, 0, 0,
    ],
    sum: 56057963413,
    samples: [2653, 4891, 5299, 4840, 1893, 7488],
    webGpuAahd: false,
    webGpuXtrans: true,
  });
}

const wasmBytes = await readFile(resolve(root, "web/src/libraw/libraw.wasm"));
const module = await createLibRaw({ wasmBinary: wasmBytes });

for (const fixture of fixtures) {
  const raw = new module.LibRaw();
  try {
    raw.open(
      new Uint8Array(await readFile(resolve(root, fixture.path))),
      false,
    );
    assertEqual(
      raw.supportsWebGpuAahd(),
      fixture.webGpuAahd,
      `${fixture.name} WebGPU AAHD route`,
    );
    assertEqual(
      raw.supportsWebGpuXtrans(),
      fixture.webGpuXtrans,
      `${fixture.name} WebGPU X-Trans support`,
    );
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
      info.demosaicScaleRange,
      fixture.demosaicScaleRange,
      `${fixture.name} demosaic scale range`,
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
    if (fixture.sensorType === "bayer") {
      assertArray(
        info.demosaicPreMultipliers,
        fixture.demosaicPreMultipliers,
        `${fixture.name} effective AAHD WB`,
        1e-6,
      );
    }
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

const linearRaw = new module.LibRaw();
try {
  linearRaw.open(
    new Uint8Array(await readFile(resolve(root, "tests/fixtures/linear.dng"))),
    false,
  );
  assertEqual(
    linearRaw.supportsWebGpuAahd(),
    false,
    "Linear DNG WebGPU AAHD route",
  );
} finally {
  linearRaw.delete();
}

const rotatedBytes = new Uint8Array(
  await readFile(resolve(root, "tests/fixtures/leica-m8.dng")),
);
setDngOrientation(rotatedBytes, 6);
const rotatedRaw = new module.LibRaw();
try {
  rotatedRaw.open(rotatedBytes, false);
  assertEqual(
    rotatedRaw.supportsWebGpuAahd(),
    false,
    "Rotated Bayer WebGPU AAHD route",
  );
} finally {
  rotatedRaw.delete();
}

function setDngOrientation(bytes, orientation) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = String.fromCharCode(bytes[0], bytes[1]) === "II";
  const ifdOffset = view.getUint32(4, littleEndian);
  const entryCount = view.getUint16(ifdOffset, littleEndian);
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (view.getUint16(entryOffset, littleEndian) === 274) {
      view.setUint16(entryOffset + 8, orientation, littleEndian);
      return;
    }
  }
  throw new Error("Leica fixture has no Orientation tag");
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
