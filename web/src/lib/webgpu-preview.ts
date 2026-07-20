import shader from "./preview-transform.wgsl?raw";
import autoExposureShader from "./auto-exposure.wgsl?raw";
import {
  AUTO_EXPOSURE_HISTOGRAM_BINS,
  AUTO_EXPOSURE_ZONE_COUNT,
  resolveMatrixAutoExposure,
} from "./auto-exposure";
import type { GpuLut } from "./webgpu-color";
import {
  createCheckedComputePipeline,
  getWebGpuRuntime,
  type WebGpuRuntime,
  writePaddedBuffer,
} from "./webgpu-runtime";

export interface WebGpuPreview {
  width: number;
  height: number;
  base?: Uint8Array<ArrayBuffer>;
  lut: Uint8Array<ArrayBuffer>;
  executionAndReadbackMs: number;
}

let pipelinePromise:
  | Promise<{ runtime: WebGpuRuntime; pipeline: GPUComputePipeline }>
  | undefined;

/** Starts the shared Preview GPU device and shader compilation. */
export function prepareWebGpuPreview(): Promise<{
  runtime: WebGpuRuntime;
  pipeline: GPUComputePipeline;
}> {
  pipelinePromise ??= createPipeline();
  return pipelinePromise;
}

type PreviewSourceState = {
  runtime: WebGpuRuntime;
  buffer: GPUBuffer;
  autoExposure?: Promise<number>;
};

const previewSourceStates = new WeakMap<
  WebGpuPreviewSource,
  PreviewSourceState
>();

