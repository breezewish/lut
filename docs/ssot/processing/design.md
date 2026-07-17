# Processing Design

## Model

`ColorPipeline` is an immutable recipe containing EV, processing mode, and one parsed LUT. It accepts decoded RGB16 and exposes preview, RGB16 reference output, and TIFF output. Fixed matrices and transfer constants are checked into source rather than resolved from runtime color-space registries. Corrected input matrices are derived from pinned LibRaw's actual `sRGB → ProPhoto D65` constant; the sRGB matrix is its inverse, and the V-Gamut matrix additionally uses the published V-Gamut primaries with LibRaw's explicit D65 white.

The C ABI exposes only corrected-v2 TIFF rendering. It returns a status plus a Rust-owned byte buffer, with one explicit paired free function. Stable integer statuses cross the ABI; Rust error details remain in the native Rust API.

Corrected processing uses f32 throughout and maps cleanly to WASM SIMD. Legacy processing has isolated f64 matrix and LUT-coordinate operations only where required to match the Python baseline.

Native and WASM LibRaw builds use signed `char`, define signed-integer overflow as two's-complement wrapping, disable implicit floating-point contraction, and replace upstream `postprocessing_utils.cpp` with the pinned local copy in `alchemy-libraw`. Only the final color-matrix dot products differ: their fused operation order is explicit, so WASM reproduces the native/Python RGB16 result exactly. AAHD is compiled with a narrow project-owned math override that promotes its float gamma-table power operation to double; this removes target-libm rounding differences while leaving its existing double operation unchanged. Defined wrapping is also part of the decode contract because AAHD gradient squares can overflow `int`; without it, native and WASM compilers may choose different interpolation directions.

The browser asset build verifies pinned CUBE sources and emits compact float32 LUT files with runtime SHA-256 values. Browser loading verifies the fetched compact bytes and passes each asset through one WASM binding. Rust validates the binary structure once, and the Worker caches parsed LUTs by identifier for the session. Preview and export reuse those values without runtime text parsing or one binding call per uploaded word.

## Memory

The project-owned browser LibRaw wrapper retains one processed RGB16 allocation and exposes only bounds-checked zero-copy views into it. Once that allocation exists, the wrapper releases the input RAW, mosaic, and four-channel decoder state. Preview resampling coordinates live in Rust. The Worker transfers only contributing rows from LibRaw's half-size image, and the persistent Rust WASM renderer keeps only the resulting longest-edge-1024 source plus the current parsed LUT. The short-lived LibRaw decoder is then released. EV changes pass one scalar. LUT changes reuse a session-cached parse, replace the renderer's LUT, and omit the unchanged Base output. Neither path resends source pixels. TIFF rendering fuses color operations per pixel into approximately 1 MB RGB16 strips. The browser uses a stateful encoder so `wasm-bindgen` copies only the current source view rather than the complete decoded image. The typed TIFF writer writes each uncompressed strip immediately before owning offset and directory finalization. No JavaScript-owned decoded image, full-size float, quantized image, or second color-WASM source image is created; only the LibRaw RGB16 source, bounded row or strip temporaries, the display-sized preview cache, and final encoded output coexist at their respective phases.

## Baseline

`baselines/legacy-python-v1` locks Python 3.11, Raw Alchemy and dependency revisions, the complete decode and processing recipe, all 27 creative LUT hashes and order, array types and shapes, every checkpoint hash, and a compressed NPZ fixture. Regeneration rejects source repositories at different commits, and normal tests verify that the committed RAW and NPZ bytes match the manifest. Rust reads the committed fixture directly; normal tests do not execute Python or require the original external repository.

The baseline covers decode RGB16, exposure, Boost, gamut matrix, V-Log, every supported LUT, final uint16 export, and the distinct half-size preview path. Legacy preview alone performs the historical BT.709-to-sRGB display conversion after LUT output; export does not. Decode is exact. Float tolerances are stage-local. LUT maximum absolute error is `2e-6`; final export and preview maximum error is one code value.
