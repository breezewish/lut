import shader from "../demosaic/native-rcd.wgsl?raw";
import { cameraToProPhoto } from "./onnx-demosaic";
import type { SensorImageInfo } from "./onnx-demosaic";

export interface NativeRcdTimings {
  deviceCreateMs: number;
  workspaceCreateMs: number;
  uploadMs: number;
  preprocessMs: number;
  demosaicMs: number;
  colorMs: number;
  readbackMs: number;
  validationMs: number;
  totalMs: number;
}

export interface Rgb16Validation {
  sampleCount: number;
  differingSamples: number;
  samplesOverOneCode: number;
  samplesOverEightCodes: number;
  maximumDifference: number;
  maximumDifferenceIndex: number;
  actualAtMaximumDifference: number;
  expectedAtMaximumDifference: number;
  meanAbsoluteDifference: number;
  rootMeanSquareDifference: number;
  psnrDb: number;
}

export interface NativeRcdResult {
  width: number;
  height: number;
  algorithm: "RCD";
  backend: "native-wgsl";
  adapterInfo: {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
    isFallbackAdapter: boolean;
  };
  timings: NativeRcdTimings;
  output: {
    validation?: Rgb16Validation;
    export?: {
      deflateMs: number;
      blobMs: number;
      tiffBytes: number;
    };
  };
}

/** Minimal consuming TIFF encoder surface used by the full-chain benchmark. */
export interface Rgb16TiffEncoder {
  next_strip_samples(): number;
  write_rendered_strip(pixels: Uint16Array): void;
  finish(): Uint8Array;
  free(): void;
}

const ENTRY_POINTS = [
  "preprocess",
  "vertical_horizontal",
  "low_pass",
  "interpolate_green",
  "diagonal_high_pass",
  "diagonal_direction",
  "interpolate_opposite",
  "interpolate_green_sites",
  "finish",
] as const;

type EntryPoint = (typeof ENTRY_POINTS)[number];

const BINDINGS: Record<EntryPoint, number[]> = {
  preprocess: [0, 1, 2, 3, 4, 11],
  vertical_horizontal: [1, 5, 11],
  low_pass: [1, 6, 11],
  interpolate_green: [1, 3, 5, 6, 11],
  diagonal_high_pass: [1, 6, 7, 11],
  diagonal_direction: [6, 7, 8, 11],
  interpolate_opposite: [2, 3, 4, 8, 11],
  interpolate_green_sites: [2, 3, 4, 5, 11],
  finish: [1, 2, 3, 4, 9, 10, 11],
};

interface Runtime {
  adapter: GPUAdapter;
  device: GPUDevice;
  pipelines: Record<EntryPoint, GPUComputePipeline>;
}

let runtimePromise: Promise<Runtime> | undefined;
let cachedWorkspace: Workspace | undefined;

interface Workspace {
  width: number;
  height: number;
  packedBytes: number;
  buffers: ReturnType<typeof createBuffers>;
  resources: GPUBuffer[];
  readback: GPUBuffer;
  lutSampleCount: number;
}

