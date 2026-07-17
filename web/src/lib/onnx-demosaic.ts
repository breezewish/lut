import * as ort from "onnxruntime-web/webgpu";

import rcdModelUrl from "../demosaic/rcd-demosaic.onnx?url";
import sensorTileShader from "../demosaic/sensor-tile.wgsl?raw";
import stitchTileShader from "../demosaic/stitch-tile.wgsl?raw";
import xtransModelUrl from "../demosaic/xtrans-markesteijn.onnx?url";

export interface SensorImageInfo {
  width: number;
  height: number;
  sampleCount: number;
  sensorType: "bayer" | "xtrans";
  cfaSize: 2 | 6;
  cfaPattern: number[];
  blackLevels: number[];
  whiteLevel: number;
  /** Effective post-black range used by LibRaw's AAHD scaling. */
  aahdScaleRange: number;
  /** Normalized multipliers selected by LibRaw's camera/auto WB policy. */
  aahdPreMultipliers: number[];
  cameraWhiteBalance: number[];
  xyzToCamera: number[];
  rgbCamera: number[];
  aahdYuvMatrix: number[];
  librawProPhotoMatrix: number[];
  orientation: number;
}

export interface DemosaicTimings {
  sessionCreateMs: number;
  mosaicUploadMs: number;
  graphMs: number;
  readbackMs: number;
  validationMs: number;
  totalMs: number;
  tileCount: number;
}

export interface DemosaicValidation {
  finite: boolean;
  minimum: number;
  maximum: number;
  sampleIndices: number[];
  sampleValues: number[];
  rgb16Reference?: {
    sampleCount: number;
    differingSamples: number;
    samplesOverOneCode: number;
    samplesOverTwoCodes: number;
    samplesOverEightCodes: number;
    maximumDifference: number;
    maximumDifferenceIndex: number;
    meanAbsoluteDifference: number;
  };
}

export interface DemosaicResult {
  width: number;
  height: number;
  algorithm: "RCD" | "Markesteijn";
  adapterInfo: {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
    isFallbackAdapter: boolean;
  };
  timings: DemosaicTimings;
  validation: DemosaicValidation;
}

interface Algorithm {
  name: DemosaicResult["algorithm"];
  tileSize: number;
  overlap: number;
  phase: number;
  modelUrl: string;
}

interface Tile {
  sourceX: number;
  sourceY: number;
  tileX: number;
  tileY: number;
  destinationX: number;
  destinationY: number;
  copyWidth: number;
  copyHeight: number;
}

interface Runtime {
  adapter: GPUAdapter;
  device: GPUDevice;
  preprocessPipeline: GPUComputePipeline;
  stitchPipeline: GPUComputePipeline;
  sessions: Map<DemosaicResult["algorithm"], ort.InferenceSession>;
}

const RCD: Algorithm = {
  name: "RCD",
  tileSize: 1536,
  overlap: 24,
  phase: 2,
  modelUrl: rcdModelUrl,
};
const MARKESTEIJN: Algorithm = {
  name: "Markesteijn",
  tileSize: 1560,
  overlap: 24,
  phase: 6,
  modelUrl: xtransModelUrl,
};
const CANONICAL_XTRANS = [
  1, 1, 0, 1, 1, 2, 1, 1, 2, 1, 1, 0, 2, 0, 1, 0, 2, 1, 1, 1, 2, 1, 1, 0, 1, 1,
  0, 1, 1, 2, 0, 2, 1, 2, 0, 1,
];
const PROPHOTO_TO_XYZ_D65 = [
  0.755603256421359, 0.11278492113801272, 0.08208189343532289,
  0.2683379250450128, 0.7151267706955571, 0.016535310335320977,
  0.003910020350449157, -0.012918708286404542, 1.0978387753557597,
];

let runtimePromise: Promise<Runtime> | undefined;

