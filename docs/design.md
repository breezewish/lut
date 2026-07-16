# RAW Alchemy Technical Design

## Introduction

The system separates deterministic computation from presentation. Rust owns color processing and TIFF encoding. Pinned LibRaw builds own RAW decoding. TypeScript owns orchestration and UI state but performs no color mathematics.

## Architecture

The workspace contains three Rust crates:

- `alchemy-core`: CUBE parsing, exposure, fixed matrices, transfer functions, tetrahedral interpolation, previews, and TIFF encoding.
- `alchemy-libraw`: a small safe Rust API over a pinned LibRaw C++ build.
- `alchemy-cli`: native RAW-to-TIFF product surface.

The browser uses one Dedicated Worker. It hosts a custom, single-threaded LibRaw WASM build and the `alchemy-core` WASM build. Commands are serialized. The minimal project-owned LibRaw wrapper exposes metadata, an optional copied JPEG thumbnail, image dimensions, and bounds-checked RGB16 memory views only; it has no whole-image JavaScript return API. After creating the processed RGB16 allocation it immediately releases the input RAW, mosaic, and four-channel decoder state. For preview, Rust owns the resampling coordinates and requests only contributing rows from LibRaw's half-size RGB16 image. The persistent renderer keeps only the resulting longest-edge-1024 RGB16 source and the selected parsed LUT, then the Worker destroys the short-lived LibRaw instance. Removing the active file or clearing the queue explicitly frees this renderer. EV changes pass only the new scalar, while LUT changes parse and replace only the LUT. Interactive rerenders use latest-wins scheduling: one render may run and at most one newer recipe waits, so obsolete slider values cannot form an unbounded Worker queue. Neither rerender path copies the source image or decodes RAW again, and the main thread reinterprets transferred RGBA8 as a clamped Canvas view without another complete preview copy. Full-resolution export decodes on demand and runs sequentially. The Worker reads approximately 1 MB zero-copy views from LibRaw and passes them into a stateful Rust WASM encoder, so neither JavaScript nor the color WASM owns a second complete decoded image. Color processing feeds each bounded quantized strip directly to a streaming Deflate TIFF writer. Batch TIFFs enter a pass-through ZIP incrementally, avoiding redundant compression and contiguous archive copies while retaining the final Blob chunks required by portable browser downloads.

`alchemy-core/include/alchemy.h` is the stable corrected-v2 C surface. It accepts the same decoded RGB16 contract, returns an owned TIFF buffer with stable status codes, and pairs allocation with `alchemy_free_buffer`. The Rust API remains the native CLI's direct integration surface.

## Invariants

- Decoded input is interleaved RGB16 in explicitly named `LibRaw ProPhoto D65 Linear`. Its numerical basis is defined by pinned LibRaw's `prophoto_rgb` transform, not by assigning a D65 white point to nominal ProPhoto primaries.
- Browser and native LibRaw builds use source revision `0029e79482c3a133d3de72ff51117ca7d0a4ff43` and libjpeg-turbo revision `4e151a4ad91001b3aa8c2ece2205c15f487ce320`. Both use Blend highlight mode, camera white balance, AAHD, 16-bit output, linear gamma, and no auto-brightening.
- Both LibRaw builds use signed `char`, define signed-integer overflow as two's-complement wrapping, and disable implicit floating-point contraction. They replace one pinned post-processing source unit with an otherwise identical local copy whose color-matrix dot products use explicit fused multiply-add order, and compile AAHD with a narrow override that promotes its float gamma-table power operation to double. These constraints remove compiler and C-library variation while preserving intentional fused operations. Defined wrapping is required because AAHD's gradient squares can exceed `int`; leaving that overflow undefined changes interpolation direction across targets.
- The canonical core is single-threaded f32 WASM SIMD and never uses `fast-math`.
- Preview and export share one pipeline; only input resolution and output sink differ.
- TIFF output is Deflate-compressed RGB16 and never creates a full-size float or quantized image.
- Full-resolution export holds one LibRaw-owned processed RGB16 image, one encoded output, and bounded source and quantized strip buffers at a time; JavaScript owns no complete decoded copy and no second full-image RGB16 allocation crosses into the color WASM.

## Versioned behavior

`legacy-python-v1` preserves Raw Alchemy 0.4.2 migration behavior: D50 misinterpretation, Camera-Match Boost, pre-Log clipping, float64 LUT coordinates, truncating uint16 export quantization, and the preview-only BT.709-to-sRGB display conversion. It exists for tests and migration evidence.

`corrected-v2` is the product default. It uses the D65 contract, preserves negative V-Log inputs, removes the creative boost, uses f32 tetrahedral interpolation, and rounds uint16 output.

## Asset and output semantics

`assets/luts.json` is the versioned LUT manifest. The build verifies each source SHA-256 before copying it to the static bundle. Adapter LUTs are excluded. Since the creative CUBE files do not prove an output gamut or transfer function, encoded LUT values are shown directly on an sRGB canvas and exported without a false ICC profile.

## Operational design

LibRaw WASM is built in `emscripten/emsdk:5.0.7` with C++17, portable O3 arithmetic, signed `char`, defined signed-integer wrapping, disabled implicit contraction, explicit color-matrix FMA, one worker environment, memory growth, and exception handling. Its JPEG dependency is built from the same pinned libjpeg-turbo source as native decoding. Build IDs include the LibRaw and libjpeg-turbo revisions, project-owned wrapper, FMA override, AAHD math override content hashes, compilation profile, and toolchain revision. The separate Rust color core enables WASM SIMD. Rust is pinned by `rust-toolchain.toml`; JavaScript and Python baseline dependencies use lockfiles. A stateful WASM TIFF encoder declares the exact next source-strip size, validates every write, and emits each compressed block immediately. The final encoded `Vec` remains necessary for the current Rust/WASM return contract.

The Worker verifies each LUT's SHA-256 over the fetched bytes and passes those same bytes through the WASM bulk-array binding. Rust validates UTF-8 before parsing CUBE data. The browser never materializes a second megabyte-scale LUT string or copies it into WASM one character at a time.

## Alternatives

WebGPU is excluded because a CPU/WASM reference is easier to prove and fast enough for the first version. Browser pthreads are excluded to avoid cross-origin isolation and state complexity. A handwritten TIFF container is excluded in favor of a typed pure-Rust writer whose public block API performs Deflate compression and TIFF offset finalization while processing supplies one bounded strip at a time.
