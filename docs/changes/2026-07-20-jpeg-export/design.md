# TIFF and JPEG Export Design

## Introduction

The browser export pipeline selects one stateful output encoder after RAW decoding and corrected-v2 WebGPU rendering. TIFF and JPEG share every stage before encoding.

## Background

WebGPU already emits full-resolution RGB16 in bounded bands. A Canvas JPEG route would require an additional complete RGBA8 surface, while the pinned libjpeg-turbo dependency already supports incremental scanline compression inside the processing Worker.

## Goals and Non-goals

The design adds quality-95 JPEG without a JavaScript-owned full-resolution image, a second rendering implementation, or adjustable encoder settings. Native CLI and C API surfaces remain TIFF-only.

## Detailed Design

The export command carries `tiff` or `jpeg`. A common strip adapter validates exact sample consumption and forwards the same RGB16 bands to the selected encoder. The Rust TIFF encoder writes uncompressed RGB16 strips. The LibRaw WASM module exposes a narrow libjpeg-turbo encoder that requests row-aligned bounded strips, rounds RGB16 codes to RGB8, and writes scanlines at quality 95. Both encoders return one final byte array to the Worker.

The UI owns one format state. It fixes that state for the duration of a sequential export, derives the filename extension and single-file MIME type from it, and streams batch outputs into pass-through ZIP entries.

## Trade-offs

Fixed quality 95 keeps the product choice simple and predictable. A 6000 × 4000 Chromium Worker benchmark using identical generated RGB16 input measured the streaming encoder at 866–911 ms and OffscreenCanvas at 1074–1098 ms after warm-up. The Canvas route also required a 96 MB full RGBA8 surface, so it was rejected for both time and memory efficiency.

The JPEG encoder uses the existing pinned libjpeg-turbo build instead of adding another codec dependency. JPEG remains 8-bit and lossy; TIFF remains the edit-ready output.

## Test Plan

- Verify the format selector defaults to TIFF and changes the accessible export action to JPEG.
- Verify the Worker command carries the selected format.
- Export a real full-resolution JPEG through the production page and validate its filename, markers, dimensions, quantization table, and completion message.
- Keep the existing decoded TIFF parity and batch ZIP journeys passing.

## Open Questions

None.

## Appendix

Quality 95 is passed as the libjpeg quality value `95`. RGB16-to-RGB8 conversion is `(value + 128) / 257` with integer division, which rounds to the nearest 8-bit code.