/** Runs Studio's unmodified ONNX demosaic graph on a LibRaw sensor mosaic. */
export async function demosaicOnWebGpu(
  mosaic: Uint16Array,
  info: SensorImageInfo,
  referenceRgb16?: Uint16Array,
): Promise<DemosaicResult> {
  if (
    mosaic.length !== info.sampleCount ||
    mosaic.length !== info.width * info.height
  ) {
    throw new Error(
      "The LibRaw sensor mosaic does not match its declared dimensions.",
    );
  }
  if (info.orientation !== 0) {
    throw new Error(
      "The demosaic benchmark currently requires an unrotated RAW.",
    );
  }
  const algorithm = info.sensorType === "bayer" ? RCD : MARKESTEIJN;
  const workOffset =
    info.sensorType === "xtrans"
      ? canonicalXtransOffset(info.cfaPattern)
      : [0, 0];
  const workWidth = info.width - workOffset[1];
  const workHeight = info.height - workOffset[0];
  const paddedWidth = alignUp(workWidth, algorithm.phase);
  const paddedHeight = alignUp(workHeight, algorithm.phase);
  const tiles = createTiles(
    workWidth,
    workHeight,
    paddedWidth,
    paddedHeight,
    algorithm,
    workOffset,
  );
  const frameBytes =
    info.width * info.height * 3 * Float32Array.BYTES_PER_ELEMENT;
  const startedAt = performance.now();
  const sessionStartedAt = performance.now();
  const runtime = await getRuntime(frameBytes, algorithm);
  let session = runtime.sessions.get(algorithm.name);
  if (!session) {
    session = await createSession(algorithm);
    runtime.sessions.set(algorithm.name, session);
  }
  const sessionCreateMs = performance.now() - sessionStartedAt;

  const mosaicBuffer = runtime.device.createBuffer({
    size: Math.ceil(mosaic.byteLength / 4) * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const tileBuffer = runtime.device.createBuffer({
    size:
      algorithm.tileSize * algorithm.tileSize * Float32Array.BYTES_PER_ELEMENT,
    usage: GPUBufferUsage.STORAGE,
  });
  const frameBuffer = runtime.device.createBuffer({
    size: frameBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuffer = runtime.device.createBuffer({
    size: frameBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const preprocessParameters = runtime.device.createBuffer({
    size: 64 * Uint32Array.BYTES_PER_ELEMENT,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const stitchParameters = runtime.device.createBuffer({
    size: 32 * Uint32Array.BYTES_PER_ELEMENT,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const outputs: ort.Tensor[] = [];
  let input: ort.Tensor | undefined;
  const feedTensors: ort.Tensor[] = [];
  try {
    const uploadStartedAt = performance.now();
    runtime.device.queue.writeBuffer(
      mosaicBuffer,
      0,
      mosaic.buffer,
      mosaic.byteOffset,
      mosaic.byteLength,
    );
    await runtime.device.queue.onSubmittedWorkDone();
    const mosaicUploadMs = performance.now() - uploadStartedAt;

    input = ort.Tensor.fromGpuBuffer(tileBuffer, {
      dataType: "float32",
      dims: [algorithm.tileSize, algorithm.tileSize],
    });
    const colorMatrix = cameraToProPhoto(info.xyzToCamera);
    const green =
      info.cameraWhiteBalance[1] > 0 ? info.cameraWhiteBalance[1] : 1;
    const whiteBalance = new Float32Array([
      info.cameraWhiteBalance[0] / green,
      1,
      info.cameraWhiteBalance[2] / green,
    ]);
    const feeds = createFeeds(
      algorithm,
      input,
      info.cfaPattern,
      whiteBalance,
      colorMatrix,
    );
    for (const tensor of Object.values(feeds)) {
      if (tensor !== input) feedTensors.push(tensor);
    }

    const graphStartedAt = performance.now();
    for (const tile of tiles) {
      writePreprocessParameters(
        runtime.device,
        preprocessParameters,
        info,
        algorithm,
        tile,
        workOffset,
      );
      const preprocess = runtime.device.createCommandEncoder();
      const preprocessPass = preprocess.beginComputePass();
      preprocessPass.setPipeline(runtime.preprocessPipeline);
      preprocessPass.setBindGroup(
        0,
        runtime.device.createBindGroup({
          layout: runtime.preprocessPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: mosaicBuffer } },
            { binding: 1, resource: { buffer: tileBuffer } },
            { binding: 2, resource: { buffer: preprocessParameters } },
          ],
        }),
      );
      preprocessPass.dispatchWorkgroups(
        Math.ceil(algorithm.tileSize / 16),
        Math.ceil(algorithm.tileSize / 16),
      );
      preprocessPass.end();
      runtime.device.queue.submit([preprocess.finish()]);

      const result = await session.run(feeds);
      const output = result[session.outputNames[0]];
      if (output.location !== "gpu-buffer" || output.dims.at(-1) !== 3) {
        output.dispose();
        throw new Error(
          "ONNX Runtime did not keep the demosaic output on WebGPU.",
        );
      }
      outputs.push(output);
      writeStitchParameters(
        runtime.device,
        stitchParameters,
        info,
        algorithm,
        tile,
        whiteBalance,
        colorMatrix,
      );
      const stitch = runtime.device.createCommandEncoder();
      const stitchPass = stitch.beginComputePass();
      stitchPass.setPipeline(runtime.stitchPipeline);
      stitchPass.setBindGroup(
        0,
        runtime.device.createBindGroup({
          layout: runtime.stitchPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: output.gpuBuffer } },
            { binding: 1, resource: { buffer: frameBuffer } },
            { binding: 2, resource: { buffer: stitchParameters } },
          ],
        }),
      );
      stitchPass.dispatchWorkgroups(
        Math.ceil(tile.copyWidth / 16),
        Math.ceil(tile.copyHeight / 16),
      );
      stitchPass.end();
      runtime.device.queue.submit([stitch.finish()]);
    }
    await runtime.device.queue.onSubmittedWorkDone();
    const graphMs = performance.now() - graphStartedAt;

    const readbackStartedAt = performance.now();
    const copy = runtime.device.createCommandEncoder();
    copy.copyBufferToBuffer(frameBuffer, 0, readbackBuffer, 0, frameBytes);
    runtime.device.queue.submit([copy.finish()]);
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const pixels = new Float32Array(frameBytes / 4);
    pixels.set(new Float32Array(readbackBuffer.getMappedRange()));
    readbackBuffer.unmap();
    restoreXtransBorder(pixels, info.width, info.height, workOffset);
    const readbackMs = performance.now() - readbackStartedAt;

    const validationStartedAt = performance.now();
    const validation = validateFrame(pixels, referenceRgb16);
    const validationMs = performance.now() - validationStartedAt;
    return {
      width: info.width,
      height: info.height,
      algorithm: algorithm.name,
      adapterInfo: {
        vendor: runtime.adapter.info.vendor,
        architecture: runtime.adapter.info.architecture,
        device: runtime.adapter.info.device,
        description: runtime.adapter.info.description,
        isFallbackAdapter: runtime.adapter.info.isFallbackAdapter,
      },
      timings: {
        sessionCreateMs,
        mosaicUploadMs,
        graphMs,
        readbackMs,
        validationMs,
        totalMs: performance.now() - startedAt,
        tileCount: tiles.length,
      },
      validation,
    };
  } finally {
    input?.dispose();
    for (const tensor of feedTensors) tensor.dispose();
    for (const output of outputs) output.dispose();
    mosaicBuffer.destroy();
    tileBuffer.destroy();
    frameBuffer.destroy();
    readbackBuffer.destroy();
    preprocessParameters.destroy();
    stitchParameters.destroy();
  }
}

async function getRuntime(
  requiredFrameBytes: number,
  initialAlgorithm: Algorithm,
): Promise<Runtime> {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    if (!("gpu" in navigator))
      throw new Error("WebGPU is unavailable in this browser.");
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) throw new Error("No WebGPU adapter is available.");
    if (
      adapter.limits.maxBufferSize < requiredFrameBytes ||
      adapter.limits.maxStorageBufferBindingSize < requiredFrameBytes
    ) {
      throw new Error(
        `The WebGPU adapter cannot bind a ${requiredFrameBytes}-byte RGB frame.`,
      );
    }
    // ORT's JavaScript WebGPU backend owns its GPUDevice. Supplying the same
    // adapter before the first session lets ORT request the adapter's maximum
    // useful limits, after which our shaders must reuse ORT's exact device.
    // A buffer created on a separately requested device cannot be an ONNX input.
    ort.env.webgpu.adapter = adapter;
    const initialSession = await createSession(initialAlgorithm);
    const device = await ort.env.webgpu.device;
    if (!device)
      throw new Error("ONNX Runtime did not expose its WebGPU device.");
    const preprocessPipeline = await createPipeline(
      device,
      sensorTileShader,
      "sensor tile",
    );
    const stitchPipeline = await createPipeline(
      device,
      stitchTileShader,
      "tile stitch",
    );
    return {
      adapter,
      device,
      preprocessPipeline,
      stitchPipeline,
      sessions: new Map([[initialAlgorithm.name, initialSession]]),
    };
  })();
  return await runtimePromise;
}

function createSession(algorithm: Algorithm): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(algorithm.modelUrl, {
    executionProviders: ["webgpu"],
    freeDimensionOverrides: { h: algorithm.tileSize, w: algorithm.tileSize },
    preferredOutputLocation: "gpu-buffer",
  });
}

