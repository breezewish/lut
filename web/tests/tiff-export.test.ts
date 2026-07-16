import { expect, test, vi } from "vitest";

import {
  type StripTiffEncoder,
  renderTiffInStrips,
} from "../src/lib/tiff-export";

test("passes only bounded source views across the color-WASM boundary", () => {
  const pixels = new Uint16Array(600_000);
  const writes: Uint16Array[] = [];
  const nextSizes = [250_000, 250_000, 100_000, 0];
  const encoder: StripTiffEncoder = {
    next_strip_samples: () => nextSizes.shift()!,
    write_strip: (strip) => writes.push(strip),
    finish: () => new Uint8Array([73, 73, 42, 0]),
    free: vi.fn(),
  };

  expect(
    renderTiffInStrips(
      pixels.length,
      (offset, length) => pixels.subarray(offset, offset + length),
      encoder,
    ),
  ).toEqual(new Uint8Array([73, 73, 42, 0]));
  expect(writes.map((strip) => strip.length)).toEqual([
    250_000, 250_000, 100_000,
  ]);
  expect(
    writes.every(
      (strip) =>
        strip.buffer === pixels.buffer && strip.byteLength <= 1_000_000,
    ),
  ).toBe(true);
  expect(encoder.free).not.toHaveBeenCalled();
});

test("rejects an encoder strip contract that exceeds the source image", () => {
  const free = vi.fn();
  const encoder: StripTiffEncoder = {
    next_strip_samples: () => 4,
    write_strip: vi.fn(),
    finish: vi.fn(),
    free,
  };

  expect(() => renderTiffInStrips(3, () => new Uint16Array(), encoder)).toThrow(
    "TIFF encoder requested 4 samples with 3 remaining.",
  );
  expect(free).toHaveBeenCalledOnce();
});

test("keeps a full-resolution camera export on bounded source views", () => {
  const sampleCount = 6_240 * 4_168 * 3;
  const stripSamples = 500_000;
  let offset = 0;
  let largestView = 0;
  let viewCount = 0;
  const encoder: StripTiffEncoder = {
    next_strip_samples: () =>
      Math.min(stripSamples, Math.max(0, sampleCount - offset)),
    write_strip: (strip) => {
      offset += strip.length;
    },
    finish: () => new Uint8Array([73, 73, 42, 0]),
    free: vi.fn(),
  };

  renderTiffInStrips(
    sampleCount,
    (_offset, length) => {
      largestView = Math.max(largestView, length);
      viewCount += 1;
      return new Uint16Array(length);
    },
    encoder,
  );

  expect(offset).toBe(sampleCount);
  expect(largestView).toBe(stripSamples);
  expect(largestView * Uint16Array.BYTES_PER_ELEMENT).toBeLessThanOrEqual(
    1_000_000,
  );
  expect(viewCount).toBeGreaterThan(100);
  expect(encoder.free).not.toHaveBeenCalled();
});
