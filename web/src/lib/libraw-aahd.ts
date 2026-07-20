import shader from "../demosaic/libraw-aahd.wgsl?raw";
import {
  calculateDemosaicScale,
  scaleDemosaicSample,
  type SensorImageInfo,
} from "./sensor-image";
import {
  blendLibRawHighlights,
  correctLibRawSparseDefects,
  createLibRawGammaLut,
  refineLibRawSerialDirections,
} from "./aahd-parity-cpu";
import {
  AAHD_TILE_CORE_SIZE,
  AAHD_TILE_HALO,
  createAahdTiles,
  type AahdTile,
} from "./aahd-tiles";
import type { WebGpuColorRenderer } from "./webgpu-color";
import { getWebGpuRuntime } from "./webgpu-runtime";

export interface LibRawAahdTimings {
  deviceCreateMs: number;
  workspaceCreateMs: number;
  scaleAndInitializeMs: number;
  serialDefectMs: number;
  interpolateMs: number;
  homogeneityMs: number;
  refineAndCombineMs: number;
  serialDirectionMs: number;
  serialHighlightMs: number;
  highlightMs: number;
  colorMs: number;
  readbackMs: number;
  totalMs: number;
}

export interface LibRawAahdResult {
  width: number;
  height: number;
  algorithm: "LibRaw AAHD parity";
  backend: "native-wgsl";
  adapterInfo: {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
    isFallbackAdapter: boolean;
  };
  resources: {
    tileCoreSize: number;
    tileHalo: number;
    tileCount: number;
    peakGpuBytes: number;
    maximumBufferBytes: number;
  };
  timings: LibRawAahdTimings;
}

const ENTRY_POINTS = [
  "preprocess_scale_pairs",
  "preprocess_classify_defects",
  "clear_tile",
  "initialize_parity",
  "interpolate_green",
  "interpolate_rb_at_green",
  "interpolate_remaining_rb",
  "convert_candidates_to_yuv_parity",
  "evaluate_homogeneity",
  "choose_direction",
  "refine_checker_even",
  "refine_checker_odd",
  "load_tiled_direction_plane",
  "combine",
  "write_direction_plane",
  "collect_highlights",
  "apply_highlights",
  "write_final",
] as const;

type EntryPoint = (typeof ENTRY_POINTS)[number];

interface PassCommand {
  entryPoint: EntryPoint;
  padded?: boolean;
  paired?: boolean;
  linearWorkgroups?: number;
  core?: boolean;
}

// WebGPU guarantees at least 65,535 workgroups per dispatch dimension. Keep
// this in sync with LINEAR_DISPATCH_WIDTH in the shader.
const LINEAR_DISPATCH_WIDTH = 65535;

const BINDINGS: Record<EntryPoint, number[]> = {
  preprocess_scale_pairs: [0, 8, 10, 11],
  preprocess_classify_defects: [10, 11, 12],
  clear_tile: [1, 2, 3, 4, 5, 6, 7, 11],
  initialize_parity: [0, 1, 2, 5, 11, 12],
  interpolate_green: [1, 2, 8, 11],
  interpolate_rb_at_green: [1, 2, 8, 11],
  interpolate_remaining_rb: [1, 2, 8, 11],
  convert_candidates_to_yuv_parity: [1, 2, 3, 4, 9, 11],
  evaluate_homogeneity: [3, 4, 6, 7, 11],
  choose_direction: [3, 4, 5, 6, 7, 11],
  refine_checker_even: [5, 11],
  refine_checker_odd: [5, 11],
  load_tiled_direction_plane: [5, 11, 15],
  combine: [1, 2, 5, 11, 13],
  write_direction_plane: [5, 10, 11],
  collect_highlights: [1, 10, 11, 14],
  apply_highlights: [1, 10, 11],
  write_final: [1, 10, 11],
};

const PARITY_INTERPOLATION_PASSES: readonly PassCommand[] = [
  { entryPoint: "interpolate_green" },
  { entryPoint: "interpolate_rb_at_green" },
  { entryPoint: "interpolate_remaining_rb" },
  { entryPoint: "convert_candidates_to_yuv_parity", padded: true },
];

interface Runtime {
  adapter: GPUAdapter;
  device: GPUDevice;
  module: GPUShaderModule;
  pipelines: Partial<Record<EntryPoint, GPUComputePipeline>>;
}

export interface TiledAahdColor {
  renderer: WebGpuColorRenderer;
  ev: number;
}

