export interface GpuStripTiffEncoder {
  next_strip_samples(): number;
  write_rendered_strip(pixels: Uint16Array): void;
  /** Consumes the encoder. */
  finish(): Uint8Array;
  free(): void;
}

export interface RenderedTiff {
  bytes: Uint8Array;
  colorProcessingMs: number;
  tiffEncodingMs: number;
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

export interface GpuRenderedTiff extends RenderedTiff {
  gpuInputPreparationMs: number;
  gpuExecutionAndReadbackMs: number;
  gpuOutputPreparationMs: number;
}

/** Writes already color-rendered row bands into the encoder's fixed strips. */
export class RenderedTiffStream {
  private pending = new Uint16Array(0);
  private sampleCount = 0;
  private tiffEncodingMs = 0;
  private consumed = false;

  constructor(private readonly encoder: GpuStripTiffEncoder) {}

  write(pixels: Uint16Array): void {
    if (this.consumed) throw new Error("TIFF stream is already finished.");
    let offset = 0;
    for (;;) {
      const requested = this.encoder.next_strip_samples();
      if (requested === 0) break;
      let strip: Uint16Array;
      if (this.pending.length > 0) {
        const needed = requested - this.pending.length;
        if (needed > pixels.length - offset) {
          const pending = new Uint16Array(
            this.pending.length + pixels.length - offset,
          );
          pending.set(this.pending);
          pending.set(pixels.subarray(offset), this.pending.length);
          this.pending = pending;
          return;
        }
        strip = new Uint16Array(requested);
        strip.set(this.pending);
        strip.set(
          pixels.subarray(offset, offset + needed),
          this.pending.length,
        );
        this.pending = new Uint16Array(0);
        offset += needed;
      } else {
        if (requested > pixels.length - offset) break;
        strip = pixels.subarray(offset, offset + requested);
        offset += requested;
      }
      const startedAt = performance.now();
      this.encoder.write_rendered_strip(strip);
      this.tiffEncodingMs += performance.now() - startedAt;
      this.sampleCount += requested;
    }
    this.pending = pixels.slice(offset);
  }

  finish(expectedSamples: number): RenderedTiff {
    if (this.pending.length !== 0 || this.sampleCount !== expectedSamples) {
      throw new Error(
        `TIFF stream consumed ${this.sampleCount} samples with ${this.pending.length} pending; expected ${expectedSamples}.`,
      );
    }
    if (this.encoder.next_strip_samples() !== 0) {
      throw new Error(
        "TIFF encoder still expects pixels after the final band.",
      );
    }
    const startedAt = performance.now();
    this.consumed = true;
    const bytes = this.encoder.finish();
    this.tiffEncodingMs += performance.now() - startedAt;
    return {
      bytes,
      colorProcessingMs: 0,
      tiffEncodingMs: this.tiffEncodingMs,
    };
  }

  free(): void {
    if (!this.consumed) this.encoder.free();
    this.consumed = true;
  }
}

/** Renders bounded GPU batches and writes the original TIFF compression strips. */
export async function renderTiffInGpuStrips(
  sampleCount: number,
  read: (offset: number, length: number) => Uint16Array,
  encoder: GpuStripTiffEncoder,
  renderer: GpuStripRenderer,
  ev: number,
): Promise<GpuRenderedTiff> {
  let offset = 0;
  let consumed = false;
  let colorProcessingMs = 0;
  let tiffEncodingMs = 0;
  let gpuInputPreparationMs = 0;
  let gpuExecutionAndReadbackMs = 0;
  let gpuOutputPreparationMs = 0;
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
        const renderedStrip = rendered.pixels.subarray(
          batchOffset,
          batchOffset + stripSamples,
        );
        const encodingStartedAt = performance.now();
        encoder.write_rendered_strip(renderedStrip);
        tiffEncodingMs += performance.now() - encodingStartedAt;
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
    tiffEncodingMs += performance.now() - startedAt;
    return {
      bytes,
      colorProcessingMs,
      tiffEncodingMs,
      gpuInputPreparationMs,
      gpuExecutionAndReadbackMs,
      gpuOutputPreparationMs,
    };
  } finally {
    if (!consumed) encoder.free();
  }
}
