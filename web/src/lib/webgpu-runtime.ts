export interface WebGpuRuntime {
  adapter: GPUAdapter;
  device: GPUDevice;
  assertAvailable(): void;
}

let runtimePromise: Promise<WebGpuRuntime> | undefined;
let runtimeFailure: Error | undefined;

/** Returns the one high-performance WebGPU device shared by browser compute stages. */
export async function getWebGpuRuntime(
  requiredBufferBytes = 0,
): Promise<WebGpuRuntime> {
  if (runtimeFailure) throw runtimeFailure;
  if (!runtimePromise) runtimePromise = createRuntime();
  const runtime = await runtimePromise;
  runtime.assertAvailable();
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
  if (!("gpu" in navigator)) {
    throw new Error(
      "WebGPU is required to process RAW files. Use a browser and GPU with WebGPU support.",
    );
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) {
    throw new Error(
      "WebGPU is required to process RAW files, but no compatible GPU adapter is available.",
    );
  }
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  });
  const runtime: WebGpuRuntime = {
    adapter,
    device,
    assertAvailable() {
      if (runtimeFailure) throw runtimeFailure;
    },
  };
  void device.lost.then((info) => {
    const details = info.message ? `: ${info.message}` : "";
    runtimeFailure = new Error(
      `WebGPU device was lost (${info.reason})${details}. Reload the page after the GPU is available again.`,
    );
  });
  return runtime;
}
