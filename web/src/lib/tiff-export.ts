export interface StripTiffEncoder {
  next_strip_samples(): number;
  render_strip(pixels: Uint16Array): void;
  write_strip(): void;
  /** Consumes the encoder. */
  finish(): Uint8Array;
  free(): void;
}

export interface RenderedTiff {
  bytes: Uint8Array;
  colorProcessingMs: number;
  tiffEncodingMs: number;
}

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
  let tiffEncodingMs = 0;
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
      tiffEncodingMs += performance.now() - startedAt;
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
    tiffEncodingMs += performance.now() - startedAt;
    return { bytes, colorProcessingMs, tiffEncodingMs };
  } finally {
    if (!consumed) encoder.free();
  }
}
