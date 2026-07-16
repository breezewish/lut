import * as ort from "onnxruntime-web/webgpu";

import modelUrl from "./color-transform.onnx?url";
import type { GpuLut, GpuStripTimings } from "./webgpu-color";

/** Runs the complete export color recipe as a portable ONNX graph on WebGPU. */
export class OnnxColorRenderer {
  /** Bounds Float32 input, output, and intermediate tensors while reducing dispatches. */
  readonly preferredBatchSamples = 4_000_000;

  private constructor(
    private readonly session: ort.InferenceSession,
    private readonly lut: ort.Tensor,
    private readonly exposure: ort.Tensor,
    private readonly lutSize: ort.Tensor,
    private readonly domainMin: ort.Tensor,
    private readonly inverseDomainRange: ort.Tensor,
  ) {}

  static async create(
    lut: GpuLut,
    ev: number,
    diagnose: boolean,
  ): Promise<OnnxColorRenderer> {
    if (!("gpu" in navigator)) {
      throw new Error("WebGPU is unavailable in this browser.");
    }
    ort.env.webgpu.powerPreference = "high-performance";
    ort.env.logLevel = diagnose ? "verbose" : "warning";

    const size = lut.size();
    const samples = new Float32Array(lut.samples());
    const domainMin = new Float32Array(lut.domain_min());
    const domainMax = lut.domain_max();
    const inverseDomainRange = domainMin.map(
      (minimum, axis) => 1 / (domainMax[axis] - minimum),
    );
    const session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ["webgpu"],
    });
    return new OnnxColorRenderer(
      session,
      new ort.Tensor("float32", samples, [size * size * size, 3]),
      new ort.Tensor("float32", new Float32Array([2 ** ev]), []),
      new ort.Tensor("int32", new Int32Array([size]), []),
      new ort.Tensor("float32", domainMin, [3]),
      new ort.Tensor("float32", inverseDomainRange, [3]),
    );
  }

  async renderStrip(source: Uint16Array): Promise<{
    pixels: Uint16Array<ArrayBuffer>;
    timings: GpuStripTimings;
  }> {
    if (source.length % 3 !== 0) {
      throw new Error("ONNX color input must contain complete RGB pixels.");
    }
    const inputStartedAt = performance.now();
    const floatSource = new Float32Array(source.length);
    for (let index = 0; index < source.length; index += 1) {
      floatSource[index] = source[index];
    }
    const sourceTensor = new ort.Tensor("float32", floatSource, [
      source.length / 3,
      3,
    ]);
    const inputPreparationMs = performance.now() - inputStartedAt;
    let output: ort.Tensor | undefined;
    try {
      const executionStartedAt = performance.now();
      ({ rgb16: output } = await this.session.run({
        source: sourceTensor,
        lut: this.lut,
        exposure: this.exposure,
        lut_size: this.lutSize,
        domain_min: this.domainMin,
        inverse_domain_range: this.inverseDomainRange,
      }));
      const executionAndReadbackMs = performance.now() - executionStartedAt;
      if (!(output.data instanceof Float32Array)) {
        throw new Error(
          `ONNX color output has unexpected type ${output.type}.`,
        );
      }
      const outputStartedAt = performance.now();
      const pixels = new Uint16Array(output.data.length);
      for (let index = 0; index < output.data.length; index += 1) {
        pixels[index] = output.data[index];
      }
      const outputPreparationMs = performance.now() - outputStartedAt;
      return {
        pixels,
        timings: {
          inputPreparationMs,
          executionAndReadbackMs,
          outputPreparationMs,
        },
      };
    } finally {
      sourceTensor.dispose();
      output?.dispose();
    }
  }

  async destroy(): Promise<void> {
    this.lut.dispose();
    this.exposure.dispose();
    this.lutSize.dispose();
    this.domainMin.dispose();
    this.inverseDomainRange.dispose();
    await this.session.release();
  }
}
