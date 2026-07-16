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
  /** Preferred color batch size; TIFF compression keeps its own strip size. */
  preferredBatchSamples?: number;
  renderStrip(
    pixels: Uint16Array,
    ev: number,
  ): Promise<{
    pixels: Uint16Array<ArrayBuffer>;
    timings: {
      inputPreparationMs: number;
      executionAndReadbackMs: number;
      outputPreparationMs: number;
    };
  }>;
}

export interface GpuValidation {
  sampleCount: number;
  differingSamples: number;
  samplesOverTwoCodes: number;
  maximumDifference: number;
  meanAbsoluteDifference: number;
}

export interface GpuRenderedTiff extends RenderedTiff {
  gpuInputPreparationMs: number;
  gpuExecutionAndReadbackMs: number;
  gpuOutputPreparationMs: number;
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

/** Renders bounded GPU batches and writes the original TIFF compression strips. */
export async function renderTiffInGpuStrips(
  sampleCount: number,
  read: (offset: number, length: number) => Uint16Array,
  encoder: GpuStripTiffEncoder,
  renderer: GpuStripRenderer,
  ev: number,
  validate: boolean,
): Promise<GpuRenderedTiff> {
  let offset = 0;
  let consumed = false;
  let colorProcessingMs = 0;
  let deflateMs = 0;
  let gpuInputPreparationMs = 0;
  let gpuExecutionAndReadbackMs = 0;
  let gpuOutputPreparationMs = 0;
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
      const batchMultiplier = Math.max(
        1,
        Math.floor((renderer.preferredBatchSamples ?? requested) / requested),
      );
      const batchSamples = Math.min(remaining, requested * batchMultiplier);
      const source = read(offset, batchSamples);
      const startedAt = performance.now();
      const rendered = await renderer.renderStrip(source, ev);
      colorProcessingMs += performance.now() - startedAt;
      gpuInputPreparationMs += rendered.timings.inputPreparationMs;
      gpuExecutionAndReadbackMs += rendered.timings.executionAndReadbackMs;
      gpuOutputPreparationMs += rendered.timings.outputPreparationMs;
      if (rendered.pixels.length !== batchSamples) {
        throw new Error("GPU output length differs from its input batch.");
      }
      let batchOffset = 0;
      while (batchOffset < batchSamples) {
        const stripSamples = encoder.next_strip_samples();
        if (stripSamples === 0 || stripSamples > batchSamples - batchOffset) {
          throw new Error("TIFF strip boundaries changed within a GPU batch.");
        }
        const sourceStrip = source.subarray(
          batchOffset,
          batchOffset + stripSamples,
        );
        const renderedStrip = rendered.pixels.subarray(
          batchOffset,
          batchOffset + stripSamples,
        );
        if (validate) {
          encoder.render_strip(sourceStrip);
          const reference = encoder.rendered_strip();
          if (reference.length !== renderedStrip.length) {
            throw new Error("CPU and GPU strip lengths differ.");
          }
          for (let index = 0; index < reference.length; index += 1) {
            const difference = Math.abs(
              reference[index] - renderedStrip[index],
            );
            absoluteDifference += difference;
            if (difference !== 0) differingSamples += 1;
            if (difference > MAX_GPU_RGB16_DIFFERENCE) {
              samplesOverTwoCodes += 1;
              throw new Error(
                `GPU RGB16 differs from CPU by ${difference} codes at sample ${offset + index}.`,
              );
            }
            maximumDifference = Math.max(maximumDifference, difference);
          }
        }
        const deflateStartedAt = performance.now();
        encoder.write_rendered_strip(renderedStrip);
        deflateMs += performance.now() - deflateStartedAt;
        batchOffset += stripSamples;
        offset += stripSamples;
      }
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
      gpuInputPreparationMs,
      gpuExecutionAndReadbackMs,
      gpuOutputPreparationMs,
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
