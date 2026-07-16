# RAW Decode Performance Diagnosis

## Introduction

This report separates browser preview, full RAW decode, and full export costs.
It measures the production Dedicated Worker and isolates LibRaw AHD, DCB, and
AAHD on the same RAW. It also measures the Studio branch's RCD Bayer and
Markesteijn X-Trans decode paths on the same CPU host.

The recommendation is to evaluate AHD as the only near-term decoder change.
Do not enable browser pthreads or port the Studio decoder yet. AHD reduces the
measured full LibRaw decode from 10.27 s to 5.29 s, but it does not improve the
half-size preview and it changes localized image values materially. A release
must therefore pass the cross-camera quality gate described below. Independently,
color processing and Deflate consume about 13.8 s of a warm 25.2 s export and
remain the larger optimization opportunity without a demosaic quality tradeoff.

## Background

The browser uses a single-threaded LibRaw WASM build with `user_qual=12`
(AAHD). Preview uses LibRaw half-size output, samples only source rows that
contribute to a longest-edge-1024 cache, and renders that cache in the Rust
color WASM. Export performs a separate full-size LibRaw decode, applies color
and the LUT in bounded strips, Deflate-compresses those strips into TIFF, and
finally constructs a browser `Blob`.

Studio at `c982314` is a different pipeline. Its normal Bayer path performs
sensor preprocessing, ONNX RCD demosaic, white balance, and a camera-to-working
matrix. X-Trans uses ONNX Markesteijn. These float32 results are not numerical
replacements for the browser's LibRaw ProPhoto RGB16 output.

## Goals and Non-goals

### Goals

- Attribute browser time to input copy, LibRaw unpack, preprocessing,
  demosaic, LibRaw color conversion, RGB16 creation, Rust color processing,
  Deflate, and Blob construction.
- Compare LibRaw AHD, DCB, and AAHD with identical decode parameters and RAW
  input.
- Measure Studio RCD and Markesteijn decode paths and state the provider and
  fallback path actually used.
- Define distinct performance metrics for preview, full decode, and export.
- Recommend a next direction from measured evidence.

### Non-goals

- This diagnosis does not change the production demosaic algorithm.
- It does not claim that pairwise image similarity is ground-truth quality.
- It does not estimate GPU performance from CPU results.
- It does not claim cross-camera quality from one Bayer and one X-Trans RAW.

## Metric Definitions

| Metric            | Start                                  | End                                                      | Included                                                                                                          |
| ----------------- | -------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Processed preview | File selection accepted by the page    | Base canvas is visible and the Worker timing mark exists | File read, Worker transfer, half-size decode, preview source sampling, color/LUT render, reply, canvas update     |
| Full RAW decode   | LibRaw wrapper receives the input view | RGB16 processed image is available                       | WASM input copy, open, unpack, LibRaw processing, demosaic, LibRaw color conversion, RGB16 creation               |
| Full export       | User activates `Export selected`       | Browser download event fires                             | File read, Worker transfer, full decode, strip color/LUT processing, TIFF Deflate, reply, Blob, download dispatch |

The production Worker reports durations using its monotonic Performance API.
LibRaw demosaic and color boundaries use the actual `dcraw_process()` callbacks
immediately before and after interpolation and RGB conversion. Rust strip
rendering and TIFF writing are separate calls, so color and Deflate are not
inferred by subtraction. Blob time is measured on the main thread.

Candidate acceptance budgets for initial decode and export of the 6240 × 4168 Sony fixture are:

- Initial processed preview: cold p95 below 5 s and warm p95 below 3.5 s.
- Full RAW decode: cold p95 below 15 s and warm p95 below 11 s.
- Full export: warm p95 below 30 s, with decode below 11 s, color below
  5.5 s, Deflate below 10.5 s, and Blob below 100 ms.

These initial-load budgets do not define interactive EV or LUT latency. The
stricter progressive-preview budgets are normative in
`docs/ssot/web/spec.md`.

An acceptance run requires at least 20 measured samples after one warm-up.
The five-sample diagnosis below reports medians and observed ranges; it does
not treat an interpolated five-sample p95 as a stable percentile.

## Test Environment

### Host

- AWS ARM64 VM, Linux `6.17.0-1013-aws`.
- 8 × ARM Neoverse-N1 cores, one thread per core, 32 MiB shared L3.
- 30 GiB RAM and 31 GiB swap.
- No CUDA device or NVIDIA runtime was present.

