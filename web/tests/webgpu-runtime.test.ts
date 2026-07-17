import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test("reports that WebGPU is a product requirement", async () => {
  vi.stubGlobal("navigator", {});
  const { getWebGpuRuntime } = await import("../src/lib/webgpu-runtime");

  await expect(getWebGpuRuntime()).rejects.toThrow(
    "WebGPU is required to process RAW files",
  );
});

test("rejects reuse after the shared device is lost", async () => {
  let loseDevice!: (info: GPUDeviceLostInfo) => void;
  const lost = new Promise<GPUDeviceLostInfo>((resolve) => {
    loseDevice = resolve;
  });
  const device = { lost } as GPUDevice;
  const adapter = {
    limits: {
      maxBufferSize: 1_000_000,
      maxStorageBufferBindingSize: 1_000_000,
    },
    requestDevice: vi.fn(async () => device),
  } as unknown as GPUAdapter;
  vi.stubGlobal("navigator", {
    gpu: { requestAdapter: vi.fn(async () => adapter) },
  });
  const { getWebGpuRuntime } = await import("../src/lib/webgpu-runtime");

  await expect(getWebGpuRuntime()).resolves.toMatchObject({ adapter, device });
  loseDevice({
    reason: "destroyed",
    message: "test loss",
  } as GPUDeviceLostInfo);
  await lost;
  await Promise.resolve();

  await expect(getWebGpuRuntime()).rejects.toThrow(
    "WebGPU device was lost (destroyed): test loss",
  );
});
