# Browser RAW Alchemy Change Design

## Direction

Use pinned native and Emscripten builds of the LibRaw source used by Raw Alchemy, a Rust/WASM color and TIFF core, one serial Dedicated Worker, and a React static UI. Preserve historical behavior only in a migration test mode and make corrected-v2 the sole product default.

## Decisions

- CPU/WASM is the reference; WebGPU and browser threads are excluded.
- Corrected color matrices use pinned LibRaw's numerical ProPhoto D65 basis rather than nominal ProPhoto primaries paired with a different white point.
- Pinned LibRaw builds use signed `char`, disable implicit floating-point contraction, make color-matrix FMA order explicit, and promote AAHD's float gamma-table power operation to double across native and WASM targets.
- The project-owned browser LibRaw wrapper exposes only metadata, optional thumbnail bytes, image dimensions, and bounds-checked zero-copy RGB16 views. It releases the input RAW and intermediate decoder state once the processed image exists.
- Preview LibRaw instances are short-lived. Rust requests only the half-size source rows that contribute to a longest-edge-1600 cache; the persistent renderer retains those sampled RGB16 pixels and releases the LibRaw image after construction.
- Main-thread preview painting reinterprets each transferred RGBA8 result as a clamped Canvas view instead of allocating another complete Base and LUT copy on every rerender.
- Full exports are sequential; the Worker reads only bounded LibRaw views into a stateful Rust WASM encoder, and fused color processing feeds bounded RGB16 strips to the Deflate TIFF writer without a JavaScript whole-image copy or second full-size source, float, or quantized intermediate.
- Creative LUTs remain readable CUBE files, are copied only after hash verification, and load on demand.
- Unknown LUT output semantics remain visible and unprofiled.
- The interface follows the flat dark editing system in root `DESIGN.md`.
