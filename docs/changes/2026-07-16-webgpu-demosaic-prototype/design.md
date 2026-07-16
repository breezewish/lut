# ONNX-WebGPU Demosaic Prototype

## Introduction

This change validates a browser path from LibRaw sensor data to Studio's
unmodified RCD and Markesteijn ONNX graphs. The implementation is a useful
performance prototype, but it must not replace the production decoder yet.

On an NVIDIA T4, the warm sensor-to-float-RGB path took 2.13 s for a 26 MP Sony
Bayer image with RCD and 7.38 s for a 16 MP Fujifilm X-Trans image with
Markesteijn. The comparable current LibRaw decodes took 10.27 s for Sony AAHD
and 14.44 s for the Fujifilm production quality setting.

The strict correctness gate did not pass. Against Studio's native CUDA output,
RCD had 452 samples over one RGB16 code out of 78,024,960 and a maximum error
of 212 codes. Markesteijn had 2,271 samples over one code out of 48,787,392 and
a maximum error of 5,687 codes. Native ONNX CPU and CUDA differed by at most
one code for RCD and were identical for Markesteijn, so the long tail is
specific to the WebGPU execution path rather than the model assets.

The recommendation is to retain this branch as evidence and an investigation
harness. Productize the LibRaw sensor API independently. Do not make either
ONNX-WebGPU graph a production default under the current strict RGB16
contract. Meeting that contract requires a sensor-to-demosaic implementation
whose discrete decisions use canonical integer arithmetic, not a graph rewrite
after Studio's float candidates have already been produced.

## Background

The production browser asks LibRaw to perform the complete decode, including
demosaic, color conversion, and RGB16 creation. Studio instead reads sensor
data, performs sensor-space preprocessing, runs RCD for Bayer or Markesteijn
for X-Trans, applies white balance and the camera-to-working-space matrix, and
retains float32 RGB.

The previous performance diagnosis showed that Sony AAHD demosaic dominates
the current full decode. The separate WebGPU color prototype also showed that
keeping later color processing on the GPU is materially faster than returning
to CPU strips. This experiment tests whether Studio's existing standard ONNX
graphs can remove the decode bottleneck without creating a separate browser
demosaic algorithm.

## Goals and Non-goals

Goals:

- Expose the visible, unpacked sensor mosaic and required metadata from the
  pinned LibRaw WASM build without running `dcraw_process()`.
- Run Studio's unmodified RCD and Markesteijn ONNX models through ONNX Runtime
  WebGPU with GPU-resident tile input and output.
- Preserve Studio's CFA phase, reflect padding, tiling, white balance, camera
  matrix, clipping, and X-Trans border behavior.
- Compare complete browser RGB16 output with Studio's native ONNX output.
- Measure cold and warm sensor extraction, upload, graph, readback, and
  validation costs on hardware WebGPU.

Non-goals:

- Change the production AAHD decoder or default application route.
- Port Studio's hot-pixel repair or segmented highlight reconstruction.
- Implement proxy, ROI, orientation, unusual sensor, export, or fused LUT
  product behavior.
- Claim cross-browser or cross-GPU readiness from one T4.

## Detailed Design

The LibRaw wrapper has an unpack-only sensor path. It copies the visible mosaic
into one compact row-major `uint16` allocation and exposes bounds-checked WASM
views. Metadata includes visible dimensions, Bayer or X-Trans CFA, effective
per-channel black levels, white level, camera white balance, the 4 x 3
XYZ-to-camera matrix, and orientation. Effective black levels include LibRaw's
repeat-black table adjustment, matching rawpy behavior for Fujifilm RAF files.
The prototype rejects a residual spatially varying black table because the GPU
input contract currently carries four channel levels rather than a black map.

The benchmark Worker uploads the compact mosaic once. A WGSL tile shader
performs per-CFA black subtraction, normalization, Studio-compatible phase
alignment, and reflect padding. ONNX Runtime executes the original fixed-tile
Studio graphs and retains each output as a GPU buffer. A second WGSL shader
stitches the valid tile interior into one float32 RGB frame. RCD already folds
white balance, the camera matrix, and clipping into its graph. The X-Trans
stitch shader performs those operations after Markesteijn, matching Studio.

