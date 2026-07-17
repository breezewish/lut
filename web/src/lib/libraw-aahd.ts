import shader from "../demosaic/libraw-aahd.wgsl?raw";
import type { SensorImageInfo } from "./onnx-demosaic";
import { refineImmutableIsolatedDirections } from "./aahd-candidate-reference";
import {
  blendLibRawHighlights,
  correctLibRawSerialDefects,
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

export type AahdContract = "deterministic-parallel-candidate" | "libraw-parity";

export interface AahdReferenceInfo {
  width: number;
  height: number;
  inputSampleCount: number;
  outputSampleCount: number;
  highlightSampleCount: number;
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
  serialDefectMs: number;
  interpolateMs: number;
  homogeneityMs: number;
  refineAndCombineMs: number;
  serialDirectionMs: number;
  serialHighlightMs: number;
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
  actualPixelAtMaximumDifference?: number[];
  expectedPixelAtMaximumDifference?: number[];
  meanAbsoluteDifference: number;
  rootMeanSquareDifference: number;
  psnrDb: number;
}

export interface LibRawAahdResult {
  width: number;
  height: number;
  algorithm: "Deterministic parallel AAHD candidate" | "LibRaw AAHD parity";
  contract: AahdContract;
  backend: "native-wgsl";
  outputStage:
    | "scaled"
    | "corrected"
    | "defects"
    | "horizontal"
    | "vertical"
    | "horizontal-yuv"
    | "vertical-yuv"
    | "horizontal-homogeneity"
    | "vertical-homogeneity"
    | "chosen-directions"
    | "directions"
    | "candidate-directions"
    | "aahd"
    | "highlight"
    | "final"
    | "graded-final";
  adapterInfo: {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
    isFallbackAdapter: boolean;
  };
  resources?: {
    tileCoreSize: number;
    tileHalo: number;
    tileCount: number;
    peakGpuBytes: number;
    maximumBufferBytes: number;
  };
  timings: LibRawAahdTimings;
  validation?: LibRawAahdValidation;
}

const ENTRY_POINTS = [
  "preprocess_scale_pairs",
  "preprocess_classify_defects",
  "clear",
  "clear_tile",
  "initialize",
  "initialize_parity",
  "hide_hot_pixels",
  "copy_corrected",
  "write_corrected",
  "write_defects",
  "interpolate_green",
  "interpolate_rb_at_green",
  "interpolate_remaining_rb",
  "convert_candidates_to_yuv",
  "convert_candidates_to_yuv_parity",
  "initialize_yuv_first_products",
  "store_yuv_second_0",
  "add_yuv_second_0",
  "store_yuv_third_0",
  "finish_yuv_0",
  "store_yuv_second_1",
  "add_yuv_second_1",
  "store_yuv_third_1",
  "finish_yuv_1",
  "store_yuv_second_2",
  "add_yuv_second_2",
  "store_yuv_third_2",
  "finish_yuv_2",
  "write_horizontal_yuv",
  "write_vertical_yuv",
  "evaluate_homogeneity",
  "choose_direction",
  "write_horizontal_homogeneity",
  "write_vertical_homogeneity",
  "refine_checker_even",
  "refine_checker_odd",
  "load_tiled_direction_plane",
  "refine_isolated",
  "copy_refined_directions",
  "combine",
  "write_horizontal",
  "write_vertical",
  "write_directions",
  "write_direction_plane",
  "load_direction_plane",
  "write_aahd",
  "blend_highlights",
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
  clear: [5, 6, 7, 11],
  clear_tile: [1, 2, 3, 4, 5, 6, 7, 11],
  initialize: [1, 2, 8, 11, 12, 13],
  initialize_parity: [0, 1, 2, 5, 11, 12],
  hide_hot_pixels: [1, 2, 5, 11, 12],
  copy_corrected: [1, 2, 11],
  write_corrected: [1, 10, 11],
  write_defects: [10, 11, 12],
  interpolate_green: [1, 2, 8, 11],
  interpolate_rb_at_green: [1, 2, 8, 11],
  interpolate_remaining_rb: [1, 2, 8, 11],
  convert_candidates_to_yuv: [1, 2, 3, 4, 9, 11],
  convert_candidates_to_yuv_parity: [1, 2, 3, 4, 9, 11],
  initialize_yuv_first_products: [1, 2, 3, 4, 9, 11],
  store_yuv_second_0: [1, 2, 9, 11],
  add_yuv_second_0: [1, 2, 3, 4, 11],
  store_yuv_third_0: [1, 2, 9, 11],
  finish_yuv_0: [1, 2, 3, 4, 11],
  store_yuv_second_1: [1, 2, 9, 11],
  add_yuv_second_1: [1, 2, 3, 4, 11],
  store_yuv_third_1: [1, 2, 9, 11],
  finish_yuv_1: [1, 2, 3, 4, 11],
  store_yuv_second_2: [1, 2, 9, 11],
  add_yuv_second_2: [1, 2, 3, 4, 11],
  store_yuv_third_2: [1, 2, 9, 11],
  finish_yuv_2: [1, 2, 3, 4, 11],
  write_horizontal_yuv: [3, 10, 11],
  write_vertical_yuv: [4, 10, 11],
  evaluate_homogeneity: [3, 4, 6, 7, 11],
  choose_direction: [3, 4, 5, 6, 7, 11],
  write_horizontal_homogeneity: [6, 7, 10, 11],
  write_vertical_homogeneity: [6, 7, 10, 11],
  refine_checker_even: [5, 11],
  refine_checker_odd: [5, 11],
  load_tiled_direction_plane: [5, 11, 15],
  refine_isolated: [5, 6, 11],
  copy_refined_directions: [5, 6, 11],
  combine: [1, 2, 5, 11, 13],
  write_horizontal: [1, 10, 11],
  write_vertical: [2, 10, 11],
  write_directions: [5, 10, 11],
  write_direction_plane: [5, 10, 11],
  load_direction_plane: [0, 5, 11],
  write_aahd: [1, 10, 11],
  blend_highlights: [1, 11],
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
  pipelines: Record<EntryPoint, GPUComputePipeline>;
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
let cachedWorkspace: Workspace | undefined;
let cachedTiledWorkspace: Workspace | undefined;

/** Runs the deterministic parallel AAHD candidate in WGSL. */
export async function demosaicLibRawAahdWithWgsl(
  mosaic: Uint16Array,
  info: SensorImageInfo,
  contract: AahdContract,
  outputStage:
    | "scaled"
    | "corrected"
    | "defects"
    | "horizontal"
    | "vertical"
    | "horizontal-yuv"
    | "vertical-yuv"
    | "horizontal-homogeneity"
    | "vertical-homogeneity"
    | "chosen-directions"
    | "directions"
    | "candidate-directions"
    | "aahd"
    | "highlight"
    | "final",
  reference?: Uint16Array,
  referenceInfo?: AahdReferenceInfo,
  capture?: Uint16Array,
): Promise<LibRawAahdResult> {
  validateInput(mosaic, info);
  if (contract === "libraw-parity" && outputStage === "candidate-directions") {
    throw new Error("Candidate directions require the deterministic contract.");
  }
  const startedAt = performance.now();
  const deviceStartedAt = performance.now();
  const runtime = await getRuntime(largestBufferBytes(info));
  const deviceCreateMs = performance.now() - deviceStartedAt;
  const workspaceStartedAt = performance.now();
  const workspace = getWorkspace(runtime.device, info, mosaic.byteLength);
  const workspaceCreateMs = performance.now() - workspaceStartedAt;
  const parameters = createParameters(
    info,
    workspace,
    contract === "libraw-parity" ? undefined : referenceInfo,
  );
  const scaleMultipliers = new Float32Array(parameters.buffer, 12 * 4, 4);
  const preMultipliers = new Float32Array(parameters.buffer, 16 * 4, 4);
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
    runtime.device.queue.writeBuffer(
      workspace.resources[13],
      0,
      mosaic.buffer,
      mosaic.byteOffset,
      mosaic.byteLength,
    );
    runtime.device.queue.writeBuffer(workspace.resources[8], 0, extrema);
    runtime.device.queue.writeBuffer(workspace.resources[11], 0, parameters);
    submitPass(runtime, workspace, "clear", true);
    submitPass(runtime, workspace, "initialize");
    if (outputStage === "scaled") {
      submitPass(runtime, workspace, "write_corrected", false, true);
    }
    await runtime.device.queue.onSubmittedWorkDone();
    const scaleAndInitializeMs = performance.now() - scaleStartedAt;

    const hotStartedAt = performance.now();
    let serialDefectMs = 0;
    if (contract === "libraw-parity") {
      const serialStartedAt = performance.now();
      const correction = correctLibRawSerialDefects(
        mosaic,
        info.width,
        info.height,
        info.cfaPattern,
        info.blackLevels,
        scaleMultipliers,
      );
      serialDefectMs = performance.now() - serialStartedAt;
      runtime.device.queue.writeBuffer(
        workspace.resources[0],
        0,
        correction.corrected,
      );
      runtime.device.queue.writeBuffer(
        workspace.resources[12],
        0,
        correction.defects,
      );
      submitPass(runtime, workspace, "initialize_parity");
    } else {
      submitPass(runtime, workspace, "hide_hot_pixels");
      submitPass(runtime, workspace, "copy_corrected");
    }
    if (outputStage === "corrected") {
      submitPass(runtime, workspace, "write_corrected", false, true);
    } else if (outputStage === "defects") {
      submitPass(runtime, workspace, "write_defects", false, true);
    }
    await runtime.device.queue.onSubmittedWorkDone();
    const hotPixelMs = performance.now() - hotStartedAt;

    const interpolateStartedAt = performance.now();
    submitPass(runtime, workspace, "interpolate_green");
    submitPass(runtime, workspace, "interpolate_rb_at_green");
    submitPass(runtime, workspace, "interpolate_remaining_rb");
    if (contract === "libraw-parity") {
      submitPass(runtime, workspace, "initialize_yuv_first_products", true);
      for (const component of [0, 1, 2] as const) {
        submitPass(runtime, workspace, `store_yuv_second_${component}`, true);
        submitPass(runtime, workspace, `add_yuv_second_${component}`, true);
        submitPass(runtime, workspace, `store_yuv_third_${component}`, true);
        submitPass(runtime, workspace, `finish_yuv_${component}`, true);
      }
    } else {
      submitPass(runtime, workspace, "convert_candidates_to_yuv", true);
    }
    await runtime.device.queue.onSubmittedWorkDone();
    const interpolateMs = performance.now() - interpolateStartedAt;

    const homogeneityStartedAt = performance.now();
    submitPass(runtime, workspace, "evaluate_homogeneity");
    if (outputStage === "horizontal-homogeneity") {
      submitPass(
        runtime,
        workspace,
        "write_horizontal_homogeneity",
        false,
        true,
      );
    } else if (outputStage === "vertical-homogeneity") {
      submitPass(runtime, workspace, "write_vertical_homogeneity", false, true);
    }
    submitPass(runtime, workspace, "choose_direction");
    if (outputStage === "chosen-directions") {
      submitPass(runtime, workspace, "write_directions", false, true);
    }
    await runtime.device.queue.onSubmittedWorkDone();
    const homogeneityMs = performance.now() - homogeneityStartedAt;

    const refineStartedAt = performance.now();
    const stopsBeforeRefinement =
      outputStage !== "candidate-directions" &&
      outputStage !== "directions" &&
      outputStage !== "aahd" &&
      outputStage !== "highlight" &&
      outputStage !== "final";
    if (!stopsBeforeRefinement) {
      submitPass(runtime, workspace, "refine_checker_even");
      submitPass(runtime, workspace, "refine_checker_odd");
    }
    let serialDirectionMs = 0;
    let candidateDirections: Uint32Array | undefined;
    if (outputStage === "candidate-directions") {
      submitPass(runtime, workspace, "write_directions", false, true);
      await runtime.device.queue.onSubmittedWorkDone();
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
      try {
        const packed = new Uint16Array(workspace.readback.getMappedRange());
        const before = new Uint32Array(info.sampleCount);
        for (let index = 0; index < before.length; index += 1) {
          before[index] = packed[index * 3];
        }
        candidateDirections = refineImmutableIsolatedDirections(
          before,
          info.width,
          info.height,
        );
      } finally {
        workspace.readback.unmap();
      }
    }
    if (contract === "libraw-parity" && !stopsBeforeRefinement) {
      submitPass(runtime, workspace, "write_direction_plane", false, true);
      await runtime.device.queue.onSubmittedWorkDone();
      const encoder = runtime.device.createCommandEncoder();
      encoder.copyBufferToBuffer(
        workspace.resources[10],
        0,
        workspace.readback,
        0,
        mosaic.byteLength,
      );
      runtime.device.queue.submit([encoder.finish()]);
      await workspace.readback.mapAsync(GPUMapMode.READ, 0, mosaic.byteLength);
      let refined: Uint16Array<ArrayBuffer>;
      try {
        const directions = new Uint16Array(info.sampleCount);
        directions.set(
          new Uint16Array(
            workspace.readback.getMappedRange(0, mosaic.byteLength),
          ),
        );
        const serialStartedAt = performance.now();
        refined = refineLibRawSerialDirections(
          directions,
          info.width,
          info.height,
        );
        serialDirectionMs = performance.now() - serialStartedAt;
      } finally {
        workspace.readback.unmap();
      }
      runtime.device.queue.writeBuffer(workspace.resources[0], 0, refined);
      submitPass(runtime, workspace, "load_direction_plane");
    } else if (!stopsBeforeRefinement) {
      submitPass(runtime, workspace, "refine_isolated");
      submitPass(runtime, workspace, "copy_refined_directions");
    }
    if (outputStage === "horizontal-yuv") {
      submitPass(runtime, workspace, "write_horizontal_yuv", false, true);
    } else if (outputStage === "vertical-yuv") {
      submitPass(runtime, workspace, "write_vertical_yuv", false, true);
    } else if (
      outputStage === "scaled" ||
      outputStage === "corrected" ||
      outputStage === "defects"
    ) {
      // The requested preprocessing boundary was packed before interpolation.
    } else if (outputStage === "horizontal") {
      submitPass(runtime, workspace, "write_horizontal", false, true);
    } else if (outputStage === "vertical") {
      submitPass(runtime, workspace, "write_vertical", false, true);
    } else if (stopsBeforeRefinement) {
      // The requested diagnostic was packed before refinement.
    } else if (
      outputStage === "directions" ||
      outputStage === "candidate-directions"
    ) {
      submitPass(runtime, workspace, "write_directions", false, true);
    } else {
      submitPass(runtime, workspace, "combine");
    }
    await runtime.device.queue.onSubmittedWorkDone();
    const refineAndCombineMs = performance.now() - refineStartedAt;

    let highlightMs = 0;
    let serialHighlightMs = 0;
    const colorStartedAt = performance.now();
    if (
      outputStage === "scaled" ||
      outputStage === "corrected" ||
      outputStage === "defects" ||
      outputStage === "horizontal" ||
      outputStage === "vertical" ||
      outputStage === "horizontal-yuv" ||
      outputStage === "vertical-yuv" ||
      outputStage === "horizontal-homogeneity" ||
      outputStage === "vertical-homogeneity" ||
      outputStage === "chosen-directions" ||
      outputStage === "directions" ||
      outputStage === "candidate-directions"
    ) {
      // The candidate was packed before combine could overwrite it.
    } else if (outputStage === "aahd") {
      submitPass(runtime, workspace, "write_aahd", false, true);
    } else {
      const highlightStartedAt = performance.now();
      if (contract === "libraw-parity") {
        serialHighlightMs = await blendLibRawHighlightsWithCpu(
          runtime,
          workspace,
          preMultipliers,
        );
      } else {
        submitPass(runtime, workspace, "blend_highlights");
      }
      await runtime.device.queue.onSubmittedWorkDone();
      highlightMs = performance.now() - highlightStartedAt;
      submitPass(
        runtime,
        workspace,
        outputStage === "highlight" ? "write_aahd" : "write_final",
        false,
        true,
      );
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
      copyCapturedOutput(pixels, capture);
      const readbackMs = performance.now() - readbackStartedAt;
      const validationStartedAt = performance.now();
      validation = candidateDirections
        ? compareExpandedScalar(pixels, candidateDirections)
        : reference
          ? compareRgb16(pixels, reference)
          : undefined;
      validationMs = performance.now() - validationStartedAt;
      return {
        width: info.width,
        height: info.height,
        algorithm:
          contract === "libraw-parity"
            ? "LibRaw AAHD parity"
            : "Deterministic parallel AAHD candidate",
        contract,
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
          serialDefectMs,
          interpolateMs,
          homogeneityMs,
          refineAndCombineMs,
          serialDirectionMs,
          serialHighlightMs,
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

/** Runs the exact LibRaw-parity AAHD route with a bounded reusable tile workspace. */
export async function demosaicLibRawAahdTiledWithWgsl(
  mosaic: Uint16Array,
  info: SensorImageInfo,
  reference?: Uint16Array,
  capture?: Uint16Array,
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
    await runtime.device.queue.onSubmittedWorkDone();
    interpolateMs += performance.now() - interpolateStartedAt;

    const homogeneityStartedAt = performance.now();
    submitPasses(runtime, workspace, [
      { entryPoint: "evaluate_homogeneity" },
      { entryPoint: "choose_direction" },
      { entryPoint: "refine_checker_even" },
      { entryPoint: "refine_checker_odd" },
      { entryPoint: "write_direction_plane", paired: true },
    ]);
    await runtime.device.queue.onSubmittedWorkDone();
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

  const pixels =
    reference || capture ? new Uint16Array(info.sampleCount * 3) : undefined;
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
    const tilePixels = await finishRgbReadback(pending);
    readbackMs += performance.now() - readbackStartedAt;
    if (pixels) {
      writeRgbTile(tilePixels, pending.tile, pixels, info.width, 0);
    }
    if (band) {
      writeRgbTile(tilePixels, pending.tile, band, info.width, bandY);
      if (pending.tile.coreX + pending.tile.coreWidth === info.width) {
        await writeBand!(band);
        bandY += pending.tile.coreHeight;
        const nextHeight = Math.min(AAHD_TILE_CORE_SIZE, info.height - bandY);
        band =
          nextHeight > 0
            ? new Uint16Array(info.width * nextHeight * 3)
            : undefined;
      }
    }
  };
  for (const [tileIndex, tile] of tiles.entries()) {
    // Start mapping and encoding the previous core before submitting this
    // core. The two readbacks alternate, so GPU work can overlap the CPU
    // consumer without reusing a mapped buffer.
    const consumePromise = pendingReadback
      ? consumeReadback(pendingReadback)
      : undefined;
    prepareTile(runtime.device, workspace, mosaic, info, tile);
    const interpolateStartedAt = performance.now();
    submitPasses(runtime, workspace, [
      { entryPoint: "clear_tile", padded: true },
      { entryPoint: "initialize_parity" },
      ...PARITY_INTERPOLATION_PASSES,
    ]);
    await runtime.device.queue.onSubmittedWorkDone();
    interpolateMs += performance.now() - interpolateStartedAt;

    const combineStartedAt = performance.now();
    submitPasses(runtime, workspace, [
      { entryPoint: "load_tiled_direction_plane" },
      { entryPoint: "combine" },
    ]);
    await runtime.device.queue.onSubmittedWorkDone();
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
    submitPass(runtime, workspace, "write_final", false, true);
    let output = workspace.resources[10];
    if (color) {
      color.renderer.renderBuffer(
        workspace.resources[10],
        workspace.resources[3],
        tile.coreWidth * tile.coreHeight,
        color.ev,
      );
      await runtime.device.queue.onSubmittedWorkDone();
      output = workspace.resources[3];
    }
    colorMs += performance.now() - colorStartedAt;
    const nextReadback = scheduleRgbReadback(
      runtime.device,
      tile,
      output,
      outputReadbacks[tileIndex & 1],
    );
    if (consumePromise) await consumePromise;
    pendingReadback = nextReadback;
  }
  if (pendingReadback) await consumeReadback(pendingReadback);

  const validationStartedAt = performance.now();
  if (pixels) copyCapturedOutput(pixels, capture);
  const validation =
    reference && pixels ? compareRgb16(pixels, reference) : undefined;
  const validationMs = performance.now() - validationStartedAt;
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
    contract: "libraw-parity",
    backend: "native-wgsl",
    outputStage: color ? "graded-final" : "final",
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
      hotPixelMs: serialDefectMs,
      serialDefectMs,
      interpolateMs,
      homogeneityMs,
      refineAndCombineMs,
      serialDirectionMs,
      serialHighlightMs,
      highlightMs,
      colorMs,
      readbackMs,
      validationMs,
      totalMs: performance.now() - startedAt,
    },
    ...(validation ? { validation } : {}),
  };
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
  const create = (size: number, usage: GPUBufferUsageFlags) =>
    device.createBuffer({ size, usage });
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
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  );
  const extrema = create(
    extremaBytes,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  );
  const parameterBuffer = create(
    64 * Uint32Array.BYTES_PER_ELEMENT,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  );
  const readback = create(
    readbackBytes,
    GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  );
  const buffers = [raw, scaled, candidates, extrema, parameterBuffer, readback];

  try {
    const parameters = createPreprocessingParameters(info);
    const scale = new Float32Array(parameters.buffer, 12 * 4, 4);
    const firstColor = normalizedCfa(info.cfaPattern[0]);
    const initialExtrema = new Uint32Array(6);
    initialExtrema[firstColor] = scaleSample(
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
      const pipeline = runtime.pipelines[entryPoint];
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
    if (readback.mapState === "mapped") readback.unmap();
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

function copyCapturedOutput(
  pixels: Uint16Array,
  capture: Uint16Array | undefined,
): void {
  if (!capture) return;
  if (capture.length !== pixels.length) {
    throw new Error(
      `AAHD capture has ${capture.length} samples; expected ${pixels.length}.`,
    );
  }
  capture.set(pixels);
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
}

async function getRuntime(requiredBufferBytes: number): Promise<Runtime> {
  if (runtimePromise) {
    await getWebGpuRuntime(requiredBufferBytes);
    return runtimePromise;
  }
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
  const gamma = createLibRawGammaLut();
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
    create(
      packedBytes,
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
      GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
    ),
    create(
      Math.ceil(mosaicBytes / 4) * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    ),
    create(
      Uint32Array.BYTES_PER_ELEMENT,
      GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
    ),
  ];
  device.queue.writeBuffer(resources[9], 0, gamma);
  cachedWorkspace = {
    width: info.width,
    height: info.height,
    paddedWidth,
    paddedHeight,
    packedBytes,
    coreWidth: info.width,
    coreHeight: info.height,
    resources,
    readback: create(
      packedBytes,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    ),
  };
  return cachedWorkspace;
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
  if (cachedTiledWorkspace) destroyWorkspace(cachedTiledWorkspace);
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
  const create = (size: number, usage: GPUBufferUsageFlags) =>
    device.createBuffer({ size: Math.ceil(size / 4) * 4, usage });
  const gamma = createLibRawGammaLut();
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
    create(gamma.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
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
    create(originalTileBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
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
  cachedTiledWorkspace = {
    width,
    height,
    paddedWidth,
    paddedHeight,
    packedBytes: outputBytes,
    coreWidth: Math.min(info.width, AAHD_TILE_CORE_SIZE),
    coreHeight: Math.min(info.height, AAHD_TILE_CORE_SIZE),
    resources,
    readback: create(
      outputBytes,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    ),
    outputReadbacks: [
      create(outputBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
      create(outputBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
    ],
  };
  return cachedTiledWorkspace;
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

async function finishRgbReadback(
  pending: PendingRgbReadback,
): Promise<Uint16Array<ArrayBuffer>> {
  await pending.ready;
  try {
    const source = new Uint16Array(
      pending.buffer.getMappedRange(0, pending.bytes),
    );
    return new Uint16Array(source);
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
  submitPass(
    runtime,
    workspace,
    "collect_highlights",
    false,
    false,
    undefined,
    core,
  );

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
  submitPass(runtime, workspace, "apply_highlights", false, false, recordCount);
  return serialMs;
}

function submitPass(
  runtime: Runtime,
  workspace: Workspace,
  entryPoint: EntryPoint,
  padded = false,
  paired = false,
  linearWorkgroups?: number,
  core = false,
): void {
  submitPasses(runtime, workspace, [
    { entryPoint, padded, paired, linearWorkgroups, core },
  ]);
}

function submitPasses(
  runtime: Runtime,
  workspace: Workspace,
  commands: readonly PassCommand[],
): void {
  const encoder = runtime.device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  for (const command of commands) {
    const pipeline = runtime.pipelines[command.entryPoint];
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      runtime.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: BINDINGS[command.entryPoint].map((binding) => ({
          binding,
          resource: { buffer: workspace.resources[binding] },
        })),
      }),
    );
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
  reference?: AahdReferenceInfo,
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
  const { scale, pre } = reference
    ? { scale: reference.scaleMultipliers, pre: reference.preMultipliers }
    : calculateScale(info);
  floats.set(scale, 12);
  floats.set(pre, 16);
  floats.set(reference?.yuvMatrix ?? info.aahdYuvMatrix, 20);
  floats.set(reference?.outputMatrix ?? info.librawProPhotoMatrix, 32);
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
  floats.set(calculateScale(info).scale, 12);
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
  const sensorRange = info.aahdScaleRange;
  for (let channel = 0; channel < 4; channel += 1) {
    pre[channel] = Math.fround(camera[channel] / maximum);
    scale[channel] = Math.fround(
      Math.fround(Math.fround(pre[channel] * 65535) / sensorRange),
    );
  }
  return { scale, pre };
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
  const maximumPixel = Math.floor(maximumDifferenceIndex / 3) * 3;
  return {
    sampleCount: actual.length,
    differingSamples,
    samplesOverOneCode,
    samplesOverEightCodes,
    maximumDifference,
    maximumDifferenceIndex,
    actualAtMaximumDifference: actual[maximumDifferenceIndex],
    expectedAtMaximumDifference: expected[maximumDifferenceIndex],
    actualPixelAtMaximumDifference: Array.from(
      actual.subarray(maximumPixel, maximumPixel + 3),
    ),
    expectedPixelAtMaximumDifference: Array.from(
      expected.subarray(maximumPixel, maximumPixel + 3),
    ),
    meanAbsoluteDifference: differenceSum / actual.length,
    rootMeanSquareDifference,
    psnrDb:
      rootMeanSquareDifference === 0
        ? Number.POSITIVE_INFINITY
        : 20 * Math.log10(65535 / rootMeanSquareDifference),
  };
}

function compareExpandedScalar(
  actual: Uint16Array,
  expected: Uint32Array,
): LibRawAahdValidation {
  if (actual.length !== expected.length * 3) {
    throw new Error(
      `The scalar reference has ${expected.length} pixels; expected ${actual.length / 3}.`,
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
    const difference = Math.abs(
      actual[index] - expected[Math.floor(index / 3)],
    );
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
    expectedAtMaximumDifference:
      expected[Math.floor(maximumDifferenceIndex / 3)],
    meanAbsoluteDifference: differenceSum / actual.length,
    rootMeanSquareDifference,
    psnrDb:
      rootMeanSquareDifference === 0
        ? Number.POSITIVE_INFINITY
        : 20 * Math.log10(65535 / rootMeanSquareDifference),
  };
}
