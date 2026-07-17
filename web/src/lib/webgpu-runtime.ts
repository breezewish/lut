export interface WebGpuRuntime {
  adapter: GPUAdapter;
  device: GPUDevice;
}

let runtimePromise: Promise<WebGpuRuntime> | undefined;

/** Returns the one high-performance WebGPU device shared by browser compute stages. */
export async function getWebGpuRuntime(
  requiredBufferBytes = 0,
): Promise<WebGpuRuntime> {
  if (!runtimePromise) runtimePromise = createRuntime();
  const runtime = await runtimePromise;
  if (
    requiredBufferBytes > runtime.adapter.limits.maxBufferSize ||
    requiredBufferBytes > runtime.adapter.limits.maxStorageBufferBindingSize
  ) {
    throw new Error(
      `The WebGPU adapter cannot bind the required ${requiredBufferBytes}-byte buffer.`,
    );
  }
  return runtime;
}

async function createRuntime(): Promise<WebGpuRuntime> {
  if (!("gpu" in navigator)) throw new Error("WebGPU is unavailable.");
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) throw new Error("No WebGPU adapter is available.");
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  });
  return { adapter, device };
}
