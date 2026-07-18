# Processing Design

## Model

`ColorPipeline` is an immutable corrected-v2 recipe containing EV and one parsed LUT. It accepts decoded RGB16 and exposes native preview, RGB16 reference output, and TIFF output for tests, the CLI, and the C API. Fixed matrices and transfer constants are checked into source rather than resolved from runtime color-space registries. Corrected input matrices are derived from pinned LibRaw's actual `sRGB → ProPhoto D65` constant; the sRGB matrix is its inverse, and the V-Gamut matrix additionally uses the published V-Gamut primaries with LibRaw's explicit D65 white.

The C ABI exposes only corrected-v2 TIFF rendering. It returns a status plus a Rust-owned byte buffer, with one explicit paired free function. Stable integer statuses cross the ABI; Rust error details remain in the native Rust API.

Corrected processing uses f32 throughout and maps cleanly to WASM SIMD.

Native and WASM LibRaw builds use signed `char`, define signed-integer overflow as two's-complement wrapping, disable implicit floating-point contraction, and replace upstream `postprocessing_utils.cpp` with the pinned local copy in `alchemy-libraw`. Only the final color-matrix dot products differ: their fused operation order is explicit, so WASM reproduces the native/Python RGB16 result exactly. AAHD is compiled with a narrow project-owned math override that promotes its float gamma-table power operation to double; this removes target-libm rounding differences while leaving its existing double operation unchanged. Defined wrapping is also part of the decode contract because AAHD gradient squares can overflow `int`; without it, native and WASM compilers may choose different interpolation directions.

The browser asset build verifies pinned CUBE sources and emits compact float32 LUT files with runtime SHA-256 values. Browser loading verifies the fetched compact bytes and passes each asset through one WASM binding. Rust validates the binary structure once, and the Worker caches parsed LUTs by identifier for the session. Preview and export reuse those values without runtime text parsing or one binding call per uploaded word.

## Memory

The project-owned browser LibRaw wrapper exposes only bounds-checked views. Preview resampling coordinates live in Rust. The Worker transfers only rows contributing to LibRaw's display-sized image. The completed longest-edge-1024 source moves once from the temporary Rust source builder into a persistent packed RGB16 WebGPU storage buffer, then the temporary source and short-lived LibRaw decoder are released. EV changes pass one scalar. LUT changes reuse a session-cached parse, replace the resident LUT buffer, and omit the unchanged Base output. Neither path resends source pixels. TIFF rendering fuses GPU color operations in bounded RGB16 batches. A stateful encoder writes each completed GPU batch into approximately 1 MB strips before owning offset and directory finalization. No JavaScript-owned full-resolution decoded image, full-size float image, quantized image, fallback preview source, or second color source is created.

## Baseline

`tests/fixtures/corrected-v2-reference.json` is the independent float64 color oracle. Native Rust tests verify Base RGBA8, LUT RGBA8, RGB16, and TIFF output against it. A test-only browser entry runs the same cases through the production WebGPU Preview shader under SwiftShader. Both accept at most one output code of controlled quantization difference.
