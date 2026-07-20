import { expect, test, vi } from "vitest";

import { acquirePreparedGpuLut, type GpuLut } from "../src/lib/webgpu-lut";

test("evicts the least-recently-used idle LUT when active uploads cross the budget", () => {
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2 });
  const buffers: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  const device = {
    createBuffer: vi.fn(() => {
      const buffer = { destroy: vi.fn() };
      buffers.push(buffer);
      return buffer as unknown as GPUBuffer;
    }),
    queue: { writeBuffer: vi.fn() },
  } as unknown as GPUDevice;
  const createLut = (): GpuLut => ({
    size: () => 118,
    domain_min: () => new Float32Array([0, 0, 0]),
    domain_max: () => new Float32Array([1, 1, 1]),
    samples: () => new Float32Array(5_000_000),
  });
  const firstLut = createLut();
  const secondLut = createLut();

  const first = acquirePreparedGpuLut(device, firstLut);
  const second = acquirePreparedGpuLut(device, secondLut);
  expect(buffers).toHaveLength(2);
  expect(buffers[0].destroy).not.toHaveBeenCalled();

  first.release();
  expect(buffers[0].destroy).toHaveBeenCalledOnce();
  expect(buffers[1].destroy).not.toHaveBeenCalled();

  const reacquired = acquirePreparedGpuLut(device, firstLut);
  expect(buffers).toHaveLength(3);
  second.release();
  expect(buffers[1].destroy).toHaveBeenCalledOnce();
  expect(buffers[2].destroy).not.toHaveBeenCalled();
  reacquired.release();
});

test("reads LUT metadata before allocating its GPU buffer", () => {
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2 });
  const createBuffer = vi.fn();
  const device = {
    createBuffer,
    queue: { writeBuffer: vi.fn() },
  } as unknown as GPUDevice;
  const invalidLut: GpuLut = {
    size: () => 2,
    domain_min: () => {
      throw new Error("invalid domain");
    },
    domain_max: () => new Float32Array([1, 1, 1]),
    samples: () => new Float32Array(24),
  };

  expect(() => acquirePreparedGpuLut(device, invalidLut)).toThrow(
    "invalid domain",
  );
  expect(createBuffer).not.toHaveBeenCalled();
});
