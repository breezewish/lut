import shader from "./color-transform.wgsl?raw";
import { getWebGpuRuntime, type WebGpuRuntime } from "./webgpu-runtime";

export interface GpuLut {
  size(): number;
  domain_min(): Float32Array;
  domain_max(): Float32Array;
  samples(): Float32Array;
}

export interface GpuStripTimings {
  inputPreparationMs: number;
  executionAndReadbackMs: number;
  outputPreparationMs: number;
}

export interface WebGpuStrip {
  pixels: Uint16Array<ArrayBuffer>;
  timings: GpuStripTimings;
}

/** Persistent WebGPU resources for the current parsed LUT. */
export class WebGpuColorRenderer {
  private constructor(
    private readonly runtime: WebGpuRuntime,
    private readonly pipeline: GPUComputePipeline,
    private readonly lutBuffer: GPUBuffer,
    private readonly parameterBuffer: GPUBuffer,
    private readonly lutSize: number,
    private readonly domainMin: Float32Array,
    private readonly inverseDomainRange: Float32Array,
  ) {}

  static async create(
    lut: GpuLut,
    runtime?: WebGpuRuntime,
  ): Promise<WebGpuColorRenderer> {
    const sharedRuntime = runtime ?? (await getWebGpuRuntime());
    sharedRuntime.assertAvailable();
    const { device } = sharedRuntime;
    const module = device.createShaderModule({ code: shader });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter(
      (message) => message.type === "error",
    );
    if (errors.length > 0) {
      throw new Error(
        `WebGPU color shader failed to compile: ${errors.map((error) => error.message).join("; ")}`,
      );
    }
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    const samples = new Float32Array(lut.samples());
    const buffers: GPUBuffer[] = [];
    try {
      const lutBuffer = device.createBuffer({
        size: samples.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      buffers.push(lutBuffer);
      device.queue.writeBuffer(lutBuffer, 0, samples);
      const parameterBuffer = device.createBuffer({
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      buffers.push(parameterBuffer);
      const domainMin = lut.domain_min();
      const domainMax = lut.domain_max();
      const inverseDomainRange = domainMin.map(
        (minimum, axis) => 1 / (domainMax[axis] - minimum),
      );
      const renderer = new WebGpuColorRenderer(
        sharedRuntime,
        pipeline,
        lutBuffer,
        parameterBuffer,
        lut.size(),
        domainMin,
        inverseDomainRange,
      );
      buffers.length = 0;
      return renderer;
    } catch (error) {
      for (const buffer of buffers) buffer.destroy();
      throw new Error("WebGPU could not allocate the export color buffers.", {
        cause: error,
      });
    }
  }

  async renderStrip(source: Uint16Array, ev: number): Promise<WebGpuStrip> {
    this.runtime.assertAvailable();
    if (source.length % 3 !== 0) {
      throw new Error("WebGPU color input must contain complete RGB pixels.");
    }
    const pixelCount = source.length / 3;
    const pairCount = Math.ceil(pixelCount / 2);
    const packedBytes = pairCount * 3 * Uint32Array.BYTES_PER_ELEMENT;
    const buffers: GPUBuffer[] = [];
    let readbackBuffer: GPUBuffer | undefined;
    try {
      const sourceBuffer = this.runtime.device.createBuffer({
        size: packedBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      buffers.push(sourceBuffer);
      const destinationBuffer = this.runtime.device.createBuffer({
        size: packedBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      buffers.push(destinationBuffer);
      readbackBuffer = this.runtime.device.createBuffer({
        size: packedBytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      buffers.push(readbackBuffer);
      const uploadStartedAt = performance.now();
      if (source.byteLength === packedBytes) {
        this.runtime.device.queue.writeBuffer(
          sourceBuffer,
          0,
          source.buffer,
          source.byteOffset,
          source.byteLength,
        );
      } else {
        const padded = new Uint8Array(packedBytes);
        padded.set(
          new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
        );
        this.runtime.device.queue.writeBuffer(sourceBuffer, 0, padded);
      }
      this.writeParameters(pixelCount, ev);
      const uploadMs = performance.now() - uploadStartedAt;
      const commands = this.runtime.device.createCommandEncoder();
      this.encode(commands, sourceBuffer, destinationBuffer, pixelCount);
      commands.copyBufferToBuffer(
        destinationBuffer,
        0,
        readbackBuffer,
        0,
        packedBytes,
      );
      const executionStartedAt = performance.now();
      this.runtime.device.queue.submit([commands.finish()]);
      await readbackBuffer.mapAsync(GPUMapMode.READ);
      const executionAndReadbackMs = performance.now() - executionStartedAt;
      const outputStartedAt = performance.now();
      const mapped = readbackBuffer.getMappedRange();
      const bytes = new Uint8Array(source.byteLength);
      bytes.set(new Uint8Array(mapped, 0, source.byteLength));
      const outputPreparationMs = performance.now() - outputStartedAt;
      return {
        pixels: new Uint16Array(bytes.buffer),
        timings: {
          inputPreparationMs: uploadMs,
          executionAndReadbackMs,
          outputPreparationMs,
        },
      };
    } finally {
      if (readbackBuffer?.mapState === "mapped") readbackBuffer.unmap();
      for (const buffer of buffers) buffer.destroy();
    }
  }

  /** Encodes color and LUT processing between buffers on the shared device. */
  renderBuffer(
    source: GPUBuffer,
    destination: GPUBuffer,
    pixelCount: number,
    ev: number,
  ): void {
    this.runtime.assertAvailable();
    if (!Number.isInteger(pixelCount) || pixelCount <= 0) {
      throw new Error("WebGPU color requires a positive pixel count.");
    }
    this.writeParameters(pixelCount, ev);
    const commands = this.runtime.device.createCommandEncoder();
    this.encode(commands, source, destination, pixelCount);
    this.runtime.device.queue.submit([commands.finish()]);
  }

  private writeParameters(pixelCount: number, ev: number): void {
    const parameters = new ArrayBuffer(48);
    const view = new DataView(parameters);
    view.setFloat32(0, 2 ** ev, true);
    view.setUint32(4, this.lutSize, true);
    view.setUint32(8, pixelCount, true);
    for (let axis = 0; axis < 3; axis += 1) {
      view.setFloat32(16 + axis * 4, this.domainMin[axis], true);
      view.setFloat32(32 + axis * 4, this.inverseDomainRange[axis], true);
    }
    this.runtime.device.queue.writeBuffer(this.parameterBuffer, 0, parameters);
  }

  private encode(
    commands: GPUCommandEncoder,
    source: GPUBuffer,
    destination: GPUBuffer,
    pixelCount: number,
  ): void {
    const bindGroup = this.runtime.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: source } },
        { binding: 1, resource: { buffer: this.lutBuffer } },
        { binding: 2, resource: { buffer: destination } },
        { binding: 3, resource: { buffer: this.parameterBuffer } },
      ],
    });
    const pass = commands.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(Math.ceil(pixelCount / 2) / 128));
    pass.end();
  }

  destroy(): void {
    this.lutBuffer.destroy();
    this.parameterBuffer.destroy();
  }
}