### Browser pipeline

- Project base: `3820286044442432ce105a7da7fedc2b855191b3`.
- LibRaw: `0029e79482c3a133d3de72ff51117ca7d0a4ff43`.
- Emscripten SDK 5.0.7, optimization `-O3`, no pthreads.
- Node.js 24.14.1 and Playwright Chromium 1194 headless shell.
- Production Vite bundle served over HTTPS.

### Studio pipeline

- Studio: `c9823146ba674be52d62f4c55b4c649f796bafd0`
  (`studio-v0.6.0-pre7`).
- Python 3.11.15, rawpy 0.27.0, ONNX Runtime 1.27.0.
- `CPUExecutionProvider` was the provider actually used.
- The checkout did not contain the Linux RawSpeed shared library. The pinned
  `rawspeedpy` package returned no decode, so both Studio measurements used the
  real rawpy fallback path. This is a reported limitation, not a silent
  substitution.

### Fixtures

| Fixture            | Use                                    | Size and dimensions           | Provenance                                                                                           |
| ------------------ | -------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| Sony ILME-FX30 ARW | Browser, LibRaw algorithms, Studio RCD | 31,793,152 bytes; 6240 × 4168 | Repository fixture; SHA-256 `3b4dca9296944931a0deb4b6456685985e326aef884c32d9c5df4fc9f64d7e2c`       |
| Fujifilm X-T1 RAF  | Studio Markesteijn                     | 33,806,336 bytes; 4934 × 3296 | raw.pixls.us CC0 fixture; SHA-256 `e994a1fd6e87e392432fe146a35b0b88584dc2bd50bee2c8c7e886ac2b59fcde` |

## Method

The browser benchmark uses the real production page, `ProcessingClient`,
Dedicated Worker, LibRaw WASM, color WASM, TIFF encoder, Blob, and download
event. The first run in a new page is cold. Four subsequent runs reuse the
same initialized Worker and WASM runtimes; each removes the previous queue item
and selects the fixture by filesystem path. Playwright protocol buffer upload
time is therefore excluded.

The algorithm benchmark initializes the production LibRaw WASM once. For each
algorithm it discards one warm-up and records five decodes. Every algorithm
uses the same camera white balance, matrix, ProPhoto D65 output, 16-bit linear
output, highlight blend, no automatic brightness, and full-size Sony input.
It also renders the 1400 × 1000 crop at `(x=2400, y=1500)`, containing
oblique bridge rails and small repeating foliage, through a fixed two-stop
linear exposure and sRGB transfer for a 1:1 visual check. The benchmark records
these crop coordinates in its JSON output.

Studio runs one warm-up and five measurements in one process, preserving the
ONNX session. The benchmark wraps the demosaic function selected by the real
`_rawpy_decode_to_prophoto()` entry point, rather than invoking a model with
synthetic tensors.

## Results

### Production browser boundaries

| Boundary or stage                    | Cold run | Warm median | Warm observed range |
| ------------------------------------ | -------: | ----------: | ------------------: |
| Processed preview, wall              |   4.26 s |      2.00 s |         1.92–3.00 s |
| Preview Worker total                 |   2.89 s |      1.24 s |         1.23–1.84 s |
| Preview half-size LibRaw             |   2.01 s |      0.84 s |         0.83–1.16 s |
| Preview color/LUT render             |   0.56 s |      0.40 s |         0.40–0.67 s |
| Full export, wall                    |  30.38 s |     25.20 s |       23.90–27.72 s |
| Export Worker total                  |  29.35 s |     24.60 s |       23.39–26.92 s |
| Full LibRaw decode                   |  14.67 s |     11.15 s |       10.11–11.98 s |
| Rust color/LUT strips                |   5.45 s |      5.10 s |         4.73–5.52 s |
| TIFF Deflate                         |   9.23 s |      8.69 s |         7.87–9.42 s |
| Blob construction, 122,546,827 bytes |    50 ms |       54 ms |            49–60 ms |

The warm export Worker is almost completely explained by three stages. The
independently computed warm medians are LibRaw 45.3%, color/LUT 20.7%, and
Deflate 35.3% of the Worker median; the percentages do not add exactly because
each stage median is computed independently. Blob construction is about 0.22%.

### Full LibRaw phase detail

