export interface GpuLut {
  size(): number;
  domain_min(): Float32Array;
  domain_max(): Float32Array;
  samples(): Float32Array;
}

export interface PreparedGpuLut {
  buffer: GPUBuffer;
  size: number;
  domainMin: Float32Array;
  inverseDomainRange: Float32Array;
}

interface CacheEntry {
  prepared: PreparedGpuLut;
  bytes: number;
  users: number;
}

interface DeviceCache {
  entries: Map<GpuLut, CacheEntry>;
  bytes: number;
}

export interface PreparedGpuLutLease {
  prepared: PreparedGpuLut;
  release(): void;
}

const GPU_LUT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const caches = new WeakMap<GPUDevice, DeviceCache>();

/** Retains one parsed LUT upload in a bounded per-device LRU. */
export function acquirePreparedGpuLut(
  device: GPUDevice,
  lut: GpuLut,
): PreparedGpuLutLease {
  let cache = caches.get(device);
  if (!cache) {
    cache = { entries: new Map(), bytes: 0 };
    caches.set(device, cache);
  }

  let entry = cache.entries.get(lut);
  if (!entry) {
    const size = lut.size();
    const domainMin = lut.domain_min();
    const domainMax = lut.domain_max();
    const inverseDomainRange = domainMin.map(
      (minimum, axis) => 1 / (domainMax[axis] - minimum),
    );
    const samples = lut.samples();
    if (!(samples.buffer instanceof ArrayBuffer)) {
      throw new Error("WebGPU LUT samples must use non-shared memory.");
    }
    evictUnusedLuts(cache, samples.byteLength);
    const buffer = device.createBuffer({
      size: samples.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    try {
      device.queue.writeBuffer(buffer, 0, samples as Float32Array<ArrayBuffer>);
    } catch (error) {
      buffer.destroy();
      throw error;
    }
    entry = {
      prepared: {
        buffer,
        size,
        domainMin,
        inverseDomainRange,
      },
      bytes: samples.byteLength,
      users: 0,
    };
    cache.entries.set(lut, entry);
    cache.bytes += entry.bytes;
  } else {
    cache.entries.delete(lut);
    cache.entries.set(lut, entry);
  }

  entry.users += 1;
  let released = false;
  return {
    prepared: entry.prepared,
    release() {
      if (released) return;
      released = true;
      entry.users -= 1;
      evictUnusedLuts(cache, 0);
    },
  };
}

function evictUnusedLuts(cache: DeviceCache, incomingBytes: number): void {
  for (const [lut, entry] of cache.entries) {
    if (cache.bytes + incomingBytes <= GPU_LUT_CACHE_MAX_BYTES) return;
    if (entry.users > 0) continue;
    entry.prepared.buffer.destroy();
    cache.entries.delete(lut);
    cache.bytes -= entry.bytes;
  }
}
