# RAW Alchemy Technical Design

## Introduction

The system separates deterministic computation from presentation. Rust owns color processing and TIFF encoding. Pinned LibRaw builds own RAW decoding. TypeScript owns orchestration and UI state but performs no color mathematics.

## Architecture

The workspace contains three Rust crates:

- `alchemy-core`: CUBE parsing, exposure, fixed matrices, transfer functions, tetrahedral interpolation, previews, and TIFF encoding.
- `alchemy-libraw`: a small safe Rust API over a pinned LibRaw C++ build.
- `alchemy-cli`: native RAW-to-TIFF product surface.

The browser uses one Dedicated Worker. It hosts a custom, single-threaded LibRaw WASM build and the `alchemy-core` WASM build. Commands are serialized. The worker caches one half-size RGB16 preview; EV and LUT changes rerun only the Rust color core. Full-resolution export decodes on demand and runs sequentially. Color processing feeds bounded RGB16 strips directly to a streaming Deflate TIFF writer. Batch TIFFs enter a pass-through ZIP incrementally, avoiding redundant compression and contiguous archive copies while retaining the final Blob chunks required by portable browser downloads.

`alchemy-core/include/alchemy.h` is the stable corrected-v2 C surface. It accepts the same decoded RGB16 contract, returns an owned TIFF buffer with stable status codes, and pairs allocation with `alchemy_free_buffer`. The Rust API remains the native CLI's direct integration surface.

## Invariants

- Decoded input is interleaved RGB16 in explicitly named `LibRaw ProPhoto D65 Linear`.
- Browser and native LibRaw builds use source revision `0029e79482c3a133d3de72ff51117ca7d0a4ff43` and libjpeg-turbo revision `4e151a4ad91001b3aa8c2ece2205c15f487ce320`. Both use Blend highlight mode, camera white balance, AAHD, 16-bit output, linear gamma, and no auto-brightening.
- Both LibRaw builds replace one pinned post-processing source unit with an otherwise identical local copy whose color-matrix dot products use explicit fused multiply-add order. This preserves the native/Python result exactly on WASM, which has no scalar hardware FMA.
- The canonical core is single-threaded f32 WASM SIMD and never uses `fast-math`.
- Preview and export share one pipeline; only input resolution and output sink differ.
- TIFF output is Deflate-compressed RGB16 and never creates a full-size float or quantized image.
- Full-resolution export holds one decoded RGB16 image, one encoded output, and bounded strip buffers at a time.

## Versioned behavior

`legacy-python-v1` preserves Raw Alchemy 0.4.2 migration behavior: D50 misinterpretation, Camera-Match Boost, pre-Log clipping, float64 LUT coordinates, truncating uint16 export quantization, and the preview-only BT.709-to-sRGB display conversion. It exists for tests and migration evidence.

`corrected-v2` is the product default. It uses the D65 contract, preserves negative V-Log inputs, removes the creative boost, uses f32 tetrahedral interpolation, and rounds uint16 output.

## Asset and output semantics

`assets/luts.json` is the versioned LUT manifest. The build verifies each source SHA-256 before copying it to the static bundle. Adapter LUTs are excluded. Since the creative CUBE files do not prove an output gamut or transfer function, encoded LUT values are shown directly on an sRGB canvas and exported without a false ICC profile.

## Operational design

LibRaw WASM is built in `emscripten/emsdk:5.0.7` with C++17, portable O3 arithmetic, explicit color-matrix FMA, one worker environment, memory growth, and exception handling. Its JPEG dependency is built from the same pinned libjpeg-turbo source as native decoding. Build IDs include the LibRaw, wrapper, libjpeg-turbo, FMA override, and toolchain revisions. The separate Rust color core enables WASM SIMD. Rust is pinned by `rust-toolchain.toml`; JavaScript and Python baseline dependencies use lockfiles. The TIFF writer receives approximately 1 MB of quantized samples per strip and emits each compressed block immediately; the final encoded `Vec` remains necessary for the current Rust/WASM return contract.

## Alternatives

WebGPU is excluded because a CPU/WASM reference is easier to prove and fast enough for the first version. Browser pthreads are excluded to avoid cross-origin isolation and state complexity. A handwritten TIFF container is excluded in favor of a typed pure-Rust writer whose public block API performs Deflate compression and TIFF offset finalization while processing supplies one bounded strip at a time.
