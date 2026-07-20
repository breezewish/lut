import reference from "../../tests/fixtures/aahd-tiled-reference.json";

import {
  demosaicLibRawAahdTiledWithWgsl,
  type TiledAahdColor,
} from "./lib/libraw-aahd";
import type { SensorImageInfo } from "./lib/sensor-image";
import { sha256Hex } from "./lib/hash";
import { WebGpuColorRenderer } from "./lib/webgpu-color";

/** Runs portable WebGPU seam fixtures without loading the product UI. */
export function mountAahdTileBenchmark(): void {
  document.body.dataset.benchmarkStatus = "running";
  void runFixtures()
    .then((report) => {
      performance.mark("lutify:aahd-tile-benchmark", { detail: report });
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
  for (const testCase of reference.cases) {
    results.push(await renderFixture(testCase));
  }
  return { results };
}

async function renderFixture(testCase: (typeof reference.cases)[number]) {
  const info = createSensorInfo(
    testCase.width,
    testCase.height,
    testCase.cfa_pattern,
    testCase.black_levels,
  );
  const mosaic = createDependencyFixture(testCase.width, testCase.height);
  const rendered = await renderHash(mosaic, info);
  let gradedHash;
  if ("graded_rgb16_sha256" in testCase) {
    const renderer = await WebGpuColorRenderer.create(createIdentityLut());
    try {
      gradedHash = (await renderHash(mosaic, info, { renderer, ev: 0 })).hash;
    } finally {
      renderer.destroy();
    }
  }
  return {
    name: testCase.name,
    hash: rendered.hash,
    expectedHash: testCase.rgb16_sha256,
    gradedHash,
    expectedGradedHash:
      "graded_rgb16_sha256" in testCase
        ? testCase.graded_rgb16_sha256
        : undefined,
    blackLevels: testCase.black_levels,
    resources: rendered.resources,
  };
}

async function renderHash(
  mosaic: Uint16Array,
  info: SensorImageInfo,
  color?: TiledAahdColor,
) {
  const pixels = new Uint16Array(info.sampleCount * 3);
  let offset = 0;
  const result = await demosaicLibRawAahdTiledWithWgsl(
    mosaic,
    info,
    color,
    (band) => {
      pixels.set(band, offset);
      offset += band.length;
    },
  );
  if (offset !== pixels.length) {
    throw new Error(`AAHD produced ${offset} of ${pixels.length} samples.`);
  }
  return {
    hash: sha256Hex(new Uint8Array(pixels.buffer)),
    resources: result.resources,
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
    demosaicScaleRange: 0x3fff,
    demosaicPreMultipliers: [1, 0.5, 0.75, 0.5],
    cameraWhiteBalance: [2, 1, 1.5, 1],
    xyzToCamera: [],
    rgbCamera: [],
    aahdYuvMatrix: [
      0.299, 0.587, 0.114, -0.168736, -0.331264, 0.5, 0.5, -0.418688, -0.081312,
    ],
    xtransLabMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    librawProPhotoMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    orientation: 0,
  };
}
