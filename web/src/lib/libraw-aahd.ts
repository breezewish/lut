import shader from "../demosaic/libraw-aahd.wgsl?raw";
import type { SensorImageInfo } from "./onnx-demosaic";

export interface AahdReferenceInfo {
  width: number;
  height: number;
  inputSampleCount: number;
  outputSampleCount: number;
  candidateSampleCount: number;
  directionSampleCount: number;
  hotPixelMs: number;
  scaleMultipliers: number[];
  preMultipliers: number[];
  yuvMatrix: number[];
  outputMatrix: number[];
  channelMinimum: number[];
  channelMaximum: number[];
}

export interface LibRawAahdTimings {
  deviceCreateMs: number;
  workspaceCreateMs: number;
  scaleAndInitializeMs: number;
  hotPixelMs: number;
  interpolateMs: number;
  homogeneityMs: number;
  refineAndCombineMs: number;
  highlightMs: number;
  colorMs: number;
  readbackMs: number;
  validationMs: number;
  totalMs: number;
}

export interface LibRawAahdValidation {
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

export interface LibRawAahdResult {
  width: number;
  height: number;
  algorithm: "LibRaw AAHD";
  backend: "native-wgsl";
  outputStage: "horizontal" | "vertical" | "directions" | "aahd" | "final";
  adapterInfo: {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
    isFallbackAdapter: boolean;
  };
  timings: LibRawAahdTimings;
  validation?: LibRawAahdValidation;
}

const ENTRY_POINTS = [
  "clear",
  "initialize",
  "hide_hot_pixels",
  "interpolate_green",
  "interpolate_rb_at_green",
  "interpolate_remaining_rb",
  "convert_candidates_to_yuv",
  "evaluate_homogeneity",
  "choose_direction",
  "refine_checker_even",
  "refine_checker_odd",
  "refine_isolated",
  "combine",
  "write_horizontal",
  "write_vertical",
  "write_directions",
  "write_aahd",
  "blend_highlights",
  "write_final",
] as const;

type EntryPoint = (typeof ENTRY_POINTS)[number];

const BINDINGS: Record<EntryPoint, number[]> = {
  clear: [5, 6, 7, 11],
  initialize: [0, 1, 2, 8, 11],
  hide_hot_pixels: [1, 2, 5, 11],
  interpolate_green: [1, 2, 8, 11],
  interpolate_rb_at_green: [1, 2, 8, 11],
  interpolate_remaining_rb: [1, 2, 8, 11],
  convert_candidates_to_yuv: [1, 2, 3, 4, 9, 11],
  evaluate_homogeneity: [3, 4, 6, 7, 11],
  choose_direction: [3, 4, 5, 6, 7, 11],
  refine_checker_even: [5, 11],
  refine_checker_odd: [5, 11],
  refine_isolated: [5, 11],
  combine: [0, 1, 2, 5, 11],
  write_horizontal: [1, 10, 11],
  write_vertical: [2, 10, 11],
  write_directions: [5, 10, 11],
  write_aahd: [1, 10, 11],
  blend_highlights: [1, 11],
  write_final: [1, 10, 11],
};

interface Runtime {
  adapter: GPUAdapter;
  device: GPUDevice;
  pipelines: Record<EntryPoint, GPUComputePipeline>;
}

interface Workspace {
  width: number;
  height: number;
  paddedWidth: number;
  paddedHeight: number;
  packedBytes: number;
  resources: GPUBuffer[];
  readback: GPUBuffer;
}

let runtimePromise: Promise<Runtime> | undefined;
let cachedWorkspace: Workspace | undefined;

/** Reproduces LibRaw's AAHD, Blend highlight, and ProPhoto RGB16 path in WGSL. */
export async function demosaicLibRawAahdWithWgsl(
  mosaic: Uint16Array,
  info: SensorImageInfo,
  outputStage: "horizontal" | "vertical" | "directions" | "aahd" | "final",
  reference?: Uint16Array,
  referenceInfo?: AahdReferenceInfo,
): Promise<LibRawAahdResult> {
  validateInput(mosaic, info, referenceInfo);
  const startedAt = performance.now();
  const deviceStartedAt = performance.now();
  const runtime = await getRuntime(largestBufferBytes(info));
  const deviceCreateMs = performance.now() - deviceStartedAt;
  const workspaceStartedAt = performance.now();
  const workspace = getWorkspace(runtime.device, info, mosaic.byteLength);
  const workspaceCreateMs = performance.now() - workspaceStartedAt;
  const parameters = createParameters(info, workspace, referenceInfo);
  const scaleMultipliers = new Float32Array(parameters.buffer, 12 * 4, 4);
  const firstColor = normalizedCfa(info.cfaPattern[0]);
  const firstScaled = scaleSample(
    mosaic[0],
    info.blackLevels[firstColor],
    scaleMultipliers[firstColor],
  );
  const extrema = new Uint32Array(6);
  extrema[firstColor] = firstScaled;

  try {
    const scaleStartedAt = performance.now();
    runtime.device.queue.writeBuffer(
      workspace.resources[0],
      0,
      mosaic.buffer,
      mosaic.byteOffset,
      mosaic.byteLength,
    );
    runtime.device.queue.writeBuffer(workspace.resources[8], 0, extrema);
    runtime.device.queue.writeBuffer(workspace.resources[11], 0, parameters);
    submitPass(runtime, workspace, "clear", true);
    submitPass(runtime, workspace, "initialize");
    await runtime.device.queue.onSubmittedWorkDone();
    const scaleAndInitializeMs = performance.now() - scaleStartedAt;

    const hotStartedAt = performance.now();
    submitPass(runtime, workspace, "hide_hot_pixels");
    await runtime.device.queue.onSubmittedWorkDone();
    const hotPixelMs = performance.now() - hotStartedAt;

    const interpolateStartedAt = performance.now();
    submitPass(runtime, workspace, "interpolate_green");
    submitPass(runtime, workspace, "interpolate_rb_at_green");
    submitPass(runtime, workspace, "interpolate_remaining_rb");
    submitPass(runtime, workspace, "convert_candidates_to_yuv", true);
    await runtime.device.queue.onSubmittedWorkDone();
    const interpolateMs = performance.now() - interpolateStartedAt;

    const homogeneityStartedAt = performance.now();
    submitPass(runtime, workspace, "evaluate_homogeneity");
    submitPass(runtime, workspace, "choose_direction");
    await runtime.device.queue.onSubmittedWorkDone();
    const homogeneityMs = performance.now() - homogeneityStartedAt;

    const refineStartedAt = performance.now();
    submitPass(runtime, workspace, "refine_checker_even");
    submitPass(runtime, workspace, "refine_checker_odd");
    submitPass(runtime, workspace, "refine_isolated");
    if (outputStage === "horizontal") {
      submitPass(runtime, workspace, "write_horizontal", false, true);
    } else if (outputStage === "vertical") {
      submitPass(runtime, workspace, "write_vertical", false, true);
    } else if (outputStage === "directions") {
      submitPass(runtime, workspace, "write_directions", false, true);
    } else {
      submitPass(runtime, workspace, "combine");
    }
    await runtime.device.queue.onSubmittedWorkDone();
    const refineAndCombineMs = performance.now() - refineStartedAt;

    let highlightMs = 0;
    const colorStartedAt = performance.now();
    if (
      outputStage === "horizontal" ||
      outputStage === "vertical" ||
      outputStage === "directions"
    ) {
      // The candidate was packed before combine could overwrite it.
    } else if (outputStage === "aahd") {
      submitPass(runtime, workspace, "write_aahd", false, true);
    } else {
      const highlightStartedAt = performance.now();
      submitPass(runtime, workspace, "blend_highlights");
      await runtime.device.queue.onSubmittedWorkDone();
      highlightMs = performance.now() - highlightStartedAt;
      submitPass(runtime, workspace, "write_final", false, true);
    }
    await runtime.device.queue.onSubmittedWorkDone();
    const colorMs = performance.now() - colorStartedAt - highlightMs;

    const readbackStartedAt = performance.now();
    const encoder = runtime.device.createCommandEncoder();
    encoder.copyBufferToBuffer(
      workspace.resources[10],
      0,
      workspace.readback,
      0,
      workspace.packedBytes,
    );
    runtime.device.queue.submit([encoder.finish()]);
    await workspace.readback.mapAsync(GPUMapMode.READ);
    let validation: LibRawAahdValidation | undefined;
    let validationMs = 0;
    try {
      const pixels = new Uint16Array(info.sampleCount * 3);
      pixels.set(new Uint16Array(workspace.readback.getMappedRange()));
      const readbackMs = performance.now() - readbackStartedAt;
      const validationStartedAt = performance.now();
      validation = reference ? compareRgb16(pixels, reference) : undefined;
      validationMs = performance.now() - validationStartedAt;
      return {
        width: info.width,
        height: info.height,
        algorithm: "LibRaw AAHD",
        backend: "native-wgsl",
        outputStage,
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
          scaleAndInitializeMs,
          hotPixelMs,
          interpolateMs,
          homogeneityMs,
          refineAndCombineMs,
          highlightMs,
          colorMs,
          readbackMs,
          validationMs,
          totalMs: performance.now() - startedAt,
        },
        ...(validation ? { validation } : {}),
      };
    } finally {
      if (workspace.readback.mapState === "mapped") workspace.readback.unmap();
    }
  } catch (error) {
    destroyWorkspace(workspace);
    cachedWorkspace = undefined;
    throw error;
  }
}

