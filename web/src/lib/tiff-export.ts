export interface StripTiffEncoder {
  next_strip_samples(): number;
  render_strip(pixels: Uint16Array): void;
  write_strip(): void;
  /** Consumes the encoder. */
  finish(): Uint8Array;
  free(): void;
}

export interface GpuStripTiffEncoder extends StripTiffEncoder {
  rendered_strip(): Uint16Array;
  write_rendered_strip(pixels: Uint16Array): void;
}

export interface RenderedTiff {
  bytes: Uint8Array;
  colorProcessingMs: number;
  deflateMs: number;
}

export interface GpuStripRenderer {
  renderStrip(
    pixels: Uint16Array,
    ev: number,
  ): Promise<{
    pixels: Uint16Array<ArrayBuffer>;
    timings: { uploadMs: number; computeAndReadbackMs: number };
  }>;
}

export interface GpuValidation {
  sampleCount: number;
  differingSamples: number;
  samplesOverTwoCodes: number;
  maximumDifference: number;
  meanAbsoluteDifference: number;
}

export interface WebGpuRenderedTiff extends RenderedTiff {
  gpuUploadMs: number;
  gpuComputeAndReadbackMs: number;
  validation?: GpuValidation;
}

const MAX_GPU_RGB16_DIFFERENCE = 2;

/**
 * Sends only bounded views of the decoded source into the color WASM. The
 * generated binding copies each view, so passing the complete image here would
 * retain a second full-resolution RGB16 allocation during export.
 */
export function renderTiffInStrips(
  sampleCount: number,
  read: (offset: number, length: number) => Uint16Array,
  encoder: StripTiffEncoder,
): RenderedTiff {
  let offset = 0;
  let consumed = false;
  let colorProcessingMs = 0;
  let deflateMs = 0;
  try {
    for (;;) {
      const requested = encoder.next_strip_samples();
      if (requested === 0) break;
      const remaining = sampleCount - offset;
      if (requested > remaining) {
        throw new Error(
          `TIFF encoder requested ${requested} samples with ${remaining} remaining.`,
        );
      }
      let startedAt = performance.now();
      encoder.render_strip(read(offset, requested));
      colorProcessingMs += performance.now() - startedAt;
      startedAt = performance.now();
      encoder.write_strip();
      deflateMs += performance.now() - startedAt;
      offset += requested;
    }
    if (offset !== sampleCount) {
      throw new Error(
        `TIFF encoder consumed ${offset} of ${sampleCount} samples.`,
      );
    }
    const startedAt = performance.now();
    // `finish` consumes the WASM encoder even when it returns an error.
    consumed = true;
    const bytes = encoder.finish();
    deflateMs += performance.now() - startedAt;
    return { bytes, colorProcessingMs, deflateMs };
  } finally {
    if (!consumed) encoder.free();
  }
}

/** Renders each TIFF strip on WebGPU and optionally compares every sample to CPU. */
export async function renderTiffInWebGpuStrips(
  sampleCount: number,
  read: (offset: number, length: number) => Uint16Array,
  encoder: GpuStripTiffEncoder,
  renderer: GpuStripRenderer,
  ev: number,
  validate: boolean,
): Promise<WebGpuRenderedTiff> {
  let offset = 0;
  let consumed = false;
  let colorProcessingMs = 0;
  let deflateMs = 0;
  let gpuUploadMs = 0;
  let gpuComputeAndReadbackMs = 0;
  let differingSamples = 0;
  let samplesOverTwoCodes = 0;
  let maximumDifference = 0;
  let absoluteDifference = 0;
  try {
    for (;;) {
      const requested = encoder.next_strip_samples();
      if (requested === 0) break;
      const remaining = sampleCount - offset;
      if (requested > remaining) {
        throw new Error(
          `TIFF encoder requested ${requested} samples with ${remaining} remaining.`,
        );
      }
      const source = read(offset, requested);
      const startedAt = performance.now();
      const rendered = await renderer.renderStrip(source, ev);
      colorProcessingMs += performance.now() - startedAt;
      gpuUploadMs += rendered.timings.uploadMs;
      gpuComputeAndReadbackMs += rendered.timings.computeAndReadbackMs;
      if (validate) {
        encoder.render_strip(source);
        const reference = encoder.rendered_strip();
        if (reference.length !== rendered.pixels.length) {
          throw new Error("CPU and WebGPU strip lengths differ.");
        }
        for (let index = 0; index < reference.length; index += 1) {
          const difference = Math.abs(
            reference[index] - rendered.pixels[index],
          );
          absoluteDifference += difference;
          if (difference !== 0) differingSamples += 1;
          if (difference > MAX_GPU_RGB16_DIFFERENCE) {
            samplesOverTwoCodes += 1;
            throw new Error(
              `WebGPU RGB16 differs from CPU by ${difference} codes at sample ${offset + index}.`,
            );
          }
          maximumDifference = Math.max(maximumDifference, difference);
        }
      }
      const deflateStartedAt = performance.now();
      encoder.write_rendered_strip(rendered.pixels);
      deflateMs += performance.now() - deflateStartedAt;
      offset += requested;
    }
    if (offset !== sampleCount) {
      throw new Error(
        `TIFF encoder consumed ${offset} of ${sampleCount} samples.`,
      );
    }
    const startedAt = performance.now();
    consumed = true;
    const bytes = encoder.finish();
    deflateMs += performance.now() - startedAt;
    return {
      bytes,
      colorProcessingMs,
      deflateMs,
      gpuUploadMs,
      gpuComputeAndReadbackMs,
      validation: validate
        ? {
            sampleCount,
            differingSamples,
            samplesOverTwoCodes,
            maximumDifference,
            meanAbsoluteDifference: absoluteDifference / sampleCount,
          }
        : undefined,
    };
  } finally {
    if (!consumed) encoder.free();
  }
}