/** Runs Studio's RCD math as explicit compute passes and keeps RGB on WebGPU through RGB16. */
export async function demosaicRcdWithNativeWgsl(
  mosaic: Uint16Array,
  info: SensorImageInfo,
  referenceRgb16?: Uint16Array,
  outputStage: "demosaic" | "identity-lut" = "identity-lut",
  tiffEncoder?: Rgb16TiffEncoder,
): Promise<NativeRcdResult> {
  if (info.sensorType !== "bayer") {
    throw new Error("The native RCD benchmark requires a Bayer RAW.");
  }
  if (info.orientation !== 0) {
    throw new Error("The native RCD benchmark requires an unrotated RAW.");
  }
  if (
    info.width % 2 !== 0 ||
    info.height % 2 !== 0 ||
    mosaic.length !== info.width * info.height
  ) {
    throw new Error(
      "The native RCD benchmark requires an even, complete Bayer mosaic.",
    );
  }

  const startedAt = performance.now();
  const deviceStartedAt = performance.now();
  const runtime = await getRuntime(largestBufferBytes(info));
  const deviceCreateMs = performance.now() - deviceStartedAt;
  const pixelCount = info.width * info.height;
  const workspaceStartedAt = performance.now();
  const workspace = getWorkspace(runtime.device, info, mosaic.byteLength);
  const workspaceCreateMs = performance.now() - workspaceStartedAt;
  const { buffers, resources, readback } = workspace;
  let pendingTiffEncoder = tiffEncoder;
  try {
    const uploadStartedAt = performance.now();
    runtime.device.queue.writeBuffer(
      buffers.mosaic,
      0,
      mosaic.buffer,
      mosaic.byteOffset,
      mosaic.byteLength,
    );
    runtime.device.queue.writeBuffer(
      resources[11],
      0,
      createParameters(info, workspace.lutSampleCount, outputStage),
    );
    await runtime.device.queue.onSubmittedWorkDone();
    const uploadMs = performance.now() - uploadStartedAt;

    const preprocessStartedAt = performance.now();
    submitPass(runtime, "preprocess", resources, info.width, info.height);
    await runtime.device.queue.onSubmittedWorkDone();
    const preprocessMs = performance.now() - preprocessStartedAt;

    const demosaicStartedAt = performance.now();
    for (const entryPoint of ENTRY_POINTS.slice(1, -1)) {
      submitPass(runtime, entryPoint, resources, info.width, info.height);
    }
    await runtime.device.queue.onSubmittedWorkDone();
    const demosaicMs = performance.now() - demosaicStartedAt;

    const colorStartedAt = performance.now();
    submitPass(runtime, "finish", resources, info.width / 2, info.height);
    await runtime.device.queue.onSubmittedWorkDone();
    const colorMs = performance.now() - colorStartedAt;
    const readbackStartedAt = performance.now();
    try {
      const encoder = runtime.device.createCommandEncoder();
      encoder.copyBufferToBuffer(
        buffers.output,
        0,
        readback,
        0,
        workspace.packedBytes,
      );
      runtime.device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const pixels = new Uint16Array(pixelCount * 3);
      pixels.set(new Uint16Array(readback.getMappedRange()));
      const readbackMs = performance.now() - readbackStartedAt;
      const validationStartedAt = performance.now();
      const validation = referenceRgb16
        ? compareRgb16(pixels, referenceRgb16)
        : undefined;
      const validationMs = performance.now() - validationStartedAt;
      const exportEncoder = pendingTiffEncoder;
      pendingTiffEncoder = undefined;
      const exportResult = exportEncoder
        ? encodeTiff(pixels, exportEncoder)
        : undefined;
      return {
        width: info.width,
        height: info.height,
        algorithm: "RCD",
        backend: "native-wgsl",
        adapterInfo: {
          vendor: runtime.adapter.info.vendor,
          architecture: runtime.adapter.info.architecture,
          device: runtime.adapter.info.device,
          description: runtime.adapter.info.description,
          isFallbackAdapter: runtime.adapter.info.isFallbackAdapter,
        },
        timings: {
          deviceCreateMs,
          workspaceCreateMs,
          uploadMs,
          preprocessMs,
          demosaicMs,
          colorMs,
          readbackMs,
          validationMs,
          totalMs: performance.now() - startedAt,
        },
        output: {
          ...(validation ? { validation } : {}),
          ...(exportResult ? { export: exportResult } : {}),
        },
      };
    } finally {
      if (readback.mapState === "mapped") readback.unmap();
    }
  } catch (error) {
    pendingTiffEncoder?.free();
    destroyWorkspace(workspace);
    cachedWorkspace = undefined;
    throw error;
  }
}

function encodeTiff(
  pixels: Uint16Array,
  encoder: Rgb16TiffEncoder,
): { deflateMs: number; blobMs: number; tiffBytes: number } {
  let offset = 0;
  let consumed = false;
  const deflateStartedAt = performance.now();
  try {
    for (;;) {
      const samples = encoder.next_strip_samples();
      if (samples === 0) break;
      if (offset + samples > pixels.length) {
        throw new Error(
          "The TIFF encoder requested samples beyond RGB16 output.",
        );
      }
      encoder.write_rendered_strip(pixels.subarray(offset, offset + samples));
      offset += samples;
    }
    if (offset !== pixels.length) {
      throw new Error(
        `The TIFF encoder consumed ${offset} of ${pixels.length} samples.`,
      );
    }
    consumed = true;
    const bytes = encoder.finish();
    const deflateMs = performance.now() - deflateStartedAt;
    const blobStartedAt = performance.now();
    const blob = new Blob([bytes.slice()], { type: "image/tiff" });
    const blobMs = performance.now() - blobStartedAt;
    return { deflateMs, blobMs, tiffBytes: blob.size };
  } finally {
    if (!consumed) encoder.free();
  }
}

