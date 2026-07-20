import { expect, test, vi } from "vitest";

import {
  type GpuStripImageEncoder,
  RenderedImageStream,
  renderImageInGpuStrips,
} from "../src/lib/image-export";

test("streams rendered bands across fixed image strip boundaries", () => {
  const sizes = [6, 6, 0];
  const writes: Uint16Array[] = [];
  const encoder: GpuStripImageEncoder = {
    next_strip_samples: () => sizes[0],
    write_rendered_strip: (pixels) => {
      writes.push(new Uint16Array(pixels));
      sizes.shift();
    },
    finish: () => new Uint8Array([73, 73, 42, 0]),
    free: vi.fn(),
  };
  const stream = new RenderedImageStream(encoder);

  stream.write(new Uint16Array([1, 2, 3, 4]));
  stream.write(new Uint16Array([5, 6, 7, 8, 9, 10, 11, 12]));
  expect(stream.finish(12).bytes).toEqual(new Uint8Array([73, 73, 42, 0]));
  expect(writes).toEqual([
    new Uint16Array([1, 2, 3, 4, 5, 6]),
    new Uint16Array([7, 8, 9, 10, 11, 12]),
  ]);
  expect(encoder.free).not.toHaveBeenCalled();
});

test("batches GPU color independently from image encoder strips", async () => {
  const source = new Uint16Array([1, 2, 3, 4, 5, 6]);
  const sizes = [3, 3, 0];
  const writes: Uint16Array[] = [];
  const renderer = {
    preferredBatchSamples: 6,
    renderStrip: vi.fn(async (pixels: Uint16Array) => ({
      pixels: new Uint16Array(pixels),
      timings: {
        inputPreparationMs: 0.25,
        executionAndReadbackMs: 0.75,
        outputPreparationMs: 0.125,
      },
    })),
  };
  const encoder: GpuStripImageEncoder = {
    next_strip_samples: () => sizes[0],
    write_rendered_strip: (pixels) => {
      writes.push(new Uint16Array(pixels));
      sizes.shift();
    },
    finish: () => new Uint8Array([73, 73, 42, 0]),
    free: vi.fn(),
  };

  const rendered = await renderImageInGpuStrips(
    source.length,
    (offset, length) => source.subarray(offset, offset + length),
    encoder,
    renderer,
    0,
  );

  expect(renderer.renderStrip).toHaveBeenCalledOnce();
  expect(renderer.renderStrip).toHaveBeenCalledWith(source, 0);
  expect(writes).toEqual([
    new Uint16Array([1, 2, 3]),
    new Uint16Array([4, 5, 6]),
  ]);
  expect(rendered).toMatchObject({
    gpuInputPreparationMs: 0.25,
    gpuExecutionAndReadbackMs: 0.75,
    gpuOutputPreparationMs: 0.125,
  });
  expect(encoder.free).not.toHaveBeenCalled();
});

test("rejects a GPU batch that does not cover its source", async () => {
  const free = vi.fn();
  const encoder: GpuStripImageEncoder = {
    next_strip_samples: () => 3,
    write_rendered_strip: vi.fn(),
    finish: vi.fn(),
    free,
  };

  await expect(
    renderImageInGpuStrips(
      3,
      () => new Uint16Array([1, 2, 3]),
      encoder,
      {
        renderStrip: async () => ({
          pixels: new Uint16Array([1, 2]),
          timings: {
            inputPreparationMs: 0,
            executionAndReadbackMs: 0,
            outputPreparationMs: 0,
          },
        }),
      },
      0,
    ),
  ).rejects.toThrow("GPU output length differs from its input batch.");
  expect(encoder.write_rendered_strip).not.toHaveBeenCalled();
  expect(free).toHaveBeenCalledOnce();
});