interface SparsePreprocessingResult {
  corrected: Uint16Array<ArrayBuffer>;
  defects: Uint32Array<ArrayBuffer>;
  extrema: Uint32Array<ArrayBuffer>;
  gpuMs: number;
  serialMs: number;
  peakGpuBytes: number;
  maximumBufferBytes: number;
}

export type TiledAahdBandWriter = (
  pixels: Uint16Array<ArrayBuffer>,
) => void | Promise<void>;

interface Workspace {
  width: number;
  height: number;
  paddedWidth: number;
  paddedHeight: number;
  packedBytes: number;
  coreWidth: number;
  coreHeight: number;
  resources: GPUBuffer[];
  bindGroups: Partial<Record<EntryPoint, GPUBindGroup>>;
  readback: GPUBuffer;
  outputReadbacks?: [GPUBuffer, GPUBuffer];
}

interface PendingRgbReadback {
  buffer: GPUBuffer;
  bytes: number;
  ready: Promise<void>;
  tile: AahdTile;
}

let runtimePromise: Promise<Runtime> | undefined;
let cachedTiledWorkspace: Workspace | undefined;

/** Runs the exact LibRaw-parity AAHD route with a bounded reusable tile workspace. */
export async function demosaicLibRawAahdTiledWithWgsl(
  mosaic: Uint16Array,
  info: SensorImageInfo,
  color?: TiledAahdColor,
  writeBand?: TiledAahdBandWriter,
): Promise<LibRawAahdResult> {
  validateInput(mosaic, info);
  const startedAt = performance.now();
  const tiles = createAahdTiles(info.width, info.height);
  const deviceStartedAt = performance.now();
  const runtime = await getRuntime(
    Math.max(mosaic.byteLength, tiledVectorBytes(info)),
  );
  const deviceCreateMs = performance.now() - deviceStartedAt;
  const sparsePreprocessing = await preprocessLibRawDefectsWithWgsl(
    runtime,
    mosaic,
    info,
  );
  const workspaceStartedAt = performance.now();
  const workspace = getTiledWorkspace(runtime.device, info, mosaic.byteLength);
  const workspaceCreateMs = performance.now() - workspaceStartedAt;
  const activeReadbacks = new Set<PendingRgbReadback>();
  const activeConsumers = new Set<Promise<void>>();
  try {
    const baseParameters = createTiledParameters(info, workspace, tiles[0]);
    const preMultipliers = new Float32Array(
      baseParameters.buffer,
      16 * Uint32Array.BYTES_PER_ELEMENT,
      4,
    );

    const correction = sparsePreprocessing;
    if (
      correction.corrected.length !== info.sampleCount ||
      correction.defects.length !== Math.ceil(info.sampleCount / 32) ||
      correction.extrema.length !== 6
    ) {
      throw new Error("LibRaw AAHD preprocessing returned invalid dimensions.");
    }
    const serialDefectMs = sparsePreprocessing.serialMs;
    const scaleStartedAt = performance.now();
    runtime.device.queue.writeBuffer(
      workspace.resources[0],
      0,
      correction.corrected,
    );
    runtime.device.queue.writeBuffer(
      workspace.resources[8],
      0,
      correction.extrema,
    );
    runtime.device.queue.writeBuffer(
      workspace.resources[12],
      0,
      correction.defects,
    );
    const scaleAndInitializeMs =
      sparsePreprocessing.gpuMs + performance.now() - scaleStartedAt;

    const chosenDirections = new Uint16Array(info.sampleCount);
    let interpolateMs = 0;
    let homogeneityMs = 0;
    let readbackMs = 0;
    for (const tile of tiles) {
      prepareTile(runtime.device, workspace, mosaic, info, tile);

      const interpolateStartedAt = performance.now();
      submitPasses(runtime, workspace, [
        { entryPoint: "clear_tile", padded: true },
        { entryPoint: "initialize_parity" },
        ...PARITY_INTERPOLATION_PASSES,
      ]);
      interpolateMs += performance.now() - interpolateStartedAt;

      const homogeneityStartedAt = performance.now();
      submitPasses(runtime, workspace, [
        { entryPoint: "evaluate_homogeneity" },
        { entryPoint: "choose_direction" },
        { entryPoint: "refine_checker_even" },
        { entryPoint: "refine_checker_odd" },
        { entryPoint: "write_direction_plane", paired: true },
      ]);
      const readbackStartedAt = performance.now();
      await readDirectionCore(
        runtime.device,
        workspace,
        tile,
        chosenDirections,
        info.width,
      );
      readbackMs += performance.now() - readbackStartedAt;
      homogeneityMs += readbackStartedAt - homogeneityStartedAt;
    }

    const serialDirectionStartedAt = performance.now();
    const packedDirections = new Uint32Array(Math.ceil(info.sampleCount / 8));
    refineLibRawSerialDirections(
      chosenDirections,
      info.width,
      info.height,
      packedDirections,
    );
    runtime.device.queue.writeBuffer(
      workspace.resources[15],
      0,
      packedDirections,
    );
    const serialDirectionMs = performance.now() - serialDirectionStartedAt;

    let band = writeBand
      ? new Uint16Array(
          info.width * Math.min(info.height, AAHD_TILE_CORE_SIZE) * 3,
        )
      : undefined;
    let bandY = 0;
    let serialHighlightMs = 0;
    let highlightMs = 0;
    let colorMs = 0;
    let refineAndCombineMs = 0;
    const outputReadbacks = workspace.outputReadbacks!;
    let pendingReadback: PendingRgbReadback | undefined;
    const consumeReadback = async (pending: PendingRgbReadback) => {
      const readbackStartedAt = performance.now();
      try {
        await consumeRgbReadback(pending, async (tilePixels) => {
          readbackMs += performance.now() - readbackStartedAt;
          if (band) {
            writeRgbTile(tilePixels, pending.tile, band, info.width, bandY);
            if (pending.tile.coreX + pending.tile.coreWidth === info.width) {
              await writeBand!(band);
              bandY += pending.tile.coreHeight;
              const nextHeight = Math.min(
                AAHD_TILE_CORE_SIZE,
                info.height - bandY,
              );
              band =
                nextHeight > 0
                  ? new Uint16Array(info.width * nextHeight * 3)
                  : undefined;
            }
          }
        });
      } finally {
        activeReadbacks.delete(pending);
      }
    };
    for (const [tileIndex, tile] of tiles.entries()) {
      // Start mapping and encoding the previous core before submitting this
      // core. The two readbacks alternate, so GPU work can overlap the CPU
      // consumer without reusing a mapped buffer.
      const consumePromise = pendingReadback
        ? consumeReadback(pendingReadback)
        : undefined;
      if (consumePromise) activeConsumers.add(consumePromise);
      prepareTile(runtime.device, workspace, mosaic, info, tile);
      const interpolateStartedAt = performance.now();
      submitPasses(runtime, workspace, [
        { entryPoint: "clear_tile", padded: true },
        { entryPoint: "initialize_parity" },
        ...PARITY_INTERPOLATION_PASSES,
      ]);
      interpolateMs += performance.now() - interpolateStartedAt;

      const combineStartedAt = performance.now();
      submitPasses(runtime, workspace, [
        { entryPoint: "load_tiled_direction_plane" },
        { entryPoint: "combine" },
      ]);
      refineAndCombineMs += performance.now() - combineStartedAt;

      const highlightStartedAt = performance.now();
      const serialMs = await blendLibRawHighlightsWithCpu(
        runtime,
        workspace,
        preMultipliers,
        true,
      );
      serialHighlightMs += serialMs;
      highlightMs += performance.now() - highlightStartedAt;

      const colorStartedAt = performance.now();
      submitPass(runtime, workspace, "write_final", { paired: true });
      let output = workspace.resources[10];
      if (color) {
        color.renderer.renderBuffer(
          workspace.resources[10],
          workspace.resources[3],
          tile.coreWidth * tile.coreHeight,
          color.ev,
        );
        output = workspace.resources[3];
      }
      colorMs += performance.now() - colorStartedAt;
      const nextReadback = scheduleRgbReadback(
        runtime.device,
        tile,
        output,
        outputReadbacks[tileIndex & 1],
      );
      activeReadbacks.add(nextReadback);
      if (consumePromise) {
        try {
          await consumePromise;
        } finally {
          activeConsumers.delete(consumePromise);
        }
      }
      pendingReadback = nextReadback;
    }
    if (pendingReadback) await consumeReadback(pendingReadback);

    const tiledPeakGpuBytes = [
      ...workspace.resources,
      workspace.readback,
      ...outputReadbacks,
    ].reduce((sum, buffer) => sum + buffer.size, 0);
    const tiledMaximumBufferBytes = Math.max(
      workspace.readback.size,
      ...outputReadbacks.map((buffer) => buffer.size),
      ...workspace.resources.map((buffer) => buffer.size),
    );
    const peakGpuBytes = Math.max(
      tiledPeakGpuBytes,
      sparsePreprocessing.peakGpuBytes,
    );
    const maximumBufferBytes = Math.max(
      tiledMaximumBufferBytes,
      sparsePreprocessing.maximumBufferBytes,
    );
    return {
      width: info.width,
      height: info.height,
      algorithm: "LibRaw AAHD parity",
      backend: "native-wgsl",
      adapterInfo: {
        vendor: runtime.adapter.info.vendor,
        architecture: runtime.adapter.info.architecture,
        device: runtime.adapter.info.device,
        description: runtime.adapter.info.description,
        isFallbackAdapter: runtime.adapter.info.isFallbackAdapter,
      },
      resources: {
        tileCoreSize: AAHD_TILE_CORE_SIZE,
        tileHalo: AAHD_TILE_HALO,
        tileCount: tiles.length,
        peakGpuBytes,
        maximumBufferBytes,
      },
      timings: {
        deviceCreateMs,
        workspaceCreateMs,
        scaleAndInitializeMs,
        serialDefectMs,
        interpolateMs,
        homogeneityMs,
        refineAndCombineMs,
        serialDirectionMs,
        serialHighlightMs,
        highlightMs,
        colorMs,
        readbackMs,
        totalMs: performance.now() - startedAt,
      },
    };
  } catch (error) {
    await Promise.allSettled(activeConsumers);
    await Promise.allSettled(
      Array.from(activeReadbacks, (pending) => pending.ready),
    );
    for (const pending of activeReadbacks) {
      if (pending.buffer.mapState === "mapped") pending.buffer.unmap();
    }
    if (cachedTiledWorkspace === workspace) {
      cachedTiledWorkspace = undefined;
    }
    destroyWorkspace(workspace);
    throw error;
  }
}

