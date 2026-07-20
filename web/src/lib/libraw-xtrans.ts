import shader from "../demosaic/libraw-xtrans.wgsl?raw";
import { calculateDemosaicScale, type SensorImageInfo } from "./sensor-image";
import type { WebGpuColorRenderer } from "./webgpu-color";
import {
  getWebGpuRuntime,
  type WebGpuRuntime,
  writePaddedBuffer,
} from "./webgpu-runtime";
import {
  createXtransTiles,
  validateXtransInput,
  XTRANS_TILE_SIZE,
  type XtransPattern,
  type XtransTile,
} from "./xtrans-tiles";

const ENTRY_POINTS = [
  "scale_mosaic",
  "initialize_candidates",
  "interpolate_solitary_first",
  "interpolate_cross_first",
  "interpolate_blocks_first",
  "copy_candidates",
  "recalculate_green",
  "interpolate_solitary_refined",
  "interpolate_cross_refined",
  "interpolate_blocks_refined",
  "multiply_lab_red",
  "add_lab_red",
  "multiply_lab_green",
  "add_lab_green",
  "multiply_lab_blue",
  "add_lab_blue",
  "lookup_lab",
  "build_lab_differences",
  "subtract_lab_offset",
  "finish_lab",
  "differentiate",
  "build_homogeneity",
  "choose_rgb",
  "save_overlap",
  "blend_highlights",
  "write_final",
] as const;

type EntryPoint = (typeof ENTRY_POINTS)[number];

const BINDINGS: Record<EntryPoint, readonly number[]> = {
  scale_mosaic: [0, 7],
  initialize_candidates: [0, 1, 7, 9, 10, 11],
  interpolate_solitary_first: [1, 7],
  interpolate_cross_first: [1, 7],
  interpolate_blocks_first: [1, 7],
  copy_candidates: [1, 7],
  recalculate_green: [0, 1, 7, 9, 10, 11],
  interpolate_solitary_refined: [1, 7],
  interpolate_cross_refined: [1, 7],
  interpolate_blocks_refined: [1, 7],
  multiply_lab_red: [1, 7, 12],
  add_lab_red: [2, 7, 12],
  multiply_lab_green: [1, 7, 12],
  add_lab_green: [2, 7, 12],
  multiply_lab_blue: [1, 7, 12],
  add_lab_blue: [2, 7, 12],
  lookup_lab: [2, 7, 8, 12],
  build_lab_differences: [2, 7, 12],
  subtract_lab_offset: [2, 7],
  finish_lab: [2, 7],
  differentiate: [2, 3, 7],
  build_homogeneity: [3, 4, 7],
  choose_rgb: [0, 1, 4, 5, 7],
  save_overlap: [0, 1, 4, 5, 7, 9, 10, 11],
  blend_highlights: [5, 7],
  write_final: [5, 6, 7],
};

const INTERPOLATION_PASSES: readonly EntryPoint[] = [
  "initialize_candidates",
  "interpolate_solitary_first",
  "interpolate_cross_first",
  "interpolate_blocks_first",
  "copy_candidates",
  "recalculate_green",
  "interpolate_solitary_refined",
  "interpolate_cross_refined",
  "interpolate_blocks_refined",
  "recalculate_green",
  "interpolate_solitary_refined",
  "interpolate_cross_refined",
  "interpolate_blocks_refined",
  "multiply_lab_red",
  "add_lab_red",
  "multiply_lab_green",
  "add_lab_green",
  "multiply_lab_blue",
  "add_lab_blue",
];

const HOMOGENEITY_PASSES: readonly EntryPoint[] = [
  "lookup_lab",
  "build_lab_differences",
  "subtract_lab_offset",
  "finish_lab",
  "differentiate",
  "build_homogeneity",
  "choose_rgb",
  "save_overlap",
];

const TILE_PIXELS = XTRANS_TILE_SIZE * XTRANS_TILE_SIZE;
const LINEAR_DISPATCH_WIDTH = 65535;
const PARAMETER_WORDS = 256;

interface XtransRuntime extends WebGpuRuntime {
  pipelines: Record<EntryPoint, GPUComputePipeline>;
}

interface XtransWorkspace {
  buffers: GPUBuffer[];
  bindGroups: Record<EntryPoint, GPUBindGroup>;
  parameterBuffer: GPUBuffer;
  outputBuffer: GPUBuffer;
  colorBuffer: GPUBuffer;
  outputReadbacks: [GPUBuffer, GPUBuffer];
  outputBytes: number;
  peakGpuBytes: number;
  maximumBufferBytes: number;
}