/** Owns one display-sized RGB16 photo source on the shared GPU device. */
export class WebGpuPreviewSource {
  private constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  /** Uploads a display-sized RGB16 photo source for later preview renders. */
  static async create(
    pixels: Uint16Array,
    width: number,
    height: number,
  ): Promise<WebGpuPreviewSource> {
    if (pixels.length !== width * height * 3) {
      throw new Error(
        "WebGPU preview source dimensions do not match its pixels.",
      );
    }
    if (!(pixels.buffer instanceof ArrayBuffer)) {
      throw new Error("WebGPU preview source must use non-shared memory.");
    }
    const sourceBytes = align(pixels.byteLength, Uint32Array.BYTES_PER_ELEMENT);
    const { runtime } = await prepareWebGpuPreview();
    await getWebGpuRuntime(sourceBytes);
    runtime.assertAvailable();
    let buffer: GPUBuffer | undefined;
    try {
      buffer = runtime.device.createBuffer({
        size: sourceBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      writePaddedBuffer(runtime.device, buffer, pixels, sourceBytes);
      const source = new WebGpuPreviewSource(width, height);
      previewSourceStates.set(source, { runtime, buffer });
      return source;
    } catch (error) {
      buffer?.destroy();
      throw new Error("WebGPU could not allocate the preview source.", {
        cause: error,
      });
    }
  }

  /** Measures this retained linear source once on WebGPU and caches its base EV. */
  measureAutoExposure(): Promise<number> {
    const state = getPreviewSourceState(this);
    state.autoExposure ??= measureAutoExposure(
      state.runtime,
      state.buffer,
      this.width,
      this.height,
    );
    return state.autoExposure;
  }

  /** Releases this photo's RGB16 GPU source. */
  free(): void {
    const state = previewSourceStates.get(this);
    if (!state) return;
    state.buffer.destroy();
    previewSourceStates.delete(this);
  }
}

type PreviewWorkspace = {
  baseBuffer: GPUBuffer;
  lutOutputBuffer: GPUBuffer;
  baseReadback: GPUBuffer;
  lutReadback: GPUBuffer;
};

/** Renders any retained photo through one shared LUT and output workspace. */
export class WebGpuPreviewRenderer {
  private source: WebGpuPreviewSource;
  private lutBuffer: GPUBuffer;
  private lutSize: number;
  private domainMin: Float32Array;
  private inverseDomainRange: Float32Array;
  private baseBuffer: GPUBuffer;
  private lutOutputBuffer: GPUBuffer;
  private baseReadback: GPUBuffer;
  private lutReadback: GPUBuffer;
  private workspaceBytes: number;
  private bindGroup: GPUBindGroup;
  private readonly parameters = new ArrayBuffer(64);
  private readonly parameterView = new DataView(this.parameters);

  private constructor(
    private readonly runtime: WebGpuRuntime,
    private readonly pipeline: GPUComputePipeline,
    private readonly parameterBuffer: GPUBuffer,
    source: WebGpuPreviewSource,
    workspace: PreviewWorkspace,
    workspaceBytes: number,
    lutBuffer: GPUBuffer,
    lut: GpuLut,
  ) {
    this.source = source;
    this.baseBuffer = workspace.baseBuffer;
    this.lutOutputBuffer = workspace.lutOutputBuffer;
    this.baseReadback = workspace.baseReadback;
    this.lutReadback = workspace.lutReadback;
    this.workspaceBytes = workspaceBytes;
    this.lutBuffer = lutBuffer;
    this.lutSize = lut.size();
    this.domainMin = lut.domain_min();
    this.inverseDomainRange = inverseRange(lut);
    this.bindGroup = this.createBindGroup(
      getPreviewSourceState(source).buffer,
      lutBuffer,
      workspace.baseBuffer,
      workspace.lutOutputBuffer,
    );
  }

  static async create(
    source: WebGpuPreviewSource,
    lut: GpuLut,
  ): Promise<WebGpuPreviewRenderer> {
    const sourceState = getPreviewSourceState(source);
    const outputBytes =
      source.width * source.height * Uint32Array.BYTES_PER_ELEMENT;
    const { runtime, pipeline } = await prepareWebGpuPreview();
    await getWebGpuRuntime(outputBytes);
    runtime.assertAvailable();
    if (sourceState.runtime !== runtime) {
      throw new Error("WebGPU preview source belongs to another device.");
    }
    const { device } = runtime;
    const buffers: GPUBuffer[] = [];
    try {
      const workspace = createWorkspace(device, outputBytes, buffers);
      const parameterBuffer = device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      buffers.push(parameterBuffer);
      const lutBuffer = createLutBuffer(device, lut);
      buffers.push(lutBuffer);
      const renderer = new WebGpuPreviewRenderer(
        runtime,
        pipeline,
        parameterBuffer,
        source,
        workspace,
        outputBytes,
        lutBuffer,
        lut,
      );
      buffers.length = 0;
      return renderer;
    } catch (error) {
      for (const buffer of buffers) buffer.destroy();
      throw new Error("WebGPU could not allocate the preview buffers.", {
        cause: error,
      });
    }
  }

  /** Selects a retained photo, growing the shared output workspace only when needed. */
  setSource(source: WebGpuPreviewSource): void {
    this.runtime.assertAvailable();
    const sourceState = getPreviewSourceState(source);
    if (sourceState.runtime !== this.runtime) {
      throw new Error("WebGPU preview source belongs to another device.");
    }
    if (source === this.source) return;

    const requiredBytes =
      source.width * source.height * Uint32Array.BYTES_PER_ELEMENT;
    if (requiredBytes <= this.workspaceBytes) {
      const bindGroup = this.createBindGroup(
        sourceState.buffer,
        this.lutBuffer,
        this.baseBuffer,
        this.lutOutputBuffer,
      );
      this.source = source;
      this.bindGroup = bindGroup;
      return;
    }

    const buffers: GPUBuffer[] = [];
    try {
      const workspace = createWorkspace(
        this.runtime.device,
        requiredBytes,
        buffers,
      );
      const bindGroup = this.createBindGroup(
        sourceState.buffer,
        this.lutBuffer,
        workspace.baseBuffer,
        workspace.lutOutputBuffer,
      );
      const previous = this.workspace();
      this.source = source;
      this.baseBuffer = workspace.baseBuffer;
      this.lutOutputBuffer = workspace.lutOutputBuffer;
      this.baseReadback = workspace.baseReadback;
      this.lutReadback = workspace.lutReadback;
      this.workspaceBytes = requiredBytes;
      this.bindGroup = bindGroup;
      buffers.length = 0;
      destroyWorkspace(previous);
    } catch (error) {
      for (const buffer of buffers) buffer.destroy();
      throw new Error("WebGPU could not grow the preview workspace.", {
        cause: error,
      });
    }
  }

  /** Replaces the one LUT shared by every retained photo. */
  setLut(lut: GpuLut): void {
    this.runtime.assertAvailable();
    const sourceState = getPreviewSourceState(this.source);
    const next = createLutBuffer(this.runtime.device, lut);
    let bindGroup: GPUBindGroup;
    try {
      bindGroup = this.createBindGroup(
        sourceState.buffer,
        next,
        this.baseBuffer,
        this.lutOutputBuffer,
      );
    } catch (error) {
      next.destroy();
      throw error;
    }
    const previous = this.lutBuffer;
    this.lutBuffer = next;
    this.lutSize = lut.size();
    this.domainMin = lut.domain_min();
    this.inverseDomainRange = inverseRange(lut);
    this.bindGroup = bindGroup;
    previous.destroy();
  }

  async render(
    ev: number,
    maxEdge: number,
    includeBase: boolean,
  ): Promise<WebGpuPreview> {
    this.runtime.assertAvailable();
    const [width, height] = previewDimensions(
      this.source.width,
      this.source.height,
      maxEdge,
    );
    const pixelCount = width * height;
    const outputBytes = pixelCount * Uint32Array.BYTES_PER_ELEMENT;
    this.writeParameters(ev, width, height, pixelCount, includeBase);

    const commands = this.runtime.device.createCommandEncoder();
    const pass = commands.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(pixelCount / 256));
    pass.end();
    if (includeBase) {
      commands.copyBufferToBuffer(
        this.baseBuffer,
        0,
        this.baseReadback,
        0,
        outputBytes,
      );
    }
    commands.copyBufferToBuffer(
      this.lutOutputBuffer,
      0,
      this.lutReadback,
      0,
      outputBytes,
    );

    const startedAt = performance.now();
    this.runtime.device.queue.submit([commands.finish()]);
    const maps = [this.lutReadback.mapAsync(GPUMapMode.READ, 0, outputBytes)];
    if (includeBase) {
      maps.push(this.baseReadback.mapAsync(GPUMapMode.READ, 0, outputBytes));
    }
    await Promise.all(maps);
    const executionAndReadbackMs = performance.now() - startedAt;
    try {
      return {
        width,
        height,
        base: includeBase
          ? copyMappedBytes(this.baseReadback, outputBytes)
          : undefined,
        lut: copyMappedBytes(this.lutReadback, outputBytes),
        executionAndReadbackMs,
      };
    } finally {
      if (includeBase) this.baseReadback.unmap();
      this.lutReadback.unmap();
    }
  }

  free(): void {
    this.lutBuffer.destroy();
    destroyWorkspace(this.workspace());
    this.parameterBuffer.destroy();
  }

  private writeParameters(
    ev: number,
    outputWidth: number,
    outputHeight: number,
    pixelCount: number,
    includeBase: boolean,
  ): void {
    const view = this.parameterView;
    view.setFloat32(0, 2 ** ev, true);
    view.setUint32(4, this.lutSize, true);
    view.setUint32(8, this.source.width, true);
    view.setUint32(12, this.source.height, true);
    view.setUint32(16, outputWidth, true);
    view.setUint32(20, outputHeight, true);
    view.setUint32(24, pixelCount, true);
    view.setUint32(28, Number(includeBase), true);
    for (let axis = 0; axis < 3; axis += 1) {
      view.setFloat32(32 + axis * 4, this.domainMin[axis], true);
      view.setFloat32(48 + axis * 4, this.inverseDomainRange[axis], true);
    }
    this.runtime.device.queue.writeBuffer(
      this.parameterBuffer,
      0,
      this.parameters,
    );
  }

  private createBindGroup(
    sourceBuffer: GPUBuffer,
    lutBuffer: GPUBuffer,
    baseBuffer: GPUBuffer,
    lutOutputBuffer: GPUBuffer,
  ): GPUBindGroup {
    return this.runtime.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: sourceBuffer } },
        { binding: 1, resource: { buffer: lutBuffer } },
        { binding: 2, resource: { buffer: baseBuffer } },
        { binding: 3, resource: { buffer: lutOutputBuffer } },
        { binding: 4, resource: { buffer: this.parameterBuffer } },
      ],
    });
  }

  private workspace(): PreviewWorkspace {
    return {
      baseBuffer: this.baseBuffer,
      lutOutputBuffer: this.lutOutputBuffer,
      baseReadback: this.baseReadback,
      lutReadback: this.lutReadback,
    };
  }
}

