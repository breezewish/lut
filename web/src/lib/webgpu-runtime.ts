export interface WebGpuRuntime {
  adapter: GPUAdapter;
  device: GPUDevice;
  assertAvailable(): void;
}

let runtimePromise: Promise<WebGpuRuntime> | undefined;
let runtimeFailure: Error | undefined;

/** Compiles one compute entry point and surfaces WGSL diagnostics clearly. */
export async function createCheckedComputePipeline(
  device: GPUDevice,
  code: string,
  label: string,
  entryPoint = "main",
): Promise<GPUComputePipeline> {
  const module = device.createShaderModule({ code, label });
  const compilation = await module.getCompilationInfo();
  const errors = compilation.messages.filter(
    (message) => message.type === "error",
  );
  if (errors.length > 0) {
    throw new Error(
      `${label} failed to compile: ${errors.map(({ message }) => message).join("; ")}`,
    );
  }
  return device.createComputePipelineAsync({
    label,
    layout: "auto",
    compute: { module, entryPoint },
  });
}

/** Uploads a non-shared view, adding only the alignment padding WebGPU needs. */
export function writePaddedBuffer(
  device: GPUDevice,
  destination: GPUBuffer,
  source: ArrayBufferView<ArrayBufferLike>,
  paddedBytes: number,
): void {
  if (
    source.buffer instanceof ArrayBuffer &&
    source.byteLength === paddedBytes
  ) {
    device.queue.writeBuffer(
      destination,
      0,
      source.buffer,
      source.byteOffset,
      source.byteLength,
    );
    return;
  }
  const padded = new Uint8Array(paddedBytes);
  padded.set(
    new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
  );
  device.queue.writeBuffer(destination, 0, padded);
}

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