interface PendingReadback {
  buffer: GPUBuffer;
  bytes: number;
  samples: number;
  tile: XtransTile;
  ready: Promise<void>;
}

export interface LibRawXtransTimings {
  deviceAndPipelinesMs: number;
  workspaceCreateMs: number;
  scaleMs: number;
  interpolateMs: number;
  homogeneityMs: number;
  highlightMs: number;
  colorMs: number;
  readbackMs: number;
  totalMs: number;
}

export interface LibRawXtransResult {
  width: number;
  height: number;
  algorithm: "LibRaw Markesteijn X-Trans parity";
  backend: "native-wgsl";
  adapterInfo: {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
    isFallbackAdapter: boolean;
  };
  resources: {
    tileSize: number;
    tileCount: number;
    peakGpuBytes: number;
    maximumBufferBytes: number;
  };
  timings: LibRawXtransTimings;
}

export interface TiledXtransColor {
  renderer: WebGpuColorRenderer;
  ev: number;
  whiteBalance: Float32Array;
}

export type XtransBandWriter = (
  pixels: Uint16Array<ArrayBuffer>,
) => void | Promise<void>;

const runtimePromises = new WeakMap<GPUDevice, Promise<XtransRuntime>>();

/** Runs LibRaw's three-pass Markesteijn X-Trans demosaic in bounded GPU tiles. */
export async function demosaicLibRawXtransTiledWithWgsl(
  mosaic: Uint16Array,
  info: SensorImageInfo,
  cbrtLut: Float32Array<ArrayBuffer>,
  color?: TiledXtransColor,
  writeBand?: XtransBandWriter,
  outputStage: "final" | "demosaic" = "final",
): Promise<LibRawXtransResult> {
  const pattern = validateXtransInput(info);
  if (mosaic.length !== info.sampleCount) {
    throw new Error("WebGPU X-Trans received an incomplete sensor mosaic.");
  }
  if (cbrtLut.length !== 65536) {
    throw new Error("WebGPU X-Trans requires LibRaw's complete CIELab LUT.");
  }
  const startedAt = performance.now();
  const tiles = createXtransTiles(info.width, info.height);
  const mosaicBytes =
    Math.ceil(info.sampleCount / 2) * Uint32Array.BYTES_PER_ELEMENT;
  const runtimeStartedAt = performance.now();
  const shared = await getWebGpuRuntime(mosaicBytes);
  const runtime = await getRuntime(shared);
  const deviceAndPipelinesMs = performance.now() - runtimeStartedAt;
  const workspaceStartedAt = performance.now();
  const workspace = createWorkspace(runtime, mosaicBytes, info.width, cbrtLut);
  const workspaceCreateMs = performance.now() - workspaceStartedAt;
  const parameters = createParameters(info, pattern);
  parameters[14] = outputStage === "final" ? 0 : 1;
  let interpolateMs = 0;
  let homogeneityMs = 0;
  let highlightMs = 0;
  let colorMs = 0;
  let readbackMs = 0;

  try {
    writePaddedBuffer(
      runtime.device,
      workspace.buffers[0],
      mosaic,
      mosaicBytes,
    );
    runtime.device.queue.writeBuffer(workspace.parameterBuffer, 0, parameters);
    const scaleStartedAt = performance.now();
    submitLinear(
      runtime,
      workspace,
      "scale_mosaic",
      Math.ceil(info.sampleCount / 2),
      256,
    );
    await runtime.device.queue.onSubmittedWorkDone();
    const scaleMs = performance.now() - scaleStartedAt;

    let band = writeBand
      ? new Uint16Array(info.width * tiles[0].outputHeight * 3)
      : undefined;
    let bandY = 0;
    let pending: PendingReadback | undefined;
    const active = new Set<PendingReadback>();

    const consume = async (readback: PendingReadback) => {
      const readbackStartedAt = performance.now();
      try {
        await readback.ready;
        readbackMs += performance.now() - readbackStartedAt;
        if (!band) return;
        const source = new Uint16Array(
          readback.buffer.getMappedRange(0, readback.bytes),
          0,
          readback.samples,
        );
        writeTile(source, readback.tile, band, info.width, bandY);
        if (readback.tile.outputX + readback.tile.outputWidth === info.width) {
          await writeBand!(band);
          bandY += readback.tile.outputHeight;
          const next = tiles.find((tile) => tile.outputY === bandY);
          band = next
            ? new Uint16Array(info.width * next.outputHeight * 3)
            : undefined;
        }
      } finally {
        if (readback.buffer.mapState === "mapped") readback.buffer.unmap();
        active.delete(readback);
      }
    };

    let bandIndex = 0;
    let currentTileBandY = tiles[0].outputY;
    for (const [tileIndex, tile] of tiles.entries()) {
      if (tile.outputY !== currentTileBandY) {
        bandIndex += 1;
        currentTileBandY = tile.outputY;
      }
      const previous = pending ? consume(pending) : undefined;
      prepareTile(runtime.device, workspace, parameters, tile, bandIndex);

      const interpolationStartedAt = performance.now();
      submitTilePasses(runtime, workspace, INTERPOLATION_PASSES);
      interpolateMs += performance.now() - interpolationStartedAt;

      const homogeneityStartedAt = performance.now();
      submitTilePasses(runtime, workspace, HOMOGENEITY_PASSES);
      homogeneityMs += performance.now() - homogeneityStartedAt;

      const highlightStartedAt = performance.now();
      if (outputStage === "final") {
        submitTilePasses(runtime, workspace, ["blend_highlights"]);
      }
      highlightMs += performance.now() - highlightStartedAt;

      const colorStartedAt = performance.now();
      submitLinear(
        runtime,
        workspace,
        "write_final",
        Math.ceil((tile.outputWidth * tile.outputHeight) / 2),
        256,
      );
      let output = workspace.outputBuffer;
      if (color && outputStage === "final") {
        color.renderer.renderBuffer(
          workspace.outputBuffer,
          workspace.colorBuffer,
          tile.outputWidth * tile.outputHeight,
          color.ev,
          color.whiteBalance,
        );
        output = workspace.colorBuffer;
      }
      colorMs += performance.now() - colorStartedAt;
      const next = scheduleReadback(
        runtime.device,
        output,
        workspace.outputReadbacks[tileIndex & 1],
        tile,
      );
      active.add(next);
      if (previous) await previous;
      pending = next;
    }
    if (pending) await consume(pending);
    if (active.size !== 0) {
      throw new Error("WebGPU X-Trans left an unread output tile.");
    }

    return {
      width: info.width,
      height: info.height,
      algorithm: "LibRaw Markesteijn X-Trans parity",
      backend: "native-wgsl",
      adapterInfo: {
        vendor: runtime.adapter.info.vendor,
        architecture: runtime.adapter.info.architecture,
        device: runtime.adapter.info.device,
        description: runtime.adapter.info.description,
        isFallbackAdapter: runtime.adapter.info.isFallbackAdapter,
      },
      resources: {
        tileSize: XTRANS_TILE_SIZE,
        tileCount: tiles.length,
        peakGpuBytes: workspace.peakGpuBytes,
        maximumBufferBytes: workspace.maximumBufferBytes,
      },
      timings: {
        deviceAndPipelinesMs,
        workspaceCreateMs,
        scaleMs,
        interpolateMs,
        homogeneityMs,
        highlightMs,
        colorMs,
        readbackMs,
        totalMs: performance.now() - startedAt,
      },
    };
  } finally {
    destroyWorkspace(workspace);
  }
}

