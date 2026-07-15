# Browser RAW Alchemy Change Design

## Direction

Use pinned native and Emscripten builds of the LibRaw source used by Raw Alchemy, a Rust/WASM color and TIFF core, one serial Dedicated Worker, and a React static UI. Preserve historical behavior only in a migration test mode and make corrected-v2 the sole product default.

## Decisions

- CPU/WASM is the reference; WebGPU and browser threads are excluded.
- A pinned LibRaw post-processing source override makes color-matrix FMA order explicit across native and WASM targets.
- Full exports are sequential and avoid all full-size float intermediates.
- Creative LUTs remain readable CUBE files, are copied only after hash verification, and load on demand.
- Unknown LUT output semantics remain visible and unprofiled.
- The interface follows the flat dark editing system in root `DESIGN.md`.