| Stage                        | Warm median |
| ---------------------------- | ----------: |
| WASM input copy              |      2.8 ms |
| Unpack                       |    264.1 ms |
| Pre-demosaic processing      |    600.0 ms |
| AAHD                         |  8,853.5 ms |
| Highlight/post-demosaic work |    137.5 ms |
| LibRaw color conversion      |  1,103.8 ms |
| RGB16 creation               |    154.4 ms |
| Full decode total            | 11,148.7 ms |

Input copy and RGB16 creation are not meaningful optimization targets. AAHD is
79% of full decode, but about 35% of complete export. Half-size preview skips
normal full-resolution interpolation: its measured demosaic boundary is only
about 11 ms. Changing AAHD therefore does not improve the current preview.

### LibRaw algorithm comparison

| Algorithm             | Full decode median | Demosaic median | Change from AAHD full decode |
| --------------------- | -----------------: | --------------: | ---------------------------: |
| AHD (`user_qual=3`)   |             5.29 s |          3.19 s |             −4.97 s (−48.4%) |
| DCB (`user_qual=4`)   |             7.45 s |          5.33 s |             −2.82 s (−27.5%) |
| AAHD (`user_qual=12`) |            10.27 s |          8.18 s |                     baseline |

All non-demosaic phases remain effectively constant. Replacing AAHD with AHD
predicts a warm export Worker near 19.6 s if other stages remain unchanged.
This is a stage-based projection, not a measured AHD production export.

These quality values select distinct algorithms only for Bayer. On the
Fujifilm X-Trans fixture, LibRaw routes all three tested quality values above 2
to its three-pass X-Trans interpolator; the sampled RGB16 outputs were exact
matches. Changing `user_qual` therefore does not select AHD, DCB, or AAHD for
X-Trans.

### Studio-derived paths

| Path                                | Fixture        | Full decode median | Demosaic median | Observed peak RSS |
| ----------------------------------- | -------------- | -----------------: | --------------: | ----------------: |
| RCD, rawpy fallback, CPU EP         | Sony 26 MP     |            23.70 s |          9.97 s |          1.91 GiB |
| Markesteijn, rawpy fallback, CPU EP | Fujifilm 16 MP |            25.88 s |         18.51 s |          1.83 GiB |

The RCD full decode range was 16.93–32.39 s and Markesteijn was
24.65–46.58 s on this shared VM. The variability reinforces that these CPU
figures are suitability bounds, not GPU projections. Neither result includes
Studio grading, TIFF compression, or browser Blob construction.

## Image Quality Evidence

The Sony real-RAW comparison samples every 16th pixel after the identical
LibRaw color pipeline:

| Pair        | Mean absolute RGB16 difference | Maximum difference | Pairwise PSNR |
| ----------- | -----------------------------: | -----------------: | ------------: |
| AHD vs DCB  |                    40.54 codes |        3,333 codes |      58.54 dB |
| AHD vs AAHD |                    35.62 codes |        6,837 codes |      58.02 dB |
| DCB vs AAHD |                    55.82 codes |        6,837 codes |      55.81 dB |

These values prove the algorithms are not interchangeable with the current
golden output. The low mean with a large maximum indicates localized changes,
which is consistent with edge and fine-detail differences. Pairwise PSNR does
not identify which algorithm is correct because the RAW has no ground-truth
RGB image.

In the fixed 1:1 Sony crop, AHD, DCB, and AAHD had no obvious rankable
difference in rail edges or foliage during this review. This is evidence that
AHD is a plausible candidate for broader review, not evidence of equivalent
quality: one well-exposed daylight scene does not exercise moiré, low-light
chroma noise, or severe clipping.

Studio image values are not compared numerically to LibRaw as a quality score.
Its black-level handling, defective-pixel repair, highlight reconstruction,
demosaic, white balance, camera matrix, float precision, and orientation path
are different by design. Treating its output delta as error would be invalid.
Fixed 1:1 crops visibly confirmed this confound for both sensors: Studio RCD on
the Sony crop `(x=2400, y=1500, 1400×1000)` and Markesteijn on the Fujifilm
crop `(x=1800, y=1100, 1200×900)` differed from LibRaw in overall brightness,
highlight clipping, and color before a demosaic-detail ranking could be made.
The Studio benchmark records the coordinates in JSON and writes the final
float32 result through the same fixed two-stop exposure and sRGB transfer used
for the LibRaw crops.