async function preprocessLibRawDefectsWithWgsl(
  runtime: Runtime,
  mosaic: Uint16Array,
  info: SensorImageInfo,
): Promise<SparsePreprocessingResult> {
  const startedAt = performance.now();
  const device = runtime.device;
  const sampleBytes = mosaic.byteLength;
  const defectBytes =
    Math.ceil(info.sampleCount / 32) * Uint32Array.BYTES_PER_ELEMENT;
  const extremaBytes = 6 * Uint32Array.BYTES_PER_ELEMENT;
  const readbackBytes = sampleBytes + defectBytes + extremaBytes;
  const buffers: GPUBuffer[] = [];
  let readback: GPUBuffer | undefined;
  try {
    const create = (size: number, usage: GPUBufferUsageFlags) => {
      const buffer = device.createBuffer({ size, usage });
      buffers.push(buffer);
      return buffer;
    };
    const raw = create(
      sampleBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    const scaled = create(
      sampleBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    );
    const candidates = create(
      defectBytes,
      GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
    );
    const extrema = create(
      extremaBytes,
      GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
    );
    const parameterBuffer = create(
      64 * Uint32Array.BYTES_PER_ELEMENT,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    readback = create(
      readbackBytes,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    );
    const parameters = createPreprocessingParameters(info);
    const scale = new Float32Array(parameters.buffer, 12 * 4, 4);
    const firstColor = normalizedCfa(info.cfaPattern[0]);
    const initialExtrema = new Uint32Array(6);
    initialExtrema[firstColor] = scaleDemosaicSample(
      mosaic[0],
      info.blackLevels[firstColor],
      scale[firstColor],
    );
    device.queue.writeBuffer(
      raw,
      0,
      mosaic.buffer as ArrayBuffer,
      mosaic.byteOffset,
      mosaic.byteLength,
    );
    device.queue.writeBuffer(extrema, 0, initialExtrema);
    device.queue.writeBuffer(parameterBuffer, 0, parameters);

    const encoder = device.createCommandEncoder();
    encoder.clearBuffer(candidates);
    const pass = encoder.beginComputePass();
    for (const entryPoint of [
      "preprocess_scale_pairs",
      "preprocess_classify_defects",
    ] as const) {
      const pipeline = runtime.pipelines[entryPoint]!;
      pass.setPipeline(pipeline);
      const resources: Partial<Record<number, GPUBuffer>> = {
        0: raw,
        8: extrema,
        10: scaled,
        11: parameterBuffer,
        12: candidates,
      };
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: BINDINGS[entryPoint].map((binding) => ({
            binding,
            resource: { buffer: resources[binding]! },
          })),
        }),
      );
      pass.dispatchWorkgroups(
        Math.ceil(
          (entryPoint === "preprocess_scale_pairs"
            ? info.width / 2
            : info.width) / 16,
        ),
        Math.ceil(info.height / 16),
      );
    }
    pass.end();
    encoder.copyBufferToBuffer(scaled, 0, readback, 0, sampleBytes);
    encoder.copyBufferToBuffer(
      candidates,
      0,
      readback,
      sampleBytes,
      defectBytes,
    );
    encoder.copyBufferToBuffer(
      extrema,
      0,
      readback,
      sampleBytes + defectBytes,
      extremaBytes,
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const gpuMs = performance.now() - startedAt;
    const mapped = readback.getMappedRange();
    const corrected = new Uint16Array(
      new Uint16Array(mapped, 0, info.sampleCount),
    );
    const candidateWords = new Uint32Array(
      new Uint32Array(mapped, sampleBytes, defectBytes / 4),
    );
    const resultExtrema = new Uint32Array(
      new Uint32Array(mapped, sampleBytes + defectBytes, 6),
    );
    readback.unmap();

    const serialStartedAt = performance.now();
    const defects = correctLibRawSparseDefects(
      corrected,
      info.width,
      info.height,
      info.cfaPattern,
      candidateWords,
    );
    const serialMs = performance.now() - serialStartedAt;
    return {
      corrected,
      defects,
      extrema: resultExtrema,
      gpuMs,
      serialMs,
      peakGpuBytes: buffers.reduce((sum, buffer) => sum + buffer.size, 0),
      maximumBufferBytes: Math.max(...buffers.map((buffer) => buffer.size)),
    };
  } finally {
    if (readback?.mapState === "mapped") readback.unmap();
    for (const buffer of buffers) buffer.destroy();
  }
}