function validateInput(
  mosaic: Uint16Array,
  info: SensorImageInfo,
  referenceInfo?: AahdReferenceInfo,
): void {
  if (info.sensorType !== "bayer" || info.cfaSize !== 2) {
    throw new Error("The LibRaw AAHD benchmark requires a Bayer RAW.");
  }
  if (
    info.orientation !== 0 ||
    info.width % 2 !== 0 ||
    info.height % 2 !== 0 ||
    mosaic.length !== info.sampleCount
  ) {
    throw new Error(
      "The LibRaw AAHD benchmark requires an even, unrotated, complete mosaic.",
    );
  }
  if (
    !referenceInfo &&
    !info.blackLevels.every((value) => value === info.blackLevels[0])
  ) {
    throw new Error(
      "The AAHD performance path currently requires one common black level.",
    );
  }
}

async function getRuntime(requiredBufferBytes: number): Promise<Runtime> {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    if (!("gpu" in navigator)) throw new Error("WebGPU is unavailable.");
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) throw new Error("No WebGPU adapter is available.");
    if (
      requiredBufferBytes > adapter.limits.maxBufferSize ||
      requiredBufferBytes > adapter.limits.maxStorageBufferBindingSize
    ) {
      throw new Error(
        `The WebGPU adapter cannot bind the required ${requiredBufferBytes}-byte AAHD buffer.`,
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
      label: "LibRaw AAHD",
    });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter(
      (message) => message.type === "error",
    );
    if (errors.length) {
      throw new Error(
        `LibRaw AAHD shader failed: ${errors.map((error) => `${error.lineNum}:${error.linePos} ${error.message}`).join("; ")}`,
      );
    }
    const entries = await Promise.all(
      ENTRY_POINTS.map(
        async (entryPoint) =>
          [
            entryPoint,
            await device.createComputePipelineAsync({
              label: `LibRaw AAHD ${entryPoint}`,
              layout: "auto",
              compute: { module, entryPoint },
            }),
          ] as const,
      ),
    );
    return {
      adapter,
      device,
      pipelines: Object.fromEntries(entries) as Record<
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
  const paddedWidth = info.width + 8;
  const paddedHeight = info.height + 8;
  const paddedSamples = paddedWidth * paddedHeight;
  const vectorBytes = paddedSamples * 4 * Uint32Array.BYTES_PER_ELEMENT;
  const scalarBytes = paddedSamples * Uint32Array.BYTES_PER_ELEMENT;
  const packedBytes =
    (info.sampleCount / 2) * 3 * Uint32Array.BYTES_PER_ELEMENT;
  const create = (size: number, usage: GPUBufferUsageFlags) =>
    device.createBuffer({ size, usage });
  const gamma = createGammaLut();
  const resources = [
    create(
      Math.ceil(mosaicBytes / 4) * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    ),
    create(vectorBytes, GPUBufferUsage.STORAGE),
    create(vectorBytes, GPUBufferUsage.STORAGE),
    create(vectorBytes, GPUBufferUsage.STORAGE),
    create(vectorBytes, GPUBufferUsage.STORAGE),
    create(scalarBytes, GPUBufferUsage.STORAGE),
    create(scalarBytes, GPUBufferUsage.STORAGE),
    create(scalarBytes, GPUBufferUsage.STORAGE),
    create(
      6 * Uint32Array.BYTES_PER_ELEMENT,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    ),
    create(gamma.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    create(packedBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
    create(
      64 * Uint32Array.BYTES_PER_ELEMENT,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    ),
  ];
  device.queue.writeBuffer(resources[9], 0, gamma);
  cachedWorkspace = {
    width: info.width,
    height: info.height,
    paddedWidth,
    paddedHeight,
    packedBytes,
    resources,
    readback: create(
      packedBytes,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    ),
  };
  return cachedWorkspace;
}

function destroyWorkspace(workspace: Workspace): void {
  for (const buffer of workspace.resources) buffer.destroy();
  workspace.readback.destroy();
}

function submitPass(
  runtime: Runtime,
  workspace: Workspace,
  entryPoint: EntryPoint,
  padded = false,
  paired = false,
): void {
  const pipeline = runtime.pipelines[entryPoint];
  const bindGroup = runtime.device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: BINDINGS[entryPoint].map((binding) => ({
      binding,
      resource: { buffer: workspace.resources[binding] },
    })),
  });
  const encoder = runtime.device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  const width = padded ? workspace.paddedWidth : workspace.width;
  const height = padded ? workspace.paddedHeight : workspace.height;
  pass.dispatchWorkgroups(
    Math.ceil((paired ? width / 2 : width) / 16),
    Math.ceil(height / 16),
  );
  pass.end();
  runtime.device.queue.submit([encoder.finish()]);
}

