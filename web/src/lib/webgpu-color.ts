import shader from "./color-transform.wgsl?raw";
import {
  acquirePreparedGpuLut,
  type GpuLut,
  type PreparedGpuLutLease,
} from "./webgpu-lut";
import {
  createCheckedComputePipeline,
  getWebGpuRuntime,
  type WebGpuRuntime,
  writePaddedBuffer,
} from "./webgpu-runtime";
import { writeWhiteBalanceUniform } from "./white-balance";

export type { GpuLut } from "./webgpu-lut";

export interface GpuStripTimings {
  inputPreparationMs: number;
  executionAndReadbackMs: number;
  outputPreparationMs: number;
}

export interface WebGpuStrip {
  pixels: Uint16Array<ArrayBuffer>;
  timings: GpuStripTimings;
}

export interface WebGpuColorRecipe {
  renderer: WebGpuColorRenderer;
  ev: number;
  whiteBalance: Float32Array;
}

const pipelinePromises = new WeakMap<GPUDevice, Promise<GPUComputePipeline>>();

/** Persistent WebGPU resources for the current parsed LUT. */
export class WebGpuColorRenderer {
  readonly preferredBatchSamples = 4_000_000;
  private readonly parameters = new ArrayBuffer(96);
  private readonly parameterView = new DataView(this.parameters);
  private sourceBuffer?: GPUBuffer;
  private destinationBuffer?: GPUBuffer;
  private readbackBuffer?: GPUBuffer;
  private workspaceBytes = 0;

  private constructor(
    private readonly runtime: WebGpuRuntime,
    private readonly pipeline: GPUComputePipeline,
    private readonly lutLease: PreparedGpuLutLease,
    private readonly parameterBuffer: GPUBuffer,
  ) {
    const lut = lutLease.prepared;
    this.parameterView.setUint32(4, lut.size, true);
    for (let axis = 0; axis < 3; axis += 1) {
      this.parameterView.setFloat32(16 + axis * 4, lut.domainMin[axis], true);
      this.parameterView.setFloat32(
        32 + axis * 4,
        lut.inverseDomainRange[axis],
        true,
      );
    }
  }

  static async create(
    lut: GpuLut,
    runtime?: WebGpuRuntime,
  ): Promise<WebGpuColorRenderer> {
    const sharedRuntime = runtime ?? (await getWebGpuRuntime());
    sharedRuntime.assertAvailable();
    const { device } = sharedRuntime;
    let pipelinePromise = pipelinePromises.get(device);
    if (!pipelinePromise) {
      pipelinePromise = createCheckedComputePipeline(
        device,
        shader,
        "WebGPU color shader",
      );
      pipelinePromises.set(device, pipelinePromise);
    }
    const pipeline = await pipelinePromise;
    const buffers: GPUBuffer[] = [];
    let lutLease: PreparedGpuLutLease | undefined;
    try {
      lutLease = acquirePreparedGpuLut(device, lut);
      const parameterBuffer = device.createBuffer({
        size: 96,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      buffers.push(parameterBuffer);
      const renderer = new WebGpuColorRenderer(
        sharedRuntime,
        pipeline,
        lutLease,
        parameterBuffer,
      );
      lutLease = undefined;
      buffers.length = 0;
      return renderer;
    } catch (error) {
      lutLease?.release();
      for (const buffer of buffers) buffer.destroy();
      throw new Error("WebGPU could not allocate the export color buffers.", {
        cause: error,
      });
    }
  }

  async renderStrip(
    source: Uint16Array,
    ev: number,
    whiteBalance: Float32Array,
  ): Promise<WebGpuStrip> {
    this.runtime.assertAvailable();
    if (source.length % 3 !== 0) {
      throw new Error("WebGPU color input must contain complete RGB pixels.");
    }
    const pixelCount = source.length / 3;
    const pairCount = Math.ceil(pixelCount / 2);
    const packedBytes = pairCount * 3 * Uint32Array.BYTES_PER_ELEMENT;
    const { sourceBuffer, destinationBuffer, readbackBuffer } =
      this.ensureWorkspace(packedBytes);
    try {
      const uploadStartedAt = performance.now();
      writePaddedBuffer(this.runtime.device, sourceBuffer, source, packedBytes);
      this.writeParameters(pixelCount, ev, whiteBalance);
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
      if (readbackBuffer.mapState === "mapped") readbackBuffer.unmap();
    }
  }

  /** Encodes color and LUT processing between buffers on the shared device. */
  renderBuffer(
    source: GPUBuffer,
    destination: GPUBuffer,
    pixelCount: number,
    ev: number,
    whiteBalance: Float32Array,
  ): void {
    this.runtime.assertAvailable();
    if (!Number.isInteger(pixelCount) || pixelCount <= 0) {
      throw new Error("WebGPU color requires a positive pixel count.");
    }
    this.writeParameters(pixelCount, ev, whiteBalance);
    const commands = this.runtime.device.createCommandEncoder();
    this.encode(commands, source, destination, pixelCount);
    this.runtime.device.queue.submit([commands.finish()]);
  }

  private writeParameters(
    pixelCount: number,
    ev: number,
    whiteBalance: Float32Array,
  ): void {
    this.parameterView.setFloat32(0, 2 ** ev, true);
    this.parameterView.setUint32(8, pixelCount, true);
    writeWhiteBalanceUniform(this.parameterView, 48, whiteBalance);
    this.runtime.device.queue.writeBuffer(
      this.parameterBuffer,
      0,
      this.parameters,
    );
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
        { binding: 1, resource: { buffer: this.lutLease.prepared.buffer } },
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

  private ensureWorkspace(size: number): {
    sourceBuffer: GPUBuffer;
    destinationBuffer: GPUBuffer;
    readbackBuffer: GPUBuffer;
  } {
    if (
      size > this.workspaceBytes ||
      !this.sourceBuffer ||
      !this.destinationBuffer ||
      !this.readbackBuffer
    ) {
      this.sourceBuffer?.destroy();
      this.destinationBuffer?.destroy();
      this.readbackBuffer?.destroy();
      this.sourceBuffer = undefined;
      this.destinationBuffer = undefined;
      this.readbackBuffer = undefined;
      const created: GPUBuffer[] = [];
      try {
        const sourceBuffer = this.runtime.device.createBuffer({
          size,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        created.push(sourceBuffer);
        const destinationBuffer = this.runtime.device.createBuffer({
          size,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        created.push(destinationBuffer);
        const readbackBuffer = this.runtime.device.createBuffer({
          size,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        created.push(readbackBuffer);
        this.sourceBuffer = sourceBuffer;
        this.destinationBuffer = destinationBuffer;
        this.readbackBuffer = readbackBuffer;
      } catch (error) {
        for (const buffer of created) buffer.destroy();
        this.workspaceBytes = 0;
        throw error;
      }
      this.workspaceBytes = size;
    }
    return {
      sourceBuffer: this.sourceBuffer,
      destinationBuffer: this.destinationBuffer,
      readbackBuffer: this.readbackBuffer,
    };
  }

  destroy(): void {
    this.lutLease.release();
    this.parameterBuffer.destroy();
    this.sourceBuffer?.destroy();
    this.destinationBuffer?.destroy();
    this.readbackBuffer?.destroy();
  }
}
