import shader from "./preview-transform.wgsl?raw";
import type { GpuLut } from "./webgpu-color";
import { getWebGpuRuntime, type WebGpuRuntime } from "./webgpu-runtime";

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

/** Keeps one display-sized RGB16 source and its current LUT on the GPU. */
export class WebGpuPreviewRenderer {
  private lutBuffer: GPUBuffer;
  private lutSize: number;
  private domainMin: Float32Array;
  private inverseDomainRange: Float32Array;

  private constructor(
    private readonly runtime: WebGpuRuntime,
    private readonly pipeline: GPUComputePipeline,
    private readonly sourceBuffer: GPUBuffer,
    private readonly baseBuffer: GPUBuffer,
    private readonly lutOutputBuffer: GPUBuffer,
    private readonly baseReadback: GPUBuffer,
    private readonly lutReadback: GPUBuffer,
    private readonly parameterBuffer: GPUBuffer,
    private readonly width: number,
    private readonly height: number,
    lut: GpuLut,
  ) {
    this.lutBuffer = this.createLutBuffer(lut);
    this.lutSize = lut.size();
    this.domainMin = lut.domain_min();
    this.inverseDomainRange = inverseRange(lut);
  }

  static async create(
    source: Uint16Array,
    width: number,
    height: number,
    lut: GpuLut,
  ): Promise<WebGpuPreviewRenderer> {
    if (source.length !== width * height * 3) {
      throw new Error(
        "WebGPU preview source dimensions do not match its pixels.",
      );
    }
    if (!(source.buffer instanceof ArrayBuffer)) {
      throw new Error("WebGPU preview source must use non-shared memory.");
    }
    const outputBytes = width * height * Uint32Array.BYTES_PER_ELEMENT;
    const sourceBytes = align(source.byteLength, Uint32Array.BYTES_PER_ELEMENT);
    const { runtime, pipeline } = await prepareWebGpuPreview();
    await getWebGpuRuntime(Math.max(sourceBytes, outputBytes));
    runtime.assertAvailable();
    const { device } = runtime;
    const outputUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
    const readbackUsage = GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ;
    const buffers: GPUBuffer[] = [];
    const createBuffer = (descriptor: GPUBufferDescriptor) => {
      const buffer = device.createBuffer(descriptor);
      buffers.push(buffer);
      return buffer;
    };
    try {
      const sourceBuffer = createBuffer({
        size: sourceBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      if (sourceBytes === source.byteLength) {
        device.queue.writeBuffer(
          sourceBuffer,
          0,
          source.buffer,
          source.byteOffset,
          source.byteLength,
        );
      } else {
        const padded = new Uint8Array(sourceBytes);
        padded.set(
          new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
        );
        device.queue.writeBuffer(sourceBuffer, 0, padded);
      }
      const renderer = new WebGpuPreviewRenderer(
        runtime,
        pipeline,
        sourceBuffer,
        createBuffer({ size: outputBytes, usage: outputUsage }),
        createBuffer({ size: outputBytes, usage: outputUsage }),
        createBuffer({ size: outputBytes, usage: readbackUsage }),
        createBuffer({ size: outputBytes, usage: readbackUsage }),
        createBuffer({
          size: 64,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        width,
        height,
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

  setLut(lut: GpuLut): void {
    this.runtime.assertAvailable();
    const previous = this.lutBuffer;
    this.lutBuffer = this.createLutBuffer(lut);
    this.lutSize = lut.size();
    this.domainMin = lut.domain_min();
    this.inverseDomainRange = inverseRange(lut);
    previous.destroy();
  }

  async render(
    ev: number,
    maxEdge: number,
    includeBase: boolean,
  ): Promise<WebGpuPreview> {
    this.runtime.assertAvailable();
    const [width, height] = previewDimensions(this.width, this.height, maxEdge);
    const pixelCount = width * height;
    const outputBytes = pixelCount * Uint32Array.BYTES_PER_ELEMENT;
    this.writeParameters(ev, width, height, pixelCount, includeBase);

    const commands = this.runtime.device.createCommandEncoder();
    const bindGroup = this.runtime.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.sourceBuffer } },
        { binding: 1, resource: { buffer: this.lutBuffer } },
        { binding: 2, resource: { buffer: this.baseBuffer } },
        { binding: 3, resource: { buffer: this.lutOutputBuffer } },
        { binding: 4, resource: { buffer: this.parameterBuffer } },
      ],
    });
    const pass = commands.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
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
    this.sourceBuffer.destroy();
    this.lutBuffer.destroy();
    this.baseBuffer.destroy();
    this.lutOutputBuffer.destroy();
    this.baseReadback.destroy();
    this.lutReadback.destroy();
    this.parameterBuffer.destroy();
  }

  private createLutBuffer(lut: GpuLut): GPUBuffer {
    const samples = new Float32Array(lut.samples());
    const buffer = this.runtime.device.createBuffer({
      size: samples.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    try {
      this.runtime.device.queue.writeBuffer(buffer, 0, samples);
      return buffer;
    } catch (error) {
      buffer.destroy();
      throw error;
    }
  }

  private writeParameters(
    ev: number,
    outputWidth: number,
    outputHeight: number,
    pixelCount: number,
    includeBase: boolean,
  ): void {
    const parameters = new ArrayBuffer(64);
    const view = new DataView(parameters);
    view.setFloat32(0, 2 ** ev, true);
    view.setUint32(4, this.lutSize, true);
    view.setUint32(8, this.width, true);
    view.setUint32(12, this.height, true);
    view.setUint32(16, outputWidth, true);
    view.setUint32(20, outputHeight, true);
    view.setUint32(24, pixelCount, true);
    view.setUint32(28, Number(includeBase), true);
    for (let axis = 0; axis < 3; axis += 1) {
      view.setFloat32(32 + axis * 4, this.domainMin[axis], true);
      view.setFloat32(48 + axis * 4, this.inverseDomainRange[axis], true);
    }
    this.runtime.device.queue.writeBuffer(this.parameterBuffer, 0, parameters);
  }
}

async function createPipeline(): Promise<{
  runtime: WebGpuRuntime;
  pipeline: GPUComputePipeline;
}> {
  const runtime = await getWebGpuRuntime();
  const module = runtime.device.createShaderModule({ code: shader });
  const compilation = await module.getCompilationInfo();
  const errors = compilation.messages.filter(
    (message) => message.type === "error",
  );
  if (errors.length > 0) {
    throw new Error(
      `WebGPU preview shader failed to compile: ${errors.map(({ message }) => message).join("; ")}`,
    );
  }
  const pipeline = await runtime.device.createComputePipelineAsync({
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });
  return { runtime, pipeline };
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