async function createPipeline(
  device: GPUDevice,
  code: string,
  label: string,
): Promise<GPUComputePipeline> {
  const module = device.createShaderModule({ code, label });
  const compilation = await module.getCompilationInfo();
  const errors = compilation.messages.filter(
    (message) => message.type === "error",
  );
  if (errors.length) {
    throw new Error(
      `${label} shader failed: ${errors.map((error) => error.message).join("; ")}`,
    );
  }
  return device.createComputePipelineAsync({
    label,
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });
}

function createTiles(
  width: number,
  height: number,
  paddedWidth: number,
  paddedHeight: number,
  algorithm: Algorithm,
  offset: number[],
): Tile[] {
  const tiles: Tile[] = [];
  const step = algorithm.tileSize - 2 * algorithm.overlap;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      let sourceY = Math.max(
        0,
        Math.min(y - algorithm.overlap, paddedHeight - algorithm.tileSize),
      );
      let sourceX = Math.max(
        0,
        Math.min(x - algorithm.overlap, paddedWidth - algorithm.tileSize),
      );
      sourceY -= sourceY % algorithm.phase;
      sourceX -= sourceX % algorithm.phase;
      const copyWidth = Math.min(width, x + step) - x;
      const copyHeight = Math.min(height, y + step) - y;
      tiles.push({
        sourceX,
        sourceY,
        tileX: x - sourceX,
        tileY: y - sourceY,
        destinationX: x + offset[1],
        destinationY: y + offset[0],
        copyWidth,
        copyHeight,
      });
    }
  }
  return tiles;
}

