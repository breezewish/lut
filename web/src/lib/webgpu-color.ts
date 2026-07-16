import shader from "./color-transform.wgsl?raw";

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
    private readonly device: GPUDevice,
    private readonly pipeline: GPUComputePipeline,
    private readonly lutBuffer: GPUBuffer,
    private readonly lutSize: number,
    private readonly domainMin: Float32Array,
    private readonly inverseDomainRange: Float32Array,
  ) {}

  static async create(lut: GpuLut): Promise<WebGpuColorRenderer> {
    if (!("gpu" in navigator)) {
      throw new Error("WebGPU is unavailable in this browser.");
    }
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) throw new Error("No WebGPU adapter is available.");
    const device = await adapter.requestDevice();
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
    const lutBuffer = device.createBuffer({
      size: samples.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(lutBuffer, 0, samples);
    const domainMin = lut.domain_min();
    const domainMax = lut.domain_max();
    const inverseDomainRange = domainMin.map(
      (minimum, axis) => 1 / (domainMax[axis] - minimum),
    );
    return new WebGpuColorRenderer(
      device,
      pipeline,
      lutBuffer,
      lut.size(),
      domainMin,
      inverseDomainRange,
    );
  }

  async renderStrip(source: Uint16Array, ev: number): Promise<WebGpuStrip> {
    if (source.length % 3 !== 0) {
      throw new Error("WebGPU color input must contain complete RGB pixels.");
    }
    const pixelCount = source.length / 3;
    const pairCount = Math.ceil(pixelCount / 2);
    const packedBytes = pairCount * 3 * Uint32Array.BYTES_PER_ELEMENT;
    const sourceBuffer = this.device.createBuffer({
      size: packedBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const destinationBuffer = this.device.createBuffer({
      size: packedBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readbackBuffer = this.device.createBuffer({
      size: packedBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const uniformBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const parameters = new ArrayBuffer(48);
    const view = new DataView(parameters);
    view.setFloat32(0, 2 ** ev, true);
    view.setUint32(4, this.lutSize, true);
    view.setUint32(8, pixelCount, true);
    for (let axis = 0; axis < 3; axis += 1) {
      view.setFloat32(16 + axis * 4, this.domainMin[axis], true);
      view.setFloat32(32 + axis * 4, this.inverseDomainRange[axis], true);
    }

    try {
      const uploadStartedAt = performance.now();
      if (source.byteLength === packedBytes) {
        this.device.queue.writeBuffer(
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
        this.device.queue.writeBuffer(sourceBuffer, 0, padded);
      }
      this.device.queue.writeBuffer(uniformBuffer, 0, parameters);
      const uploadMs = performance.now() - uploadStartedAt;
      const bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: sourceBuffer } },
          { binding: 1, resource: { buffer: this.lutBuffer } },
          { binding: 2, resource: { buffer: destinationBuffer } },
          { binding: 3, resource: { buffer: uniformBuffer } },
        ],
      });
      const commands = this.device.createCommandEncoder();
      const pass = commands.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(pairCount / 128));
      pass.end();
      commands.copyBufferToBuffer(
        destinationBuffer,
        0,
        readbackBuffer,
        0,
        packedBytes,
      );
      const executionStartedAt = performance.now();
      this.device.queue.submit([commands.finish()]);
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
      sourceBuffer.destroy();
      destinationBuffer.destroy();
      readbackBuffer.destroy();
      uniformBuffer.destroy();
    }
  }

  destroy(): void {
    this.lutBuffer.destroy();
    this.device.destroy();
  }
}
