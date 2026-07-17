import {
  demosaicLibRawAahdTiledWithWgsl,
  demosaicLibRawAahdWithWgsl,
} from "./lib/libraw-aahd";
import type { SensorImageInfo } from "./lib/onnx-demosaic";

const CFA_PHASES = [
  [0, 1, 1, 2],
  [1, 0, 2, 1],
  [1, 2, 0, 1],
  [2, 1, 1, 0],
];

/** Runs opt-in hardware seam fixtures without loading the product UI. */
export function mountAahdTileBenchmark(): void {
  document.body.dataset.benchmarkStatus = "running";
  void runFixtures()
    .then((report) => {
      performance.mark("raw-alchemy:aahd-tile-benchmark", { detail: report });
      document.body.dataset.benchmarkStatus = "complete";
    })
    .catch((error: unknown) => {
      document.body.dataset.benchmarkStatus = "error";
      document.body.dataset.benchmarkError =
        error instanceof Error ? error.message : String(error);
    });
}

async function runFixtures() {
  const width = 546;
  const height = 530;
  const mosaic = createDependencyFixture(width, height);
  const results = [];
  for (const cfaPattern of CFA_PHASES) {
    results.push(await compareFixture(mosaic, width, height, cfaPattern));
  }
  const smallWidth = 64;
  const smallHeight = 46;
  results.push(
    await compareFixture(
      createDependencyFixture(smallWidth, smallHeight),
      smallWidth,
      smallHeight,
      CFA_PHASES[0],
    ),
  );
  return { results };
}

async function compareFixture(
  mosaic: Uint16Array,
  width: number,
  height: number,
  cfaPattern: number[],
) {
  const info = createSensorInfo(width, height, cfaPattern);
  const fullFrame = new Uint16Array(info.sampleCount * 3);
  await demosaicLibRawAahdWithWgsl(
    mosaic,
    info,
    "libraw-parity",
    "final",
    undefined,
    undefined,
    fullFrame,
  );
  const tiled = await demosaicLibRawAahdTiledWithWgsl(mosaic, info, fullFrame);
  return {
    width,
    height,
    cfaPattern,
    validation: tiled.validation,
    resources: tiled.resources,
  };
}

function createDependencyFixture(width: number, height: number): Uint16Array {
  const mosaic = new Uint16Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = (x * 193 + y * 977 + ((x ^ y) & 31) * 211) & 0x3fff;
      if (x >= 512) value = 0x3fff - value;
      if (y >= 512) value = (value + 7001) & 0x3fff;
      if (((x >> 2) + (y >> 2)) % 2 === 0) value >>= 3;
      mosaic[y * width + x] = value;
    }
  }
  for (const [x, y, value] of [
    [510, 510, 0],
    [512, 510, 0x3fff],
    [514, 510, 1],
    [510, 512, 0x3fff],
    [512, 512, 0],
    [514, 512, 0x3fff],
    [510, 514, 1],
    [512, 514, 0x3fff],
    [514, 514, 0],
  ]) {
    if (x < width && y < height) mosaic[y * width + x] = value;
  }
  return mosaic;
}

function createSensorInfo(
  width: number,
  height: number,
  cfaPattern: number[],
): SensorImageInfo {
  return {
    width,
    height,
    sampleCount: width * height,
    sensorType: "bayer",
    cfaSize: 2,
    cfaPattern,
    blackLevels: [0, 0, 0, 0],
    whiteLevel: 0x3fff,
    cameraWhiteBalance: [2, 1, 1.5, 1],
    xyzToCamera: [],
    rgbCamera: [],
    aahdYuvMatrix: [
      0.299, 0.587, 0.114, -0.168736, -0.331264, 0.5, 0.5, -0.418688, -0.081312,
    ],
    librawProPhotoMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    orientation: 0,
  };
}