async function getRuntime(requiredBufferBytes: number): Promise<Runtime> {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    if (!("gpu" in navigator))
      throw new Error("WebGPU is unavailable in this browser.");
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) throw new Error("No WebGPU adapter is available.");
    if (
      requiredBufferBytes > adapter.limits.maxBufferSize ||
      requiredBufferBytes > adapter.limits.maxStorageBufferBindingSize
    ) {
      throw new Error(
        `The WebGPU adapter cannot bind the required ${requiredBufferBytes}-byte buffer.`,
      );
    }
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      },
    });
    const module = device.createShaderModule({
      code: shader,
      label: "native RCD",
    });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter(
      (message) => message.type === "error",
    );
    if (errors.length) {
      throw new Error(
        `Native RCD shader failed: ${errors.map((error) => error.message).join("; ")}`,
      );
    }
    const pipelineEntries = await Promise.all(
      ENTRY_POINTS.map(
        async (entryPoint) =>
          [
            entryPoint,
            await device.createComputePipelineAsync({
              label: `native RCD ${entryPoint}`,
              layout: "auto",
              compute: { module, entryPoint },
            }),
          ] as const,
      ),
    );
    return {
      adapter,
      device,
      pipelines: Object.fromEntries(pipelineEntries) as Record<
        EntryPoint,
        GPUComputePipeline
      >,
    };
  })();
  return runtimePromise;
}