async function getRuntime(shared: WebGpuRuntime): Promise<XtransRuntime> {
  let promise = runtimePromises.get(shared.device);
  if (!promise) {
    promise = createRuntime(shared);
    runtimePromises.set(shared.device, promise);
  }
  return promise;
}

async function createRuntime(shared: WebGpuRuntime): Promise<XtransRuntime> {
  const module = shared.device.createShaderModule({
    code: shader,
    label: "LibRaw X-Trans shader",
  });
  const compilation = await module.getCompilationInfo();
  const errors = compilation.messages.filter(
    (message) => message.type === "error",
  );
  if (errors.length !== 0) {
    throw new Error(
      `LibRaw X-Trans shader failed to compile: ${errors
        .map(
          ({ lineNum, linePos, message }) => `${lineNum}:${linePos} ${message}`,
        )
        .join("; ")}`,
    );
  }
  const pipelines = Object.fromEntries(
    await Promise.all(
      ENTRY_POINTS.map(async (entryPoint) => [
        entryPoint,
        await shared.device.createComputePipelineAsync({
          label: `LibRaw X-Trans ${entryPoint}`,
          layout: "auto",
          compute: { module, entryPoint },
        }),
      ]),
    ),
  ) as Record<EntryPoint, GPUComputePipeline>;
  return { ...shared, pipelines };
}