function writePreprocessParameters(
  device: GPUDevice,
  buffer: GPUBuffer,
  info: SensorImageInfo,
  algorithm: Algorithm,
  tile: Tile,
  workOffset: number[],
): void {
  const parameters = new Uint32Array(64);
  const floats = new Float32Array(parameters.buffer);
  parameters[0] = info.width;
  parameters[1] = info.height;
  parameters[2] = algorithm.tileSize;
  parameters[3] = tile.sourceX;
  parameters[4] = tile.sourceY;
  parameters[5] = info.cfaSize;
  parameters[11] = workOffset[1];
  parameters[12] = workOffset[0];
  parameters[13] = info.width - parameters[11];
  parameters[14] = info.height - parameters[12];
  floats[6] = info.whiteLevel;
  for (let channel = 0; channel < 4; channel += 1)
    floats[7 + channel] = info.blackLevels[channel];
  for (let index = 0; index < info.cfaPattern.length; index += 1) {
    parameters[16 + index] = info.cfaPattern[index];
  }
  device.queue.writeBuffer(buffer, 0, parameters);
}

function writeStitchParameters(
  device: GPUDevice,
  buffer: GPUBuffer,
  info: SensorImageInfo,
  algorithm: Algorithm,
  tile: Tile,
  whiteBalance: Float32Array,
  matrix: Float32Array,
): void {
  const parameters = new Uint32Array(32);
  const floats = new Float32Array(parameters.buffer);
  parameters[0] = algorithm.tileSize;
  parameters[1] = info.width;
  parameters[3] = tile.tileX;
  parameters[4] = tile.tileY;
  parameters[5] = tile.destinationX;
  parameters[6] = tile.destinationY;
  parameters[7] = tile.copyWidth;
  parameters[8] = tile.copyHeight;
  parameters[9] = algorithm.name === "Markesteijn" ? 1 : 0;
  floats.set(whiteBalance, 10);
  floats.set(matrix.subarray(0, 3), 16);
  floats.set(matrix.subarray(3, 6), 20);
  floats.set(matrix.subarray(6, 9), 24);
  device.queue.writeBuffer(buffer, 0, parameters);
}