function getPreviewSourceState(
  source: WebGpuPreviewSource,
): PreviewSourceState {
  const state = previewSourceStates.get(source);
  if (!state) throw new Error("WebGPU preview source has been released.");
  return state;
}

function createWorkspace(
  device: GPUDevice,
  outputBytes: number,
  allocated: GPUBuffer[],
): PreviewWorkspace {
  const outputUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
  const readbackUsage = GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ;
  const createBuffer = (usage: GPUBufferUsageFlags) => {
    const buffer = device.createBuffer({ size: outputBytes, usage });
    allocated.push(buffer);
    return buffer;
  };
  return {
    baseBuffer: createBuffer(outputUsage),
    lutOutputBuffer: createBuffer(outputUsage),
    baseReadback: createBuffer(readbackUsage),
    lutReadback: createBuffer(readbackUsage),
  };
}

function destroyWorkspace(workspace: PreviewWorkspace): void {
  workspace.baseBuffer.destroy();
  workspace.lutOutputBuffer.destroy();
  workspace.baseReadback.destroy();
  workspace.lutReadback.destroy();
}

function createLutBuffer(device: GPUDevice, lut: GpuLut): GPUBuffer {
  const samples = new Float32Array(lut.samples());
  const buffer = device.createBuffer({
    size: samples.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  try {
    device.queue.writeBuffer(buffer, 0, samples);
    return buffer;
  } catch (error) {
    buffer.destroy();
    throw error;
  }
}

async function createPipeline(): Promise<{
  runtime: WebGpuRuntime;
  pipeline: GPUComputePipeline;
}> {
  const runtime = await getWebGpuRuntime();
  const pipeline = await createCheckedComputePipeline(
    runtime.device,
    shader,
    "WebGPU preview shader",
  );
  return { runtime, pipeline };
}

const AUTO_EXPOSURE_STATISTIC_COUNT =
  AUTO_EXPOSURE_ZONE_COUNT * 2 + AUTO_EXPOSURE_HISTOGRAM_BINS;
let autoExposurePipelinePromise: Promise<GPUComputePipeline> | undefined;

async function measureAutoExposure(
  runtime: WebGpuRuntime,
  source: GPUBuffer,
  width: number,
  height: number,
): Promise<number> {
  runtime.assertAvailable();
  autoExposurePipelinePromise ??= createCheckedComputePipeline(
    runtime.device,
    autoExposureShader,
    "WebGPU automatic exposure shader",
  );
  const pipeline = await autoExposurePipelinePromise;
  const statisticsBytes =
    AUTO_EXPOSURE_STATISTIC_COUNT * Uint32Array.BYTES_PER_ELEMENT;
  const buffers: GPUBuffer[] = [];
  try {
    const statistics = runtime.device.createBuffer({
      size: statisticsBytes,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
    });
    buffers.push(statistics);
    const parameters = runtime.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    buffers.push(parameters);
    const readback = runtime.device.createBuffer({
      size: statisticsBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    buffers.push(readback);
    runtime.device.queue.writeBuffer(
      parameters,
      0,
      new Uint32Array([width, height, width * height, 0]),
    );
    const bindGroup = runtime.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: source } },
        { binding: 1, resource: { buffer: statistics } },
        { binding: 2, resource: { buffer: parameters } },
      ],
    });
    const commands = runtime.device.createCommandEncoder();
    commands.clearBuffer(statistics);
    const pass = commands.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil((width * height) / 256));
    pass.end();
    commands.copyBufferToBuffer(statistics, 0, readback, 0, statisticsBytes);
    runtime.device.queue.submit([commands.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    try {
      const values = new Uint32Array(readback.getMappedRange());
      return resolveMatrixAutoExposure({
        zoneLuminanceSums: values.subarray(0, AUTO_EXPOSURE_ZONE_COUNT),
        zoneCounts: values.subarray(
          AUTO_EXPOSURE_ZONE_COUNT,
          AUTO_EXPOSURE_ZONE_COUNT * 2,
        ),
        histogram: values.subarray(AUTO_EXPOSURE_ZONE_COUNT * 2),
      }).ev;
    } finally {
      readback.unmap();
    }
  } finally {
    for (const buffer of buffers) buffer.destroy();
  }
}

function previewDimensions(
  width: number,
  height: number,
  maxEdge: number,
): [number, number] {
  if (!Number.isInteger(maxEdge) || maxEdge <= 0) {
    throw new Error("Preview longest edge must be positive.");
  }
  const scale = Math.min(maxEdge / Math.max(width, height), 1);
  return [
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  ];
}

function inverseRange(lut: GpuLut): Float32Array {
  const minimum = lut.domain_min();
  const maximum = lut.domain_max();
  return minimum.map((value, axis) => 1 / (maximum[axis] - value));
}

function copyMappedBytes(
  buffer: GPUBuffer,
  byteLength: number,
): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(byteLength);
  copy.set(new Uint8Array(buffer.getMappedRange(0, byteLength)));
  return copy;
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
