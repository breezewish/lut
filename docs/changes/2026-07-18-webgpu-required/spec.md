# Required WebGPU Specification

## Goal

Make WebGPU the single browser rendering backend without removing accepted RAW
formats.

## Behavior

Preview and Export require a compatible WebGPU adapter. Missing WebGPU, device
loss, allocation failure, and adapter-limit failure are visible errors and do
not select CPU rendering.

Even, unrotated Bayer RAW uses WebGPU AAHD. X-Trans, Linear DNG, rotated RAW,
odd Bayer geometry, and unsupported black-level layouts retain LibRaw's
format-specific demosaic and geometry work, then require WebGPU color and TIFF
preparation. This is an input-contract route, not a device fallback.

## Non-goals

- Reimplement every camera-specific LibRaw decoder or geometry transform.
- Preserve experimental ONNX, native RCD, or browser CPU backends.
- Treat a fixed latency target as more important than correctness, stable
  memory use, or measured user value.