function createParameters(
  info: SensorImageInfo,
  workspace: Workspace,
  reference?: AahdReferenceInfo,
): Uint32Array<ArrayBuffer> {
  const parameters = new Uint32Array(64);
  const floats = new Float32Array(parameters.buffer);
  parameters[0] = info.width;
  parameters[1] = info.height;
  parameters[2] = workspace.paddedWidth;
  parameters[3] = workspace.paddedHeight;
  for (let channel = 0; channel < 4; channel += 1) {
    floats[8 + channel] = info.blackLevels[channel];
  }
  const { scale, pre } = reference
    ? { scale: reference.scaleMultipliers, pre: reference.preMultipliers }
    : calculateScale(info);
  floats.set(scale, 12);
  floats.set(pre, 16);
  floats.set(reference?.yuvMatrix ?? info.aahdYuvMatrix, 20);
  floats.set(reference?.outputMatrix ?? info.librawProPhotoMatrix, 32);
  parameters.set(info.cfaPattern, 48);
  return parameters;
}

function calculateScale(info: SensorImageInfo): {
  scale: Float32Array;
  pre: Float32Array;
} {
  const camera = info.cameraWhiteBalance.map((value, channel) =>
    value > 0 ? value : info.cameraWhiteBalance[channel === 3 ? 1 : channel],
  );
  const maximum = Math.max(...camera);
  const pre = new Float32Array(4);
  const scale = new Float32Array(4);
  const sensorRange = info.whiteLevel - info.blackLevels[0];
  for (let channel = 0; channel < 4; channel += 1) {
    pre[channel] = Math.fround(camera[channel] / maximum);
    scale[channel] = Math.fround(
      Math.fround(Math.fround(pre[channel] * 65535) / sensorRange),
    );
  }
  return { scale, pre };
}