ONNX Runtime's JavaScript WebGPU backend owns its `GPUDevice`. The prototype
therefore gives ORT the selected adapter before creating the first session and
then builds custom pipelines and buffers on ORT's exposed device. Creating a
second device makes external ONNX input buffers invalid even when both devices
come from the same adapter.

Studio pads the phase-aligned X-Trans work image to a multiple of six before
tile-origin calculation. The browser does the same and reflects padded
coordinates within the cropped work image. Omitting this step produced large
bottom and right edge differences and is covered by the native comparison.

The benchmark optionally accepts a raw little-endian RGB16 native reference.
After the one float32 readback, the Worker quantizes every sample with
round-to-nearest and reports the complete difference distribution. Reference
comparison is excluded from performance runs.

## Tradeoffs

### Standard ONNX graph versus WebGPU numerical behavior

The same model assets run through browser WebGPU and native CPU/CUDA providers,
which keeps the algorithm source shared. It does not guarantee identical
floating-point branch decisions. Both demosaic graphs contain sensitive
discriminators. Rare WebGPU differences can select a different interpolation
direction and create a much larger local output difference than the underlying
arithmetic ULP difference.

Moving black subtraction and normalization to CPU reduced the RCD maximum from
212 to 46 codes but did not remove the long tail, while increasing cold input
preparation from about 0.33 s to 1.29 s. Disabling WebGPU subgroup support did
not change any result. Disabling graph optimization also produced the same
codes. Keeping Markesteijn in the black-subtracted sensor scale instead of
normalizing it changed neither its 5,687-code maximum nor the location of that
maximum materially. The retained implementation therefore keeps the faster
GPU preprocessing and records the graph-level difference openly.

Instrumenting the maximum-error Markesteijn tile located the amplification
mechanism exactly. The four candidate RGB planes differed by at most
`1.49e-7`, and their derivative planes differed by at most `1.79e-7`. One
homogeneity comparison nevertheless had a WebGPU margin of `+2.68e-9` and a
CUDA margin of `-6.75e-9`. That changed one direction's 5 x 5 count from 168
to 169, selected a different color candidate, and produced the large final
code-value jump.

LibRaw avoids this failure class by storing Markesteijn candidates as unsigned
integer samples, converting them to integer CIELab, and accumulating integer
squared derivatives and homogeneity counts. Studio intentionally replaced
that section with float32 BT.2020 YPbPr derivatives. Adding fixed-point nodes
only around the final ONNX comparisons changed many native branch decisions
and made the browser graph about three times slower because of provider
boundaries. A second experiment kept Studio's float candidate graph and moved
the derivative and homogeneity passes to integer WGSL. It still crossed rare
candidate-quantization boundaries. Both experiments were rejected and are not
part of the retained code.

### Full frame versus production memory

The prototype assembles and reads one complete float32 RGB frame. The Sony
frame is about 312 MB before readback storage. This makes correctness and stage
timing simple, but it is not the intended production memory design. A product
path should keep output GPU-resident for the fused color/LUT shader and use
proxy or native-resolution ROI execution for interaction.

### Browser and CLI sharing

The ONNX files, tile contract, CFA rules, and conformance references are
shareable. Browser and CLI buffer orchestration remains provider-specific. The
native CUDA results confirm that a CLI can use the same models efficiently,
but they also show that the browser provider needs its own numerical gate.

## Recommendation

1. Merge or reimplement the LibRaw unpack-only sensor API independently; it is
   fast, exact for both fixtures, and useful regardless of demosaic backend.
2. Keep production AAHD/AHD decisions separate from this prototype. RCD has a
   strong measured speed advantage, but it has not passed the strict RGB16
   conformance gate on WebGPU.
3. If strict cross-provider RGB16 conformance remains a requirement, derive a
   WebGPU decoder from LibRaw/Studio that carries integer or fixed-point
   semantics from the sensor samples through every discrete direction choice.
   Do not expect ONNX to be a universal portability layer for these graphs.
4. If a reviewed perceptual contract accepts the sparse provider-specific
   branch changes, productize RCD first. Full-resolution
   Markesteijn remains too slow for interaction on the T4 and needs proxy/ROI
   execution.
5. Keep demosaic RGB on the GPU and feed the existing fused WGSL color/LUT
   stage directly. Do not add a full-frame host readback to production.

