# Browser RAW Alchemy Change Design

## Direction

Use pinned native and Emscripten builds of the LibRaw source used by Raw Alchemy, a Rust/WASM color and TIFF core, one serial Dedicated Worker, and a React static UI. Preserve historical behavior only in a migration test mode and make corrected-v2 the sole product default.

## Decisions

- CPU/WASM is the reference; WebGPU and browser threads are excluded.
- A pinned LibRaw post-processing source override makes color-matrix FMA order explicit across native and WASM targets.
- Preview LibRaw instances are short-lived and release their RAW copy and processing state after transferring RGB16 into the persistent renderer.
- Full exports are sequential; the Worker transfers only bounded source views into a stateful Rust WASM encoder, and fused color processing feeds bounded RGB16 strips to the Deflate TIFF writer without a second full-size source, float, or quantized intermediate.
- Creative LUTs remain readable CUBE files, are copied only after hash verification, and load on demand.
- Unknown LUT output semantics remain visible and unprofiled.
- The interface follows the flat dark editing system in root `DESIGN.md`.