function createWorkspace(
  runtime: XtransRuntime,
  mosaicBytes: number,
  width: number,
  cbrtLut: Float32Array<ArrayBuffer>,
): XtransWorkspace {
  const { device } = runtime;
  const vectorBytes = TILE_PIXELS * 8 * 4 * Uint32Array.BYTES_PER_ELEMENT;
  const scalarDirectionBytes = TILE_PIXELS * 8 * Uint32Array.BYTES_PER_ELEMENT;
  const chosenBytes = TILE_PIXELS * 4 * Uint32Array.BYTES_PER_ELEMENT;
  const outputBytes =
    Math.ceil(TILE_PIXELS / 2) * 3 * Uint32Array.BYTES_PER_ELEMENT;
  const bandBytes = width * 8 * 4 * Uint32Array.BYTES_PER_ELEMENT;
  const descriptors: GPUBufferDescriptor[] = [
    {
      size: mosaicBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    },
    { size: vectorBytes, usage: GPUBufferUsage.STORAGE },
    { size: vectorBytes, usage: GPUBufferUsage.STORAGE },
    { size: scalarDirectionBytes, usage: GPUBufferUsage.STORAGE },
    { size: scalarDirectionBytes, usage: GPUBufferUsage.STORAGE },
    { size: chosenBytes, usage: GPUBufferUsage.STORAGE },
    {
      size: outputBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    {
      size: PARAMETER_WORDS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    },
    {
      size: 65536 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    },
    { size: bandBytes, usage: GPUBufferUsage.STORAGE },
    { size: bandBytes, usage: GPUBufferUsage.STORAGE },
    {
      size: XTRANS_TILE_SIZE * 8 * 4 * Uint32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE,
    },
    { size: vectorBytes, usage: GPUBufferUsage.STORAGE },
  ];
  const buffers: GPUBuffer[] = [];
  try {
    for (const [index, descriptor] of descriptors.entries()) {
      buffers.push(
        device.createBuffer({
          ...descriptor,
          label: `X-Trans resource ${index}`,
        }),
      );
    }
    const colorBuffer = device.createBuffer({
      label: "X-Trans graded output",
      size: outputBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    buffers.push(colorBuffer);
    const outputReadbacks = [0, 1].map((index) => {
      const buffer = device.createBuffer({
        label: `X-Trans output readback ${index}`,
        size: outputBytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      buffers.push(buffer);
      return buffer;
    }) as [GPUBuffer, GPUBuffer];
    device.queue.writeBuffer(buffers[8], 0, cbrtLut);
    const bindGroups = Object.fromEntries(
      ENTRY_POINTS.map((entryPoint) => {
        const pipeline = runtime.pipelines[entryPoint];
        return [
          entryPoint,
          device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: BINDINGS[entryPoint].map((binding) => ({
              binding,
              resource: { buffer: buffers[binding] },
            })),
          }),
        ];
      }),
    ) as Record<EntryPoint, GPUBindGroup>;
    return {
      buffers,
      bindGroups,
      parameterBuffer: buffers[7],
      outputBuffer: buffers[6],
      colorBuffer,
      outputReadbacks,
      outputBytes,
      peakGpuBytes: buffers.reduce((sum, buffer) => sum + buffer.size, 0),
      maximumBufferBytes: Math.max(...buffers.map((buffer) => buffer.size)),
    };
  } catch (error) {
    for (const buffer of buffers) buffer.destroy();
    throw new Error("WebGPU could not allocate the X-Trans tile workspace.", {
      cause: error,
    });
  }
}

function createParameters(
  info: SensorImageInfo,
  pattern: XtransPattern,
): Uint32Array<ArrayBuffer> {
  const parameters = new Uint32Array(PARAMETER_WORDS);
  const integers = new Int32Array(parameters.buffer);
  const floats = new Float32Array(parameters.buffer);
  parameters[0] = info.width;
  parameters[1] = info.height;
  parameters[10] = pattern.solitaryGreenRow;
  parameters[11] = pattern.solitaryGreenColumn;
  for (let channel = 0; channel < 4; channel += 1) {
    floats[16 + channel] = info.blackLevels[channel];
  }
  const { scale, pre } = calculateDemosaicScale(info);
  floats.set(scale, 20);
  floats.set(pre, 24);
  floats.set(info.xtransLabMatrix, 28);
  floats.set(info.librawProPhotoMatrix, 40);
  parameters.set(info.cfaPattern, 64);
  integers.set(pattern.hexDeltas, 100);
  return parameters;
}

function prepareTile(
  device: GPUDevice,
  workspace: XtransWorkspace,
  parameters: Uint32Array<ArrayBuffer>,
  tile: XtransTile,
  bandIndex: number,
): void {
  parameters[2] = tile.inputX;
  parameters[3] = tile.inputY;
  parameters[4] = tile.inputWidth;
  parameters[5] = tile.inputHeight;
  parameters[6] = tile.outputX;
  parameters[7] = tile.outputY;
  parameters[8] = tile.outputWidth;
  parameters[9] = tile.outputHeight;
  parameters[13] = bandIndex;
  device.queue.writeBuffer(workspace.parameterBuffer, 0, parameters);
}

function submitTilePasses(
  runtime: XtransRuntime,
  workspace: XtransWorkspace,
  entryPoints: readonly EntryPoint[],
): void {
  const encoder = runtime.device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  for (const entryPoint of entryPoints) {
    const pipeline = runtime.pipelines[entryPoint];
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, workspace.bindGroups[entryPoint]);
    if (
      entryPoint.startsWith("multiply_lab_") ||
      entryPoint.startsWith("add_lab_") ||
      entryPoint === "lookup_lab" ||
      entryPoint === "build_lab_differences" ||
      entryPoint === "subtract_lab_offset" ||
      entryPoint === "finish_lab" ||
      entryPoint === "differentiate" ||
      entryPoint === "build_homogeneity"
    ) {
      pass.dispatchWorkgroups(
        Math.ceil(XTRANS_TILE_SIZE / 8),
        Math.ceil(XTRANS_TILE_SIZE / 8),
        8,
      );
    } else {
      pass.dispatchWorkgroups(
        Math.ceil(XTRANS_TILE_SIZE / 16),
        Math.ceil(XTRANS_TILE_SIZE / 16),
      );
    }
  }
  pass.end();
  runtime.device.queue.submit([encoder.finish()]);
}

function submitLinear(
  runtime: XtransRuntime,
  workspace: XtransWorkspace,
  entryPoint: EntryPoint,
  invocations: number,
  workgroupSize: 1 | 256,
): void {
  const groups = Math.ceil(invocations / workgroupSize);
  const width = Math.min(groups, LINEAR_DISPATCH_WIDTH);
  const encoder = runtime.device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(runtime.pipelines[entryPoint]);
  pass.setBindGroup(0, workspace.bindGroups[entryPoint]);
  pass.dispatchWorkgroups(width, Math.ceil(groups / width));
  pass.end();
  runtime.device.queue.submit([encoder.finish()]);
}

function scheduleReadback(
  device: GPUDevice,
  source: GPUBuffer,
  destination: GPUBuffer,
  tile: XtransTile,
): PendingReadback {
  const samples = tile.outputWidth * tile.outputHeight * 3;
  const bytes = Math.ceil(samples / 6) * 12;
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, destination, 0, bytes);
  device.queue.submit([encoder.finish()]);
  return {
    buffer: destination,
    bytes,
    samples,
    tile,
    ready: destination.mapAsync(GPUMapMode.READ, 0, bytes),
  };
}

function writeTile(
  source: Uint16Array,
  tile: XtransTile,
  destination: Uint16Array,
  destinationWidth: number,
  destinationY: number,
): void {
  const rowSamples = tile.outputWidth * 3;
  for (let row = 0; row < tile.outputHeight; row += 1) {
    destination.set(
      source.subarray(row * rowSamples, (row + 1) * rowSamples),
      ((tile.outputY - destinationY + row) * destinationWidth + tile.outputX) *
        3,
    );
  }
}

function destroyWorkspace(workspace: XtransWorkspace): void {
  for (const buffer of workspace.buffers) {
    if (buffer.mapState === "mapped") buffer.unmap();
    buffer.destroy();
  }
}
