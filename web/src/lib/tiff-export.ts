export interface StripTiffEncoder {
  next_strip_samples(): number;
  write_strip(pixels: Uint16Array): void;
  /** Consumes the encoder. */
  finish(): Uint8Array;
  free(): void;
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
): Uint8Array {
  let offset = 0;
  let consumed = false;
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
      encoder.write_strip(read(offset, requested));
      offset += requested;
    }
    if (offset !== sampleCount) {
      throw new Error(
        `TIFF encoder consumed ${offset} of ${sampleCount} samples.`,
      );
    }
    consumed = true;
    return encoder.finish();
  } finally {
    if (!consumed) encoder.free();
  }
}
