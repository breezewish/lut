import { expect, test, vi } from "vitest";

import {
  type GpuStripTiffEncoder,
  type StripTiffEncoder,
  renderTiffInStrips,
  renderTiffInWebGpuStrips,
} from "../src/lib/tiff-export";

test("passes only bounded source views across the color-WASM boundary", () => {
  const pixels = new Uint16Array(600_000);
  const writes: Uint16Array[] = [];
  const nextSizes = [250_000, 250_000, 100_000, 0];
  const encoder: StripTiffEncoder = {
    next_strip_samples: () => nextSizes.shift()!,
    render_strip: (strip) => writes.push(strip),
    write_strip: vi.fn(),
    finish: () => new Uint8Array([73, 73, 42, 0]),
    free: vi.fn(),
  };

  expect(
    renderTiffInStrips(
      pixels.length,
      (offset, length) => pixels.subarray(offset, offset + length),
      encoder,
    ),
  ).toMatchObject({ bytes: new Uint8Array([73, 73, 42, 0]) });
  expect(writes.map((strip) => strip.length)).toEqual([
    250_000, 250_000, 100_000,
  ]);
  expect(encoder.write_strip).toHaveBeenCalledTimes(3);
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
    render_strip: vi.fn(),
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
  let renderedLength = 0;
  const encoder: StripTiffEncoder = {
    next_strip_samples: () =>
      Math.min(stripSamples, Math.max(0, sampleCount - offset)),
    render_strip: (strip) => {
      renderedLength = strip.length;
    },
    write_strip: () => {
      offset += renderedLength;
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

test("writes WebGPU strips and reports explicit CPU sample differences", async () => {
  const source = new Uint16Array([10, 20, 30, 40, 50, 60]);
  const reference = new Uint16Array([100, 200, 300, 400, 500, 600]);
  const gpu = new Uint16Array([100, 201, 300, 400, 499, 600]);
  const sizes = [source.length, 0];
  const writes: Uint16Array[] = [];
  const encoder: GpuStripTiffEncoder = {
    next_strip_samples: () => sizes.shift()!,
    render_strip: vi.fn(),
    rendered_strip: () => reference,
    write_rendered_strip: (pixels) => writes.push(pixels),
    write_strip: vi.fn(),
    finish: () => new Uint8Array([73, 73, 42, 0]),
    free: vi.fn(),
  };

  const rendered = await renderTiffInWebGpuStrips(
    source.length,
    (offset, length) => source.subarray(offset, offset + length),
    encoder,
    {
      renderStrip: async () => ({
        pixels: gpu,
        timings: { uploadMs: 0.25, computeAndReadbackMs: 0.75 },
      }),
    },
    0,
    true,
  );

  expect(writes).toEqual([gpu]);
  expect(encoder.render_strip).toHaveBeenCalledWith(source);
  expect(encoder.write_strip).not.toHaveBeenCalled();
  expect(rendered.gpuUploadMs).toBe(0.25);
  expect(rendered.gpuComputeAndReadbackMs).toBe(0.75);
  expect(rendered.validation).toEqual({
    sampleCount: 6,
    differingSamples: 2,
    samplesOverTwoCodes: 0,
    maximumDifference: 1,
    meanAbsoluteDifference: 1 / 3,
  });
  expect(encoder.free).not.toHaveBeenCalled();
});

test("rejects a WebGPU RGB16 difference above the declared two-code bound", async () => {
  const free = vi.fn();
  const sizes = [3];
  const encoder: GpuStripTiffEncoder = {
    next_strip_samples: () => sizes.shift()!,
    render_strip: vi.fn(),
    rendered_strip: () => new Uint16Array([100, 200, 300]),
    write_rendered_strip: vi.fn(),
    write_strip: vi.fn(),
    finish: vi.fn(),
    free,
  };

  await expect(
    renderTiffInWebGpuStrips(
      3,
      () => new Uint16Array([1, 2, 3]),
      encoder,
      {
        renderStrip: async () => ({
          pixels: new Uint16Array([100, 203, 300]),
          timings: { uploadMs: 0, computeAndReadbackMs: 0 },
        }),
      },
      0,
      true,
    ),
  ).rejects.toThrow("differs from CPU by 3 codes at sample 1");
  expect(encoder.write_rendered_strip).not.toHaveBeenCalled();
  expect(free).toHaveBeenCalledOnce();
});
