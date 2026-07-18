import { demosaicLibRawAahdWithWgsl } from "./lib/libraw-aahd";
import { demosaicLibRawAahdTiledValidated } from "./lib/aahd-tiled-validation";
import type { SensorImageInfo } from "./lib/sensor-image";
import { WebGpuColorRenderer } from "./lib/webgpu-color";

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
  const results = [];
  for (const [index, cfaPattern] of CFA_PHASES.entries()) {
    const crossesTileSeams = index === 0;
    const width = crossesTileSeams ? 1058 : 64;
    const height = crossesTileSeams ? 1042 : 46;
    results.push(
      await compareFixture(
        createDependencyFixture(width, height),
        width,
        height,
        cfaPattern,
        crossesTileSeams,
      ),
    );
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
  results.push(
    await compareFixture(
      createDependencyFixture(66, 50),
      66,
      50,
      CFA_PHASES[2],
      false,
      [64, 96, 192, 96],
    ),
  );
  return { results };
}

async function compareFixture(
  mosaic: Uint16Array,
  width: number,
  height: number,
  cfaPattern: number[],
  validateDirectColor = false,
  blackLevels = [0, 0, 0, 0],
) {
  const info = createSensorInfo(width, height, cfaPattern, blackLevels);
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
  const tiled = await demosaicLibRawAahdTiledValidated(mosaic, info, fullFrame);
  let gradedValidation;
  if (validateDirectColor) {
    const renderer = await WebGpuColorRenderer.create(createIdentityLut());
    try {
      const uploaded = await renderer.renderStrip(fullFrame, 0);
      gradedValidation = (
        await demosaicLibRawAahdTiledValidated(mosaic, info, uploaded.pixels, {
          renderer,
          ev: 0,
        })
      ).validation;
    } finally {
      renderer.destroy();
    }
  }
  return {
    width,
    height,
    cfaPattern,
    blackLevels,
    validation: tiled.validation,
    gradedValidation,
    resources: tiled.resources,
  };
}

function createIdentityLut() {
  return {
    size: () => 2,
    domain_min: () => new Float32Array([0, 0, 0]),
    domain_max: () => new Float32Array([1, 1, 1]),
    samples: () =>
      new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1,
      ]),
  };
}

function createDependencyFixture(width: number, height: number): Uint16Array {
  const mosaic = new Uint16Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = (x * 193 + y * 977 + ((x ^ y) & 31) * 211) & 0x3fff;
      if (x >= 1024) value = 0x3fff - value;
      if (y >= 1024) value = (value + 7001) & 0x3fff;
      if (((x >> 2) + (y >> 2)) % 2 === 0) value >>= 3;
      mosaic[y * width + x] = value;
    }
  }
  for (const [x, y, value] of [
    [1022, 1022, 0],
    [1024, 1022, 0x3fff],
    [1026, 1022, 1],
    [1022, 1024, 0x3fff],
    [1024, 1024, 0],
    [1026, 1024, 0x3fff],
    [1022, 1026, 1],
    [1024, 1026, 0x3fff],
    [1026, 1026, 0],
  ]) {
    if (x < width && y < height) mosaic[y * width + x] = value;
  }
  return mosaic;
}

function createSensorInfo(
  width: number,
  height: number,
  cfaPattern: number[],
  blackLevels: number[],
): SensorImageInfo {
  return {
    width,
    height,
    sampleCount: width * height,
    sensorType: "bayer",
    cfaSize: 2,
    cfaPattern,
    blackLevels,
    whiteLevel: 0x3fff,
    aahdScaleRange: 0x3fff,
    aahdPreMultipliers: [1, 0.5, 0.75, 0.5],
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