async function readDirectionCore(
  device: GPUDevice,
  workspace: Workspace,
  tile: AahdTile,
  destination: Uint16Array,
  imageWidth: number,
): Promise<void> {
  const bytes =
    tile.coreWidth * tile.coreHeight * Uint16Array.BYTES_PER_ELEMENT;
  await copyToReadback(device, workspace, bytes);
  await workspace.readback.mapAsync(GPUMapMode.READ, 0, bytes);
  try {
    const source = new Uint16Array(workspace.readback.getMappedRange(0, bytes));
    for (let y = 0; y < tile.coreHeight; y += 1) {
      destination.set(
        source.subarray(y * tile.coreWidth, (y + 1) * tile.coreWidth),
        (tile.coreY + y) * imageWidth + tile.coreX,
      );
    }
  } finally {
    workspace.readback.unmap();
  }
}

function validateInput(mosaic: Uint16Array, info: SensorImageInfo): void {
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
    info.demosaicPreMultipliers.length !== 4 ||
    info.demosaicPreMultipliers.some(
      (multiplier) => !Number.isFinite(multiplier) || multiplier <= 0,
    )
  ) {
    throw new Error("LibRaw did not produce valid AAHD white balance.");
  }
}

async function getRuntime(requiredBufferBytes: number): Promise<Runtime> {
  if (runtimePromise) {
    await getWebGpuRuntime(requiredBufferBytes);
  } else {
    runtimePromise = (async () => {
      const { adapter, device } = await getWebGpuRuntime(requiredBufferBytes);
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
      return { adapter, device, module, pipelines: {} };
    })();
  }
  const runtime = await runtimePromise;
  const missing = ENTRY_POINTS.filter(
    (entryPoint) => !runtime.pipelines[entryPoint],
  );
  const pipelines = await Promise.all(
    missing.map((entryPoint) =>
      runtime.device.createComputePipelineAsync({
        label: `LibRaw AAHD ${entryPoint}`,
        layout: "auto",
        compute: { module: runtime.module, entryPoint },
      }),
    ),
  );
  for (const [index, entryPoint] of missing.entries()) {
    runtime.pipelines[entryPoint] = pipelines[index];
  }
  return runtime;
}

