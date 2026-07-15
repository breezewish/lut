# Processing Design

## Model

`ColorPipeline` is an immutable recipe containing EV, processing mode, and one parsed LUT. It accepts decoded RGB16 and exposes preview, RGB16 reference output, and TIFF output. Fixed matrices and transfer constants are checked into source rather than resolved from runtime color-space registries.

The C ABI exposes only corrected-v2 TIFF rendering. It returns a status plus a Rust-owned byte buffer, with one explicit paired free function. Stable integer statuses cross the ABI; Rust error details remain in the native Rust API.

Corrected processing uses f32 throughout and maps cleanly to WASM SIMD. Legacy processing has isolated f64 matrix and LUT-coordinate operations only where required to match the Python baseline.

Native and WASM LibRaw builds replace upstream `postprocessing_utils.cpp` with the pinned local copy in `alchemy-libraw`. Only the final color-matrix dot products differ: their fused operation order is explicit, so WASM reproduces the native/Python RGB16 result exactly instead of inheriting target-dependent compiler contraction.

## Memory

The project-owned browser LibRaw wrapper retains one processed RGB16 allocation and exposes only bounds-checked zero-copy views into it. Once that allocation exists, the wrapper releases the input RAW, mosaic, and four-channel decoder state. Preview resampling coordinates live in Rust. The Worker transfers only contributing rows from LibRaw's half-size image, and the persistent Rust WASM renderer keeps only the resulting longest-edge-1600 source plus the current parsed LUT. The short-lived LibRaw decoder is then released. EV changes pass one scalar; LUT changes parse and replace only the LUT. Neither path resends source pixels. TIFF rendering fuses color operations per pixel into approximately 1 MB RGB16 strips. The browser uses a stateful encoder so `wasm-bindgen` copies only the current source view rather than the complete decoded image. The typed TIFF writer Deflate-compresses and writes each strip immediately, then owns offset and directory finalization. No JavaScript-owned decoded image, full-size float, quantized image, or second color-WASM source image is created; only the LibRaw RGB16 source, bounded row or strip temporaries, the display-sized preview cache, and final encoded output coexist at their respective phases.

## Baseline

`baselines/legacy-python-v1` locks Python 3.11, Raw Alchemy and dependency revisions, recipe hashes, all 27 creative LUT hashes and order, array types and shapes, every checkpoint hash, and a compressed NPZ fixture. Rust reads the committed fixture directly; normal tests do not execute Python or require the original external repository.

The baseline covers decode RGB16, exposure, Boost, gamut matrix, V-Log, every supported LUT, final uint16 export, and the distinct half-size preview path. Legacy preview alone performs the historical BT.709-to-sRGB display conversion after LUT output; export does not. Decode is exact. Float tolerances are stage-local. LUT maximum absolute error is `2e-6`; final export and preview maximum error is one code value.