## Test Plan

- Validate the complete compact sensor mosaic and metadata for Sony Bayer and
  Fujifilm X-Trans fixtures.
- Compare every quantized RGB16 output sample against Studio native CPU and
  CUDA references.
- Record one cold and four warm hardware WebGPU runs without reference data.
- Run TypeScript, browser unit, Rust, Clippy, production build, and standard
  browser end-to-end tests.

## Open Questions

- Is the product contract native-code equivalence or reviewed perceptual
  equivalence across GPU providers?
- If native-code equivalence is required, should the canonical decoder follow
  LibRaw's CIELab integer decisions or define a new fixed-point form of
  Studio's YPbPr decisions?
- Do target consumer GPUs reproduce the T4 distribution?
- What proxy and ROI dimensions meet the product interaction budgets?

## Appendix A: Provenance and Environment

- Studio commit: `c9823146ba674be52d62f4c55b4c649f796bafd0`
- RCD model SHA-256:
  `d15dfdfa0d0a80646bee2e148cc0e5a07e6b2554008b1b3ee0458951bd8fabf4`
- Markesteijn model SHA-256:
  `d22747f383d898715541dfbf68d20b21c632179b152e9c8a52f3025116b32d40`
- AWS `g4dn.xlarge`, NVIDIA Tesla T4 15 GB, driver 595.71.05
- Ubuntu 24.04, Chrome for Testing 149.0.7827.55
- ONNX Runtime Web 1.27.0; native ONNX Runtime 1.25.1
- Hardware adapter: NVIDIA Turing, fallback `false`
- Sony fixture SHA-256:
  `3b4dca9296944931a0deb4b6456685985e326aef884c32d9c5df4fc9f64d7e2c`
- Fujifilm fixture SHA-256:
  `e994a1fd6e87e392432fe146a35b0b88584dc2bd50bee2c8c7e886ac2b59fcde`

## Appendix B: Performance Evidence

Warm medians exclude model/session creation and full-frame validation:

| Stage                         | Sony RCD, 6240 x 4168 | Fuji Markesteijn, 4934 x 3296 |
| ----------------------------- | --------------------: | ----------------------------: |
| LibRaw sensor extraction      |                209 ms |                         63 ms |
| Mosaic upload and preparation |                232 ms |                        141 ms |
| ONNX graph and tile stitch    |              1,325 ms |                      6,935 ms |
| Float RGB readback            |                364 ms |                        242 ms |
| Sensor through readback       |                2.13 s |                        7.38 s |

Cold session creation was 5.02 s for RCD and 6.13 s for Markesteijn. It must
be hidden behind preload or amortized across files in any product path.

Reference LibRaw measurements:

| Fixture | Current path               | Full decode |
| ------- | -------------------------- | ----------: |
| Sony    | AAHD                       |     10.27 s |
| Sony    | AHD candidate              |      5.29 s |
| Fuji    | production quality setting |     14.44 s |

The Fuji LibRaw value is one warm secondary run. Its AHD/DCB/AAHD quality
labels all selected the same X-Trans path, so it is not an algorithm ranking.
The ONNX path also omits Studio hot-pixel and highlight preprocessing, making
the table a bottleneck comparison rather than a drop-in export benchmark.

## Appendix C: Complete RGB16 Comparison

| Reference comparison           |    Samples | Different | Over 1 code | Over 8 codes | Maximum | Mean absolute |
| ------------------------------ | ---------: | --------: | ----------: | -----------: | ------: | ------------: |
| RCD WebGPU vs CUDA             | 78,024,960 |    26,456 |         452 |          182 |     212 | 0.000396 code |
| Markesteijn WebGPU vs CUDA     | 48,787,392 |    75,790 |       2,271 |        1,980 |   5,687 | 0.008003 code |
| RCD native CPU vs CUDA         | 78,024,960 |     2,466 |           0 |            0 |       1 | 0.000032 code |
| Markesteijn native CPU vs CUDA | 48,787,392 |         0 |           0 |            0 |       0 |        0 code |

All browser samples were finite and remained in `[0, 1]`. The low average
error does not override the maximum-error gate: the WebGPU paths are not yet
strictly conformant.