function alignUp(value: number, phase: number): number {
  return Math.ceil(value / phase) * phase;
}

function createFeeds(
  algorithm: Algorithm,
  input: ort.Tensor,
  cfaPattern: number[],
  whiteBalance: Float32Array,
  colorMatrix: Float32Array,
): Record<string, ort.Tensor> {
  if (algorithm.name === "Markesteijn") {
    return {
      raw: input,
      masks: new ort.Tensor("float32", buildXtransMasks(), [15, 6, 6]),
    };
  }
  const masks = [new Float32Array(4), new Float32Array(4), new Float32Array(4)];
  for (let index = 0; index < 4; index += 1) {
    const color = cfaPattern[index] === 3 ? 1 : cfaPattern[index];
    masks[color][index] = 1;
  }
  return {
    bayer: input,
    mr2: new ort.Tensor("float32", masks[0], [2, 2]),
    mg2: new ort.Tensor("float32", masks[1], [2, 2]),
    mb2: new ort.Tensor("float32", masks[2], [2, 2]),
    wb3: new ort.Tensor("float32", whiteBalance, [3]),
    cam_mat: new ort.Tensor("float32", colorMatrix, [3, 3]),
  };
}

export function canonicalXtransOffset(pattern: number[]): number[] {
  for (let rowOffset = 0; rowOffset < 6; rowOffset += 1) {
    for (let columnOffset = 0; columnOffset < 6; columnOffset += 1) {
      let matches = true;
      for (let row = 0; row < 6 && matches; row += 1) {
        for (let column = 0; column < 6; column += 1) {
          const source =
            pattern[
              ((row + rowOffset) % 6) * 6 + ((column + columnOffset) % 6)
            ];
          if (Math.min(source, 2) !== CANONICAL_XTRANS[row * 6 + column]) {
            matches = false;
            break;
          }
        }
      }
      if (matches) return [rowOffset, columnOffset];
    }
  }
  throw new Error("The RAW does not contain a supported X-Trans CFA phase.");
}

export function buildXtransMasks(): Float32Array {
  const masks = new Float32Array(15 * 36);
  const color = (row: number, column: number) =>
    CANONICAL_XTRANS[(((row % 6) + 6) % 6) * 6 + (((column % 6) + 6) % 6)];
  const orthogonal = [1, 0, 0, 1, -1, 0, 0, -1, 1, 0, 0, 1];
  let specialGreenRow = 0;
  let specialGreenColumn = 0;
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      let nonGreen = 0;
      for (let direction = 0; direction < 10; direction += 2) {
        if (
          color(
            row + orthogonal[direction],
            column + orthogonal[direction + 2],
          ) === 1
        ) {
          nonGreen = 0;
        } else {
          nonGreen += 1;
        }
        if (nonGreen === 4) {
          specialGreenRow = row;
          specialGreenColumn = column;
        }
      }
    }
  }
  for (let row = 0; row < 6; row += 1) {
    for (let column = 0; column < 6; column += 1) {
      const index = row * 6 + column;
      const value = color(row, column);
      masks[value * 36 + index] = 1;
      masks[3 * 36 + index] = (row - specialGreenRow + 6) % 3 === 0 ? 1 : 0;
      masks[4 * 36 + index] =
        (column - specialGreenColumn + 6) % 3 === 0 ? 1 : 0;
      masks[5 * 36 + index] = color(row, column + 1) === 0 ? 1 : 0;
      masks[(6 + (row % 3) * 3 + (column % 3)) * 36 + index] = 1;
    }
  }
  return masks;
}

