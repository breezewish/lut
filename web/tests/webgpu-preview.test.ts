import { afterEach, expect, test, vi } from "vitest";

const gpu = vi.hoisted(() => {
  const buffers: Array<{
    descriptor: GPUBufferDescriptor;
    destroy: ReturnType<typeof vi.fn>;
  }> = [];
  const allocate = (descriptor: GPUBufferDescriptor) => {
    const buffer = { descriptor, destroy: vi.fn() };
    buffers.push(buffer);
    return buffer as unknown as GPUBuffer;
  };
  const createBuffer = vi.fn(allocate);
  const device = {
    createBuffer,
    createBindGroup: vi.fn(() => ({}) as GPUBindGroup),
    queue: { writeBuffer: vi.fn() },
  } as unknown as GPUDevice;
  const runtime = {
    device,
    assertAvailable: vi.fn(),
  };
  const pipeline = {
    getBindGroupLayout: vi.fn(() => ({})),
  } as unknown as GPUComputePipeline;
  return { allocate, buffers, createBuffer, device, pipeline, runtime };
});

vi.mock("../src/lib/webgpu-runtime", () => ({
  createCheckedComputePipeline: vi.fn(async () => gpu.pipeline),
  getWebGpuRuntime: vi.fn(async () => gpu.runtime),
  writePaddedBuffer: vi.fn(),
}));

afterEach(() => {
  gpu.buffers.length = 0;
  vi.clearAllMocks();
  gpu.createBuffer.mockImplementation(gpu.allocate);
  vi.resetModules();
  vi.unstubAllGlobals();
});

test("releases a partially allocated shared workspace without releasing its source", async () => {
  vi.stubGlobal("GPUBufferUsage", {
    STORAGE: 1,
    COPY_DST: 2,
    COPY_SRC: 4,
    MAP_READ: 8,
    UNIFORM: 16,
  });
  const { WebGpuPreviewRenderer, WebGpuPreviewSource } = await import(
    "../src/lib/webgpu-preview"
  );
  const source = await WebGpuPreviewSource.create(new Uint16Array(48), 4, 4);
  gpu.createBuffer
    .mockImplementationOnce(gpu.allocate)
    .mockImplementationOnce(() => {
      throw new Error("out of memory");
    });

  await expect(
    WebGpuPreviewRenderer.create(source, {
      size: () => 2,
      domain_min: () => new Float32Array([0, 0, 0]),
      domain_max: () => new Float32Array([1, 1, 1]),
      samples: () => new Float32Array(24),
    }),
  ).rejects.toThrow("WebGPU could not allocate the preview buffers.");
  expect(gpu.buffers).toHaveLength(2);
  expect(gpu.buffers[0].destroy).not.toHaveBeenCalled();
  expect(gpu.buffers[1].destroy).toHaveBeenCalledOnce();

  source.free();
  expect(gpu.buffers[0].destroy).toHaveBeenCalledOnce();
});

test("shares one output workspace and LUT across retained preview sources", async () => {
  vi.stubGlobal("GPUBufferUsage", {
    STORAGE: 1,
    COPY_DST: 2,
    COPY_SRC: 4,
    MAP_READ: 8,
    UNIFORM: 16,
  });
  const { WebGpuPreviewRenderer, WebGpuPreviewSource } = await import(
    "../src/lib/webgpu-preview"
  );
  const lut = {
    size: () => 2,
    domain_min: () => new Float32Array([0, 0, 0]),
    domain_max: () => new Float32Array([1, 1, 1]),
    samples: () => new Float32Array(24),
  };

  const first = await WebGpuPreviewSource.create(new Uint16Array(48), 4, 4);
  const renderer = await WebGpuPreviewRenderer.create(first, lut);
  expect(gpu.buffers).toHaveLength(7);

  const smaller = await WebGpuPreviewSource.create(new Uint16Array(12), 2, 2);
  renderer.setSource(smaller);
  expect(gpu.buffers).toHaveLength(8);

  const larger = await WebGpuPreviewSource.create(new Uint16Array(192), 8, 8);
  renderer.setSource(larger);
  expect(gpu.buffers).toHaveLength(13);
  for (const buffer of gpu.buffers.slice(1, 5)) {
    expect(buffer.destroy).toHaveBeenCalledOnce();
  }
  expect(gpu.buffers[0].destroy).not.toHaveBeenCalled();
  expect(gpu.buffers[6].destroy).not.toHaveBeenCalled();

  renderer.setLut(lut);
  expect(gpu.buffers).toHaveLength(14);
  expect(gpu.buffers[6].destroy).toHaveBeenCalledOnce();

  renderer.free();
  expect(gpu.buffers[0].destroy).not.toHaveBeenCalled();
  expect(gpu.buffers[7].destroy).not.toHaveBeenCalled();
  expect(gpu.buffers[8].destroy).not.toHaveBeenCalled();

  first.free();
  smaller.free();
  larger.free();
  expect(gpu.buffers[0].destroy).toHaveBeenCalledOnce();
  expect(gpu.buffers[7].destroy).toHaveBeenCalledOnce();
  expect(gpu.buffers[8].destroy).toHaveBeenCalledOnce();
});