The quality evidence is sufficient to reject a silent algorithm swap, but not
to rank AHD, AAHD, RCD, or Markesteijn. A release decision needs blinded crop
review and objective chart/scene fixtures spanning low-light chroma noise,
fine repeating detail, diagonal edges, saturated highlights, and at least the
supported Bayer and X-Trans camera families.

## Recommendation and Tradeoffs

### 1. Evaluate AHD as the near-term export decoder

AHD is the only measured option that materially reduces current browser work
without introducing a new runtime or memory model. It cuts full decode nearly
in half and projects about a 20% complete-export improvement. DCB occupies an
inferior middle point in this fixture: slower than AHD and not demonstrably
higher quality.

Do not merge an AHD switch on timing evidence alone. Make the output change
explicit, regenerate golden data, and require the cross-camera quality gate.
If AHD fails that gate, retain AAHD and optimize the color/Deflate half of the
export first.

### 2. Do not enable pthreads from this diagnosis

No threaded browser build was measured. Pthreads would add cross-origin
isolation, SharedArrayBuffer, thread-pool startup, deployment header, browser
compatibility, and memory constraints. Even ideal parallelization of AAHD
alone can affect only about one third of warm export time. A separate prototype
must measure the production HTTPS path and every supported browser before this
becomes a recommendation.

### 3. Do not introduce the Studio-derived decoder yet

On CPU, the measured Studio paths are slower and use about 1.8–1.9 GiB RSS
before export. A browser port would additionally require an ONNX execution
provider, tiled models, sensor preprocessing, camera matrix behavior, model
asset delivery, cancellation, and a new quality contract. Studio's principal
advantage is its GPU-oriented quality pipeline, not a drop-in CPU speedup.
Prototype it only if product requirements explicitly choose Studio image
quality and can require a suitable WebGPU/ONNX browser environment.

## Test Plan

- Run unit tests for strip contracts and separate color/Deflate calls.
- Build both WASM modules and enforce bounded-copy boundary checks.
- Run exact native/WASM RGB16 parity for the unchanged AAHD production path.
- Run the opt-in Chromium benchmark with at least 20 measured samples for an
  acceptance claim.
- Run the standard Chromium, Firefox, and WebKit production-bundle smoke tests.
- Before changing algorithms, add Bayer and X-Trans quality fixtures and a
  blinded crop-review record; regenerate numerical golden outputs only after
  the quality decision.

## Unresolved Gaps

- Studio GPU RCD and Markesteijn were not measured because the host has no GPU.
- Studio RawSpeed was not measured because its Linux runtime library was absent.
- The Studio full export boundary was not measured.
- The five-sample diagnosis is too small for a stable p95 acceptance claim.
- Browser peak memory and energy use were not recorded.
- AHD/DCB/AAHD quality lacks ground-truth and cross-camera fixtures.
- The projected AHD production export must be measured after an explicit
  algorithm-change decision.

## Appendix: Reproduction

```sh
npm run build
npm run benchmark:libraw -- --samples=5 --warmups=1 \
  --crop=2400,1500,1400,1000 --crop-dir=/tmp/libraw-quality-crops
npm run benchmark:libraw -- --fixture=/path/to/fujifilm-x-t1.raf \
  --samples=1 --warmups=0 --crop=1800,1100,1200,900 \
  --crop-dir=/tmp/libraw-fujifilm-quality-crops
RAW_PERF_SAMPLES=5 npm run benchmark:browser

PYTHONPATH=/path/to/Raw-Alchemy-studio/src \
  /path/to/python scripts/benchmark-studio-decode.py \
  --fixture=vendor/LibRaw-Wasm/example-sony.ARW --samples=5 --warmups=1 \
  --crop=2400,1500,1400,1000 --crop-output=/tmp/studio-sony-rcd.ppm

PYTHONPATH=/path/to/Raw-Alchemy-studio/src \
  /path/to/python scripts/benchmark-studio-decode.py \
  --fixture=/path/to/fujifilm-x-t1.raf --samples=5 --warmups=1 \
  --crop=1800,1100,1200,900 --crop-output=/tmp/studio-fujifilm-markesteijn.ppm
```

The browser benchmark writes `raw-performance.json` into its Playwright test
output directory. Generated results remain build artifacts and are not
committed; this report records the reviewed results and immutable fixture and
revision identifiers.