export function cameraToProPhoto(xyzToCamera: number[]): Float32Array {
  if (
    xyzToCamera.length !== 12 ||
    xyzToCamera.slice(9).some((value) => value !== 0)
  ) {
    throw new Error(
      "The demosaic benchmark currently supports three-color cameras only.",
    );
  }
  const rgbToCamera = new Array<number>(9);
  for (let row = 0; row < 3; row += 1) {
    let sum = 0;
    for (let column = 0; column < 3; column += 1) {
      let value = 0;
      for (let xyz = 0; xyz < 3; xyz += 1) {
        value +=
          xyzToCamera[row * 3 + xyz] * PROPHOTO_TO_XYZ_D65[xyz * 3 + column];
      }
      rgbToCamera[row * 3 + column] = value;
      sum += value;
    }
    for (let column = 0; column < 3; column += 1)
      rgbToCamera[row * 3 + column] /= sum;
  }
  return invert3x3(rgbToCamera);
}

function invert3x3(matrix: number[]): Float32Array {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const determinant =
    a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(determinant) < 1e-12)
    throw new Error("The camera color matrix is singular.");
  return new Float32Array([
    (e * i - f * h) / determinant,
    (c * h - b * i) / determinant,
    (b * f - c * e) / determinant,
    (f * g - d * i) / determinant,
    (a * i - c * g) / determinant,
    (c * d - a * f) / determinant,
    (d * h - e * g) / determinant,
    (b * g - a * h) / determinant,
    (a * e - b * d) / determinant,
  ]);
}

function restoreXtransBorder(
  pixels: Float32Array,
  width: number,
  height: number,
  offset: number[],
): void {
  const [rowOffset, columnOffset] = offset;
  if (rowOffset > 0) {
    const source = pixels.subarray(
      rowOffset * width * 3,
      (rowOffset + 1) * width * 3,
    );
    for (let row = 0; row < rowOffset; row += 1)
      pixels.set(source, row * width * 3);
  }
  if (columnOffset > 0) {
    for (let row = 0; row < height; row += 1) {
      const source = (row * width + columnOffset) * 3;
      for (let column = 0; column < columnOffset; column += 1) {
        pixels.set(
          pixels.subarray(source, source + 3),
          (row * width + column) * 3,
        );
      }
    }
  }
}

function validateFrame(
  pixels: Float32Array,
  referenceRgb16?: Uint16Array,
): DemosaicValidation {
  if (referenceRgb16 && referenceRgb16.length !== pixels.length) {
    throw new Error(
      `The RGB16 reference has ${referenceRgb16.length} samples; expected ${pixels.length}.`,
    );
  }
  let finite = true;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let differingSamples = 0;
  let samplesOverOneCode = 0;
  let samplesOverTwoCodes = 0;
  let samplesOverEightCodes = 0;
  let maximumDifference = 0;
  let maximumDifferenceIndex = 0;
  let differenceSum = 0;
  for (let index = 0; index < pixels.length; index += 1) {
    const value = pixels[index];
    finite &&= Number.isFinite(value);
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    if (referenceRgb16) {
      const code = Math.round(Math.min(1, Math.max(0, value)) * 65_535);
      const difference = Math.abs(code - referenceRgb16[index]);
      if (difference !== 0) differingSamples += 1;
      if (difference > 1) samplesOverOneCode += 1;
      if (difference > 2) samplesOverTwoCodes += 1;
      if (difference > 8) samplesOverEightCodes += 1;
      if (difference > maximumDifference) {
        maximumDifference = difference;
        maximumDifferenceIndex = index;
      }
      differenceSum += difference;
    }
  }
  const sampleIndices: number[] = [];
  const sampleValues: number[] = [];
  const sampleCount = Math.min(4096, pixels.length);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const index = Math.floor(
      (sample * (pixels.length - 1)) / Math.max(1, sampleCount - 1),
    );
    sampleIndices.push(index);
    sampleValues.push(pixels[index]);
  }
  return {
    finite,
    minimum,
    maximum,
    sampleIndices,
    sampleValues,
    ...(referenceRgb16
      ? {
          rgb16Reference: {
            sampleCount: pixels.length,
            differingSamples,
            samplesOverOneCode,
            samplesOverTwoCodes,
            samplesOverEightCodes,
            maximumDifference,
            maximumDifferenceIndex,
            meanAbsoluteDifference: differenceSum / pixels.length,
          },
        }
      : {}),
  };
}