function createGammaLut(): Float32Array<ArrayBuffer> {
  const lut = new Float32Array(65536);
  const exponent = Math.fround(0.45);
  const gain = Math.fround(1.0993);
  const offset = Math.fround(0.0993);
  for (let index = 0; index < lut.length; index += 1) {
    const sample = Math.fround(index / 65536);
    lut[index] =
      sample < Math.fround(0.0181)
        ? Math.fround(65536 * Math.fround(Math.fround(4.5) * sample))
        : Math.fround(65536 * (gain * Math.pow(sample, exponent) - offset));
  }
  return lut;
}

function normalizedCfa(channel: number): number {
  return channel === 3 ? 1 : channel;
}

function scaleSample(sample: number, black: number, scale: number): number {
  return Math.trunc(
    Math.min(
      65535,
      Math.max(0, Math.fround(Math.fround(sample - black) * scale)),
    ),
  );
}

function largestBufferBytes(info: SensorImageInfo): number {
  return (
    (info.width + 8) * (info.height + 8) * 4 * Uint32Array.BYTES_PER_ELEMENT
  );
}

function compareRgb16(
  actual: Uint16Array,
  expected: Uint16Array,
): LibRawAahdValidation {
  if (actual.length !== expected.length) {
    throw new Error(
      `The LibRaw reference has ${expected.length} samples; expected ${actual.length}.`,
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
