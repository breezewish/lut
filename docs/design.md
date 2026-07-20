# LUTify Technical Design

## Introduction

The system separates deterministic computation from presentation. Rust owns color processing and TIFF encoding. Pinned LibRaw and libjpeg-turbo builds own RAW decoding and JPEG encoding. TypeScript owns orchestration and UI state but performs no color mathematics.

## Architecture

The workspace contains three Rust crates:

- `lutify-core`: CUBE parsing, exposure, fixed matrices, transfer functions, tetrahedral interpolation, previews, and TIFF encoding.
- `lutify-libraw`: a small safe Rust API over a pinned LibRaw C++ build.
- `lutify-cli`: native RAW-to-TIFF product surface.

LUTify is distinct from upstream [RAW Alchemy](https://github.com/shenmintao/Raw-Alchemy). The `vendor/Raw-Alchemy` gitlink pins the upstream source used for migration evidence and test baselines. Upstream paths, names, and provenance remain unchanged; all project-owned modules and public surfaces use the LUTify name.

The browser uses one Dedicated Worker. It hosts the regular LibRaw WASM build, a lazily loaded pthread build for proven parallel decoders, and the `lutify-core` WASM build. Commands are serialized. LibRaw's decoder identity and format metadata, rather than camera naming, select the pthread build for Fujifilm compressed, Panasonic C8, Canon CRX, Sony ARW2, and large 8–15-bit single-sample packed DNG input. The minimal project-owned wrapper exposes metadata, an optional copied JPEG thumbnail, image dimensions, sensor metadata, and bounds-checked views. Preview asks LibRaw to build only the display-sized source cells that contribute to a longest-edge-1024 result. Rust owns the row-resampling coordinates. WebGPU retains six recent RGB16 photo sources, one shared output/readback workspace, and a 32 MiB LRU of LUT uploads shared by Preview and Export. Removing a file releases only its resources; clearing the queue releases the complete photo cache.

Initial decode uploads one longest-edge-1024 linear source, meters a per-photo automatic exposure baseline on WebGPU, and publishes a longest-edge-384 frame before the settled longest-edge-1024 frame. EV and LUT interactions publish a Worker-created 256px bitmap before refining at 1024px. Interactive rerenders use latest-wins scheduling: one render may run and at most one newer recipe waits, so obsolete slider values cannot form an unbounded Worker queue. LUT changes omit the unchanged Base pane. Rerenders neither copy the source image nor decode RAW again, and only the exact current 1024px recipe enables export.

Full-resolution export reuses a Preview-unpacked sensor mosaic when a strict WebGPU demosaic input is compressed. Retained mosaics share one 64 MiB budget across the photo LRU; uncompressed input, evicted mosaics, and unsupported geometry decode on demand. Even, unrotated, standard three-color Bayer inputs use tiled WebGPU LibRaw-parity AAHD. Standard, unrotated three-color X-Trans inputs use tiled WebGPU LibRaw-parity three-pass Markesteijn. Other supported RAW contracts keep LibRaw's demosaic and geometry handling, then enter required WebGPU color through bounded zero-copy views. Every route streams rendered RGB16 strips into the selected encoder. Rust writes uncompressed TIFF strips; pinned libjpeg-turbo converts bounded strips to RGB8 scanlines and writes quality-95 JPEG data. Batch files enter a pass-through ZIP incrementally, avoiding contiguous archive copies while retaining only the final Blob chunks required by portable browser downloads.

`lutify-core/include/lutify.h` is the stable corrected-v2 C surface. It accepts the same decoded RGB16 contract, returns an owned TIFF buffer with stable status codes, and pairs allocation with `lutify_free_buffer`. The Rust API remains the native CLI's direct integration surface.

## Invariants

- Decoded input is interleaved RGB16 in explicitly named `LibRaw ProPhoto D65 Linear`. Its numerical basis is defined by pinned LibRaw's `prophoto_rgb` transform, not by assigning a D65 white point to nominal ProPhoto primaries.
- Browser and native LibRaw builds use source revision `0029e79482c3a133d3de72ff51117ca7d0a4ff43` and libjpeg-turbo revision `4e151a4ad91001b3aa8c2ece2205c15f487ce320`. Both use Blend highlight mode, camera white balance, AAHD, 16-bit output, linear gamma, and no auto-brightening.
- Both LibRaw builds use signed `char`, define signed-integer overflow as two's-complement wrapping, and disable implicit floating-point contraction. They replace one pinned post-processing source unit with an otherwise identical local copy whose color-matrix dot products use explicit fused multiply-add order, and compile AAHD with a narrow override that promotes its float gamma-table power operation to double. These constraints remove compiler and C-library variation while preserving intentional fused operations. Defined wrapping is required because AAHD's gradient squares can exceed `int`; leaving that overflow undefined changes interpolation direction across targets.
- The canonical core is single-threaded f32 WASM SIMD and never uses `fast-math`.
- Browser Preview and Export use the same cached automatic baseline plus relative EV. They share the required WebGPU exposure, matrices, V-Log, and LUT interpolation contract. The independent Rust implementation remains a native test oracle and C/CLI surface; its EV is explicit and it is not exported as a browser preview or color fallback.
- TIFF output is uncompressed RGB16. JPEG output is 8-bit at quality 95. Neither route creates a full-size float or quantized intermediate image.
- Full-resolution export holds one LibRaw-owned processed RGB16 image, one encoded output, and bounded source and quantized strip buffers at a time; JavaScript owns no complete decoded copy and no second full-image RGB16 allocation crosses into the color WASM.

## Processing behavior

`corrected-v2` is the only processing contract. It uses the D65 input basis, preserves negative V-Log inputs, uses f32 tetrahedral interpolation, and rounds uint16 output.

## Asset and output semantics

`assets/luts.json` is the versioned source LUT manifest. The build verifies each source SHA-256 before encoding a compact float32 runtime asset and publishing its generated hash. Adapter LUTs are excluded. Since the creative CUBE files do not prove an output gamut or transfer function, encoded LUT values are shown directly on an sRGB canvas and exported without a false ICC profile.

## Operational design

LibRaw WASM is built in `emscripten/emsdk:5.0.7` with C++17, portable O3 arithmetic, signed `char`, defined signed-integer wrapping, disabled implicit contraction, explicit color-matrix FMA, memory growth, and exception handling. The regular build remains single-threaded. The optional pthread build uses the current Worker plus at most three pooled workers and requires the production origin to be cross-origin isolated. Build containers use the host UID and GID so generated files remain reusable and removable by local and CI callers. Its JPEG dependency is built from the same pinned libjpeg-turbo source as native decoding. Build IDs include the pinned sources, wrapper, arithmetic overrides, pthread patch and helper, compilation profile, and toolchain revision. The separate Rust color core enables WASM SIMD. Rust is pinned by `rust-toolchain.toml`; JavaScript dependencies use the npm lockfile. Both stateful output encoders declare the exact next source-strip size and validate every write. TIFF appends each uncompressed RGB16 block immediately. JPEG rounds RGB16 to RGB8 in bounded memory and writes scanlines directly. Each final encoded buffer remains necessary for the Worker download contract.

The production bundle is a static GitHub Pages project site. Vite's configurable base path prefixes the entry bundle, Worker, WASM, manifest, and LUT requests consistently. Rust, lightweight web checks, and browser production tests run as independent verification jobs. The browser job tests the repository-path bundle and uploads that exact `dist/` as an immutable Pages artifact. A `main` push deploys it only after every verification job succeeds, without rebuilding or committing generated output.

The asset build verifies each pinned source CUBE and emits a compact float32 LUT with its own runtime SHA-256. The Worker starts every hash-versioned request at launch, verifies the fetched bytes, and passes each used asset through one WASM binding. Rust validates the binary structure once, the Worker caches parsed LUTs for the session, and the redundant downloaded bytes are released after parsing. Preview and export share uploaded buffers through a 32 MiB per-device LRU without runtime text parsing or hundreds of thousands of scalar binding calls.

## Alternatives

WebGPU is required for browser Preview and color processing. There is no CPU browser fallback because maintaining two production renderers would increase complexity and hide unsupported environments. A global pthread LibRaw build is excluded because it regresses sequential decoders; the isolated pthread build is loaded only for decoder functions with proven independent blocks, planes, tiles, or rows. A handwritten TIFF container is excluded in favor of a typed pure-Rust writer whose public block interface validates strips and owns TIFF offset and directory finalization.