function getTiledWorkspace(
  device: GPUDevice,
  info: SensorImageInfo,
  mosaicBytes: number,
): Workspace {
  const width = Math.min(info.width, AAHD_TILE_CORE_SIZE + AAHD_TILE_HALO * 2);
  const height = Math.min(
    info.height,
    AAHD_TILE_CORE_SIZE + AAHD_TILE_HALO * 2,
  );
  if (
    cachedTiledWorkspace?.paddedWidth === width + 8 &&
    cachedTiledWorkspace.paddedHeight === height + 8 &&
    cachedTiledWorkspace.resources[0].size === Math.ceil(mosaicBytes / 4) * 4
  ) {
    return cachedTiledWorkspace;
  }
  if (cachedTiledWorkspace) {
    const previous = cachedTiledWorkspace;
    cachedTiledWorkspace = undefined;
    destroyWorkspace(previous);
  }
  const paddedWidth = width + 8;
  const paddedHeight = height + 8;
  const paddedSamples = paddedWidth * paddedHeight;
  const vectorBytes = paddedSamples * 4 * Uint32Array.BYTES_PER_ELEMENT;
  const scalarBytes = paddedSamples * Uint32Array.BYTES_PER_ELEMENT;
  const coreSamples =
    Math.min(info.width, AAHD_TILE_CORE_SIZE) *
    Math.min(info.height, AAHD_TILE_CORE_SIZE);
  const outputBytes = Math.max(
    coreSamples * 3 * Uint16Array.BYTES_PER_ELEMENT,
    width * height * 4 * Uint32Array.BYTES_PER_ELEMENT,
  );
  const originalTileBytes = width * height * Uint16Array.BYTES_PER_ELEMENT;
  const gamma = createLibRawGammaLut();
  const buffers: GPUBuffer[] = [];
  const create = (size: number, usage: GPUBufferUsageFlags) => {
    const buffer = device.createBuffer({
      size: Math.ceil(size / 4) * 4,
      usage,
    });
    buffers.push(buffer);
    return buffer;
  };
  try {
    const resources = [
      create(mosaicBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      create(vectorBytes, GPUBufferUsage.STORAGE),
      create(vectorBytes, GPUBufferUsage.STORAGE),
      create(vectorBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
      create(vectorBytes, GPUBufferUsage.STORAGE),
      create(scalarBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      create(scalarBytes, GPUBufferUsage.STORAGE),
      create(scalarBytes, GPUBufferUsage.STORAGE),
      create(
        6 * Uint32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      ),
      create(
        gamma.byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      ),
      create(
        outputBytes,
        GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.COPY_DST,
      ),
      create(
        64 * Uint32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      ),
      create(
        Math.ceil(info.sampleCount / 32) * Uint32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      ),
      create(
        originalTileBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      ),
      create(
        Uint32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.COPY_DST,
      ),
      create(
        Math.ceil(info.sampleCount / 8) * Uint32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      ),
    ];
    device.queue.writeBuffer(resources[9], 0, gamma);
    const workspace: Workspace = {
      width,
      height,
      paddedWidth,
      paddedHeight,
      packedBytes: outputBytes,
      coreWidth: Math.min(info.width, AAHD_TILE_CORE_SIZE),
      coreHeight: Math.min(info.height, AAHD_TILE_CORE_SIZE),
      resources,
      bindGroups: {},
      readback: create(
        outputBytes,
        GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      ),
      outputReadbacks: [
        create(outputBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
        create(outputBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
      ],
    };
    cachedTiledWorkspace = workspace;
    return workspace;
  } catch (error) {
    for (const buffer of buffers) buffer.destroy();
    throw error;
  }
}

function tiledVectorBytes(info: SensorImageInfo): number {
  const width = Math.min(info.width, AAHD_TILE_CORE_SIZE + AAHD_TILE_HALO * 2);
  const height = Math.min(
    info.height,
    AAHD_TILE_CORE_SIZE + AAHD_TILE_HALO * 2,
  );
  return (width + 8) * (height + 8) * 4 * Uint32Array.BYTES_PER_ELEMENT;
}

function createTiledParameters(
  info: SensorImageInfo,
  workspace: Workspace,
  tile: AahdTile,
): Uint32Array<ArrayBuffer> {
  const parameters = createParameters(info, workspace);
  parameters[0] = tile.inputWidth;
  parameters[1] = tile.inputHeight;
  parameters[6] = tile.inputX;
  parameters[7] = tile.inputY;
  parameters[56] = tile.localCoreX;
  parameters[57] = tile.localCoreY;
  parameters[58] = tile.coreWidth;
  parameters[59] = tile.coreHeight;
  return parameters;
}

function prepareTile(
  device: GPUDevice,
  workspace: Workspace,
  mosaic: Uint16Array,
  info: SensorImageInfo,
  tile: AahdTile,
): void {
  workspace.width = tile.inputWidth;
  workspace.height = tile.inputHeight;
  workspace.coreWidth = tile.coreWidth;
  workspace.coreHeight = tile.coreHeight;
  const source = new Uint16Array(tile.inputWidth * tile.inputHeight);
  for (let y = 0; y < tile.inputHeight; y += 1) {
    const row = (tile.inputY + y) * info.width + tile.inputX;
    source.set(
      mosaic.subarray(row, row + tile.inputWidth),
      y * tile.inputWidth,
    );
  }
  device.queue.writeBuffer(workspace.resources[13], 0, source);
  device.queue.writeBuffer(
    workspace.resources[11],
    0,
    createTiledParameters(info, workspace, tile),
  );
}

function destroyWorkspace(workspace: Workspace): void {
  for (const buffer of workspace.resources) buffer.destroy();
  workspace.readback.destroy();
  for (const buffer of workspace.outputReadbacks ?? []) buffer.destroy();
}

function scheduleRgbReadback(
  device: GPUDevice,
  tile: AahdTile,
  sourceBuffer: GPUBuffer,
  buffer: GPUBuffer,
): PendingRgbReadback {
  const rowSamples = tile.coreWidth * 3;
  const bytes = rowSamples * tile.coreHeight * Uint16Array.BYTES_PER_ELEMENT;
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(sourceBuffer, 0, buffer, 0, bytes);
  device.queue.submit([encoder.finish()]);
  return {
    buffer,
    bytes,
    ready: buffer.mapAsync(GPUMapMode.READ, 0, bytes),
    tile,
  };
}

async function consumeRgbReadback(
  pending: PendingRgbReadback,
  consume: (pixels: Uint16Array) => void | Promise<void>,
): Promise<void> {
  await pending.ready;
  try {
    const source = new Uint16Array(
      pending.buffer.getMappedRange(0, pending.bytes),
    );
    await consume(source);
  } finally {
    pending.buffer.unmap();
  }
}

function writeRgbTile(
  source: Uint16Array,
  tile: AahdTile,
  destination: Uint16Array,
  destinationWidth: number,
  destinationY: number,
): void {
  const rowSamples = tile.coreWidth * 3;
  for (let y = 0; y < tile.coreHeight; y += 1) {
    destination.set(
      source.subarray(y * rowSamples, (y + 1) * rowSamples),
      ((tile.coreY - destinationY + y) * destinationWidth + tile.coreX) * 3,
    );
  }
}

async function copyToReadback(
  device: GPUDevice,
  workspace: Workspace,
  bytes: number,
  source = workspace.resources[10],
): Promise<void> {
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, workspace.readback, 0, bytes);
  device.queue.submit([encoder.finish()]);
}

async function blendLibRawHighlightsWithCpu(
  runtime: Runtime,
  workspace: Workspace,
  preMultipliers: Float32Array,
  core = false,
): Promise<number> {
  runtime.device.queue.writeBuffer(
    workspace.resources[14],
    0,
    new Uint32Array([0]),
  );
  submitPass(runtime, workspace, "collect_highlights", { core });

  const countEncoder = runtime.device.createCommandEncoder();
  countEncoder.copyBufferToBuffer(
    workspace.resources[14],
    0,
    workspace.readback,
    0,
    Uint32Array.BYTES_PER_ELEMENT,
  );
  runtime.device.queue.submit([countEncoder.finish()]);
  await workspace.readback.mapAsync(
    GPUMapMode.READ,
    0,
    Uint32Array.BYTES_PER_ELEMENT,
  );
  let recordCount: number;
  try {
    recordCount = new Uint32Array(
      workspace.readback.getMappedRange(0, Uint32Array.BYTES_PER_ELEMENT),
    )[0];
  } finally {
    workspace.readback.unmap();
  }

  const recordBytes = recordCount * 4 * Uint32Array.BYTES_PER_ELEMENT;
  if (recordBytes > workspace.resources[10].size) {
    throw new Error(
      `LibRaw highlight collection produced ${recordCount} records, exceeding the ${workspace.resources[10].size}-byte scratch buffer.`,
    );
  }
  if (recordCount === 0) return 0;

  const recordEncoder = runtime.device.createCommandEncoder();
  recordEncoder.copyBufferToBuffer(
    workspace.resources[10],
    0,
    workspace.readback,
    0,
    recordBytes,
  );
  runtime.device.queue.submit([recordEncoder.finish()]);
  await workspace.readback.mapAsync(GPUMapMode.READ, 0, recordBytes);
  const records = new Uint32Array(recordCount * 4);
  try {
    records.set(
      new Uint32Array(workspace.readback.getMappedRange(0, recordBytes)),
    );
  } finally {
    workspace.readback.unmap();
  }

  const serialStartedAt = performance.now();
  blendLibRawHighlights(records, preMultipliers);
  const serialMs = performance.now() - serialStartedAt;
  runtime.device.queue.writeBuffer(workspace.resources[10], 0, records);
  runtime.device.queue.writeBuffer(
    workspace.resources[11],
    63 * Uint32Array.BYTES_PER_ELEMENT,
    new Uint32Array([recordCount]),
  );
  submitPass(runtime, workspace, "apply_highlights", {
    linearWorkgroups: recordCount,
  });
  return serialMs;
}

function submitPass(
  runtime: Runtime,
  workspace: Workspace,
  entryPoint: EntryPoint,
  options: Omit<PassCommand, "entryPoint"> = {},
): void {
  submitPasses(runtime, workspace, [{ entryPoint, ...options }]);
}

function submitPasses(
  runtime: Runtime,
  workspace: Workspace,
  commands: readonly PassCommand[],
): void {
  const encoder = runtime.device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  for (const command of commands) {
    const pipeline = runtime.pipelines[command.entryPoint]!;
    pass.setPipeline(pipeline);
    const bindGroup =
      workspace.bindGroups[command.entryPoint] ??
      runtime.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: BINDINGS[command.entryPoint].map((binding) => ({
          binding,
          resource: { buffer: workspace.resources[binding] },
        })),
      });
    workspace.bindGroups[command.entryPoint] = bindGroup;
    pass.setBindGroup(0, bindGroup);
    const width = command.padded
      ? workspace.paddedWidth
      : command.core || command.paired
        ? workspace.coreWidth
        : workspace.width;
    const height = command.padded
      ? workspace.paddedHeight
      : command.core || command.paired
        ? workspace.coreHeight
        : workspace.height;
    if (command.linearWorkgroups === undefined) {
      pass.dispatchWorkgroups(
        Math.ceil((command.paired ? width / 2 : width) / 16),
        Math.ceil(height / 16),
      );
    } else {
      const linearWidth = Math.min(
        command.linearWorkgroups,
        LINEAR_DISPATCH_WIDTH,
      );
      pass.dispatchWorkgroups(
        linearWidth,
        Math.ceil(command.linearWorkgroups / linearWidth),
      );
    }
  }
  pass.end();
  runtime.device.queue.submit([encoder.finish()]);
}

function createParameters(
  info: SensorImageInfo,
  workspace: Workspace,
): Uint32Array<ArrayBuffer> {
  const parameters = new Uint32Array(64);
  const floats = new Float32Array(parameters.buffer);
  parameters[0] = info.width;
  parameters[1] = info.height;
  parameters[2] = workspace.paddedWidth;
  parameters[3] = workspace.paddedHeight;
  parameters[4] = info.width;
  parameters[5] = info.height;
  for (let channel = 0; channel < 4; channel += 1) {
    floats[8 + channel] = info.blackLevels[channel];
  }
  const { scale, pre } = calculateDemosaicScale(info);
  floats.set(scale, 12);
  floats.set(pre, 16);
  floats.set(info.aahdYuvMatrix, 20);
  floats.set(info.librawProPhotoMatrix, 32);
  parameters.set(info.cfaPattern, 48);
  parameters[58] = workspace.coreWidth;
  parameters[59] = workspace.coreHeight;
  return parameters;
}

function createPreprocessingParameters(
  info: SensorImageInfo,
): Uint32Array<ArrayBuffer> {
  const parameters = new Uint32Array(64);
  const floats = new Float32Array(parameters.buffer);
  parameters[0] = info.width;
  parameters[1] = info.height;
  parameters[4] = info.width;
  for (let channel = 0; channel < 4; channel += 1) {
    floats[8 + channel] = info.blackLevels[channel];
  }
  floats.set(calculateDemosaicScale(info).scale, 12);
  parameters.set(info.cfaPattern, 48);
  return parameters;
}

function normalizedCfa(channel: number): number {
  return channel === 3 ? 1 : channel;
}
