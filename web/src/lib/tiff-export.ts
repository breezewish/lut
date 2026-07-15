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
  pixels: Uint16Array,
  encoder: StripTiffEncoder,
): Uint8Array {
  let offset = 0;
  let consumed = false;
  try {
    for (;;) {
      const sampleCount = encoder.next_strip_samples();
      if (sampleCount === 0) break;
      const remaining = pixels.length - offset;
      if (sampleCount > remaining) {
        throw new Error(
          `TIFF encoder requested ${sampleCount} samples with ${remaining} remaining.`,
        );
      }
      encoder.write_strip(pixels.subarray(offset, offset + sampleCount));
      offset += sampleCount;
    }
    if (offset !== pixels.length) {
      throw new Error(
        `TIFF encoder consumed ${offset} of ${pixels.length} samples.`,
      );
    }
    consumed = true;
    return encoder.finish();
  } finally {
    if (!consumed) encoder.free();
  }
}
