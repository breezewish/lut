import { describe, expect, it } from "vitest";

import { RenderedImageStream, type GpuStripImageEncoder } from "./image-export";

class TestEncoder implements GpuStripImageEncoder {
  readonly strips: Uint16Array[] = [];

  constructor(private readonly stripSizes: number[]) {}

  next_strip_samples(): number {
    return this.stripSizes[this.strips.length] ?? 0;
  }

  write_rendered_strip(pixels: Uint16Array): void {
    this.strips.push(new Uint16Array(pixels));
  }

  finish(): Uint8Array {
    return new Uint8Array([1, 2, 3]);
  }

  free(): void {}
}

describe("RenderedImageStream", () => {
  it("joins bands only at an encoder strip boundary", () => {
    const encoder = new TestEncoder([4, 4]);
    const stream = new RenderedImageStream(encoder);

    stream.write(new Uint16Array([1, 2, 3]));
    stream.write(new Uint16Array([4, 5, 6, 7, 8]));
    const result = stream.finish(8);

    expect(encoder.strips.map((strip) => Array.from(strip))).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
  });

  it("rejects an incomplete final strip", () => {
    const encoder = new TestEncoder([4]);
    const stream = new RenderedImageStream(encoder);

    stream.write(new Uint16Array([1, 2, 3]));

    expect(() => stream.finish(4)).toThrow(
      "Image stream consumed 0 samples with 3 pending; expected 4.",
    );
  });
});