function getWorkspace(
  device: GPUDevice,
  info: SensorImageInfo,
  mosaicBytes: number,
): Workspace {
  if (
    cachedWorkspace?.width === info.width &&
    cachedWorkspace.height === info.height
  ) {
    return cachedWorkspace;
  }
  if (cachedWorkspace) destroyWorkspace(cachedWorkspace);
  const pixelCount = info.width * info.height;
  const planeBytes = pixelCount * Float32Array.BYTES_PER_ELEMENT;
  const packedBytes = (pixelCount / 2) * 3 * Uint32Array.BYTES_PER_ELEMENT;
  const buffers = createBuffers(device, mosaicBytes, planeBytes, packedBytes);
  const identityLut = createIdentityLut(17);
  const lutBuffer = device.createBuffer({
    size: identityLut.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const parameterBuffer = device.createBuffer({
    size: 64 * Uint32Array.BYTES_PER_ELEMENT,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const readback = device.createBuffer({
    size: packedBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  device.queue.writeBuffer(lutBuffer, 0, identityLut);
  cachedWorkspace = {
    width: info.width,
    height: info.height,
    packedBytes,
    buffers,
    resources: [
      buffers.mosaic,
      ...buffers.planes,
      buffers.output,
      lutBuffer,
      parameterBuffer,
    ],
    readback,
    lutSampleCount: identityLut.length / 3,
  };
  return cachedWorkspace;
}

function destroyWorkspace(workspace: Workspace): void {
  for (const buffer of workspace.resources) buffer.destroy();
  workspace.readback.destroy();
}

function createBuffers(
  device: GPUDevice,
  mosaicBytes: number,
  planeBytes: number,
  outputBytes: number,
): { mosaic: GPUBuffer; planes: GPUBuffer[]; output: GPUBuffer } {
  return {
    mosaic: device.createBuffer({
      size: Math.ceil(mosaicBytes / 4) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }),
    planes: Array.from({ length: 8 }, () =>
      device.createBuffer({ size: planeBytes, usage: GPUBufferUsage.STORAGE }),
    ),
    output: device.createBuffer({
      size: outputBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    }),
  };
}

function submitPass(
  runtime: Runtime,
  entryPoint: EntryPoint,
  resources: GPUBuffer[],
  width: number,
  height: number,
): void {
  const pipeline = runtime.pipelines[entryPoint];
  const bindGroup = runtime.device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: BINDINGS[entryPoint].map((binding) => ({
      binding,
      resource: { buffer: resources[binding] },
    })),
  });
  const encoder = runtime.device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
  pass.end();
  runtime.device.queue.submit([encoder.finish()]);
}

function createParameters(
  info: SensorImageInfo,
  lutSampleCount: number,
  outputStage: "demosaic" | "identity-lut",
): Uint32Array<ArrayBuffer> {
  const parameters = new Uint32Array(64);
  const floats = new Float32Array(parameters.buffer);
  parameters[0] = info.width;
  parameters[1] = info.height;
  parameters[2] = info.sampleCount;
  parameters[3] = info.cfaSize;
  parameters[4] = Math.round(Math.cbrt(lutSampleCount));
  parameters[5] = outputStage === "identity-lut" ? 1 : 0;
  floats[8] = 1;
  for (let channel = 0; channel < 4; channel += 1)
    floats[12 + channel] = info.blackLevels[channel];
  floats[16] = info.whiteLevel;
  const green = info.cameraWhiteBalance[1] > 0 ? info.cameraWhiteBalance[1] : 1;
  floats.set(
    [info.cameraWhiteBalance[0] / green, 1, info.cameraWhiteBalance[2] / green],
    20,
  );
  floats.set(cameraToProPhoto(info.xyzToCamera), 24);
  floats.set([0, 0, 0], 36);
  floats.set([1, 1, 1], 40);
  parameters.set(info.cfaPattern, 48);
  return parameters;
}

/** Builds a red-fastest LUT that preserves normalized RGB samples. */
export function createIdentityLut(size: number): Float32Array<ArrayBuffer> {
  const samples = new Float32Array(size * size * size * 3);
  let offset = 0;
  for (let blue = 0; blue < size; blue += 1) {
    for (let green = 0; green < size; green += 1) {
      for (let red = 0; red < size; red += 1) {
        samples[offset++] = red / (size - 1);
        samples[offset++] = green / (size - 1);
        samples[offset++] = blue / (size - 1);
      }
    }
  }
  return samples;
}

function largestBufferBytes(info: SensorImageInfo): number {
  return Math.max(
    info.sampleCount * Float32Array.BYTES_PER_ELEMENT,
    (info.sampleCount / 2) * 3 * Uint32Array.BYTES_PER_ELEMENT,
  );
}

function compareRgb16(
  actual: Uint16Array,
  expected: Uint16Array,
): Rgb16Validation {
  if (actual.length !== expected.length) {
    throw new Error(
      `The RGB16 reference has ${expected.length} samples; expected ${actual.length}.`,
    );
  }
  let differingSamples = 0;
  let samplesOverOneCode = 0;
  let samplesOverEightCodes = 0;
  let maximumDifference = 0;
  let maximumDifferenceIndex = 0;
  let differenceSum = 0;
  let squaredDifferenceSum = 0;
  for (let index = 0; index < actual.length; index += 1) {
    const difference = Math.abs(actual[index] - expected[index]);
    if (difference !== 0) differingSamples += 1;
    if (difference > 1) samplesOverOneCode += 1;
    if (difference > 8) samplesOverEightCodes += 1;
    if (difference > maximumDifference) {
      maximumDifference = difference;
      maximumDifferenceIndex = index;
    }
    differenceSum += difference;
    squaredDifferenceSum += difference * difference;
  }
  const rootMeanSquareDifference = Math.sqrt(
    squaredDifferenceSum / actual.length,
  );
  return {
    sampleCount: actual.length,
    differingSamples,
    samplesOverOneCode,
    samplesOverEightCodes,
    maximumDifference,
    maximumDifferenceIndex,
    actualAtMaximumDifference: actual[maximumDifferenceIndex],
    expectedAtMaximumDifference: expected[maximumDifferenceIndex],
    meanAbsoluteDifference: differenceSum / actual.length,
    rootMeanSquareDifference,
    psnrDb:
      rootMeanSquareDifference === 0
        ? Number.POSITIVE_INFINITY
        : 20 * Math.log10(65535 / rootMeanSquareDifference),
  };
}
