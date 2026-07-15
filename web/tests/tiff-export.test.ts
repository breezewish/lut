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

  expect(renderTiffInStrips(pixels, encoder)).toEqual(
    new Uint8Array([73, 73, 42, 0]),
  );
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

  expect(() => renderTiffInStrips(new Uint16Array(3), encoder)).toThrow(
    "TIFF encoder requested 4 samples with 3 remaining.",
  );
  expect(free).toHaveBeenCalledOnce();
});
