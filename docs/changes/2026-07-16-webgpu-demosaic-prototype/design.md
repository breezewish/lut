# Native WebGPU RAW Pipeline Prototype

## Introduction

This prototype validates a browser pipeline in which LibRaw only unpacks the
RAW and exposes metadata, while explicit WGSL compute passes perform Bayer RCD,
white balance, the camera-to-ProPhoto matrix, exposure, V-Log conversion,
tetrahedral 3D LUT sampling, and RGB16 quantization. CPU work starts again only
when RGB16 must be read back for TIFF Deflate and Blob creation.

The result is decisive about the execution backend. Handwritten GPU kernels
are substantially faster than the equivalent ONNX-WebGPU graphs for these
traditional image algorithms. On an NVIDIA T4, a warm 26 MP Sony frame took
about 17 ms for handwritten WGSL RCD and 3.6 ms for the fused color/LUT/RGB16
pass. The retained ONNX-WebGPU RCD graph and tile stitch took 1.33 s. For
X-Trans, Studio's former handwritten Taichi/CUDA Markesteijn implementation
took 0.31 s, while its ONNX-WebGPU graph and stitch took 6.94 s.

Use handwritten WGSL, not ONNX, for the browser RAW pipeline. Use RCD for
Bayer and retain Markesteijn as the X-Trans algorithm, subject to a dedicated
WGSL port and quality gate. ONNX remains useful for learned models; it is not
an efficient portability layer for deterministic stencil-heavy demosaic and
color code.

The prototype is not a complete Studio replacement. Its sensor preprocessing
implements exact per-channel black subtraction and normalization, but not
Studio's hot-pixel repair or segmentation-based highlight reconstruction.
Those omitted stages took about 0.24 s and 2.95 s respectively on the Sony
fixture in Studio's CPU implementation. The highlight algorithm uses
morphology, connected components, and per-segment reductions, so its canonical
semantics must be chosen before a production GPU port is claimed.

## Background

The production browser currently asks LibRaw to demosaic, convert color, and
create ProPhoto RGB16. Full-resolution Sony AAHD takes about 10.27 s. Studio's
later pipeline instead extracts the sensor mosaic and uses RCD for Bayer or
Markesteijn for X-Trans before continuing in float32.

The first experiment reused Studio's unmodified ONNX graphs through ONNX
Runtime WebGPU. It proved that GPU demosaic can be faster than LibRaw, but also
showed large framework costs: fixed-size tiling, graph dispatch, intermediate
tensors, stitching, session startup, and provider-specific floating-point
branch decisions. The native prototype keeps the ONNX implementation as a
measured control and translates the RCD passes directly to WGSL.

## Goals and Non-goals

Goals:

- Keep LibRaw responsible only for unpack and RAW metadata.
- Keep the sensor mosaic and subsequent image data on WebGPU through RGB16.
- Measure upload, black normalization, demosaic, fused color/LUT/RGB16,
  readback, Deflate, and Blob separately.
- Compare handwritten GPU kernels with ONNX-WebGPU and current LibRaw paths.
- Compare complete RGB16 output with Studio's native implementation.
- Decide the browser execution backend and demosaic direction from evidence.

Non-goals:

- Change the production decoder or SSOT in this branch.
- Claim that pairwise numerical similarity ranks image quality.
- Port hot-pixel repair, segmented highlight reconstruction, orientation,
  proxy/ROI scheduling, unusual sensors, or X-Trans Markesteijn to WGSL.
- Claim cross-browser or cross-GPU readiness from one T4.

## Metric Definitions

| Metric            | Start                                 | End                            |     Prototype measurement |
| ----------------- | ------------------------------------- | ------------------------------ | ------------------------: |
| Processed preview | Worker receives a previously read RAW | post-LUT image is GPU-resident | 0.32 s warm at full 26 MP |
| Complete decode   | LibRaw receives the RAW bytes         | complete RGB16 is CPU-readable |      0.49 s warm at 26 MP |
| Complete export   | Worker receives the RAW bytes         | valid TIFF Blob exists         |      6.80 s warm at 26 MP |

The processed-preview measurement includes LibRaw sensor extraction, mosaic
upload, black normalization, RCD, and the fused color/LUT pass. It excludes the
intentional full-frame RGB16 readback and does not include DOM/canvas
presentation. Once a decoded frame is resident, a recipe-only color/LUT update
executes in about 3.6 ms before presentation. Production interaction should use
the existing proxy/ROI design rather than repeatedly process 26 MP.

The complete-decode measurement adds the RGB16 buffer copy and map. Complete
export adds TIFF Deflate and Blob construction. These boundaries prevent a
fast shader from hiding a slow host transfer or compressor.

## Detailed Design

The LibRaw WASM wrapper exposes a compact visible `uint16` sensor mosaic,
dimensions, CFA, effective per-channel black levels, white level, camera white
balance, camera matrix, and orientation without calling `dcraw_process()`.

One persistent WebGPU runtime owns nine RCD compute pipelines and a workspace
for one image size. The workspace contains the packed mosaic, planar float32
RCD intermediates, the LUT, packed RGB16 output, and a map-readable buffer.
Repeated frames of the same dimensions reuse the pipelines and allocations.

The preprocessing shader selects black level by CFA channel, subtracts it,
clamps at zero, and divides by the per-channel white range. Seven explicit RCD
passes then reproduce Studio's former handwritten RCD math. A final pass
applies white balance, camera-to-ProPhoto conversion, exposure, ProPhoto to
V-Gamut, V-Log, tetrahedral 3D LUT interpolation, round-to-nearest RGB16
quantization, and two-pixel packing.

The benchmark uses an identity 3D LUT so the native Studio reference can check
the complete chain independently of creative look choice. The shader executes
the same tetrahedral lookup path as a creative LUT. The existing standalone
WebGPU LUT prototype remains retained and unchanged.

For a complete export, the mapped RGB16 array is streamed through the existing
WASM TIFF encoder. Its output is a real 16-bit RGB TIFF with horizontal
prediction and Deflate; Blob timing measures construction of the actual TIFF
bytes rather than a synthetic allocation.

## Performance Evidence

### Native WGSL Bayer path

Warm values are the observed range of four runs after one cold run on the Sony
6240 x 4168 fixture.

| Stage                                       |   Warm range |
| ------------------------------------------- | -----------: |
| LibRaw input, open, unpack, mosaic copy     |   210-219 ms |
| Mosaic upload                               |     88-97 ms |
| WGSL black normalization                    |   3.7-4.5 ms |
| WGSL RCD                                    | 16.4-17.1 ms |
| WGSL color, V-Log, 3D LUT, RGB16            |   3.5-3.6 ms |
| RGB16 copy and map                          |   167-171 ms |
| Sensor through GPU-resident post-LUT output |   319-330 ms |
| Sensor through CPU-readable RGB16           |   491-502 ms |

The cold run additionally spent about 405 ms creating the WebGPU device and
pipelines. Production must preload and retain that runtime.

### Backend and algorithm controls

| Fixture and path                                |     Demosaic/graph core | Sensor through host-readable output |
| ----------------------------------------------- | ----------------------: | ----------------------------------: |
| Sony 26 MP, native WGSL RCD                     |                   17 ms |    0.49 s including color and RGB16 |
| Sony 26 MP, ONNX-WebGPU RCD                     | 1.33 s graph and stitch |                 2.13 s to float RGB |
| Sony 26 MP, LibRaw AHD                          |                  3.19 s |                              5.29 s |
| Sony 26 MP, LibRaw AAHD                         |                  8.18 s |                             10.27 s |
| Fuji 16 MP, handwritten Taichi/CUDA Markesteijn |                  0.31 s |                      not integrated |
| Fuji 16 MP, ONNX-WebGPU Markesteijn             | 6.94 s graph and stitch |                 7.38 s to float RGB |
| Fuji 16 MP, current LibRaw X-Trans path         |            not isolated |                             14.44 s |

The Taichi result is a kernel-level proxy, not a WGSL implementation. It is
valuable because it runs Studio's former handwritten Markesteijn code on the
same T4 and isolates ONNX representation overhead from algorithm complexity.
It makes a handwritten WGSL Markesteijn port the justified next experiment.

### Sensor preprocessing and export controls

Studio's native CPU sensor preprocessing on the Sony fixture measured:

| Stage                                 |   Warm time |
| ------------------------------------- | ----------: |
| Per-channel black normalization       |    27-28 ms |
| Hot-pixel repair                      |  243-246 ms |
| Segmentation highlight reconstruction | 2.95-2.96 s |

The WGSL prototype replaces only the first row, in about 3.7 ms. These values
must not be added to the 0.49 s complete-decode claim because the latter
deliberately measures the implemented POC contract, not the complete Studio
preprocessing contract.

The warm complete TIFF export measured 6.80 s: 0.23 s LibRaw extraction,
0.35 s upload through RGB16 readback, 6.01 s Deflate, and 0.19 s Blob creation.
Once demosaic and color are GPU-resident, Deflate is the dominant export
bottleneck and needs independent parallel/faster-compression work.

## Correctness Evidence

The reference is Studio `c982314` executed through native ONNX Runtime CPU or
CUDA, with the same rawpy mosaic, black normalization, white balance, and
camera-to-ProPhoto matrix. Hot-pixel and highlight stages are deliberately
excluded on both sides so the test isolates the implemented contract.

| Comparison                                   |    Samples | Over 1 code | Over 8 codes | Maximum | Mean absolute |         PSNR |
| -------------------------------------------- | ---------: | ----------: | -----------: | ------: | ------------: | -----------: |
| Leica 10.3 MP, WGSL RCD only vs native CPU   | 31,022,880 |      10,409 |        6,508 |     415 |       0.00537 | not recorded |
| Leica 10.3 MP, ONNX-WebGPU RCD vs native CPU | 31,022,880 |       9,602 |        6,120 |     415 |       0.00512 | not recorded |
| Leica 10.3 MP, complete identity-LUT chain   | 31,022,880 |       4,060 |           69 |     131 |       0.00201 | not recorded |
| Sony 26 MP, complete identity-LUT chain      | 78,024,960 |         233 |           90 |     664 |       0.00179 |    114.11 dB |

On Leica, native WGSL and ONNX-WebGPU have the same maximum-error index and
the same 415-code values. This is strong evidence that the WGSL translation is
semantically faithful and that the remaining tail comes from WebGPU float32
evaluation changing rare direction decisions, not from a mistranslated pass.

The Sony full-chain maximum is 664 codes, about 1.0% of the 16-bit range, but
only 90 of 78,024,960 channel samples exceed eight codes. The aggregate error
is extremely small; the maximum is not. Product acceptance must therefore use
a reviewed perceptual and distribution contract, not only mean error and not
a false claim of bit identity.

The retained ONNX comparison has the same problem. Native CPU and CUDA differ
by at most one code for RCD, while WebGPU changes sparse float discriminators.
ONNX does not solve cross-provider determinism.

## Recommendation

1. Use a native WebGPU compute pipeline in the browser. Keep the image
   GPU-resident through preview; read RGB16 back only for export.
2. Select RCD as the Bayer production candidate because it matches the chosen
   Studio image pipeline and its measured kernel cost is already negligible.
   Do not port AAHD merely to preserve the old LibRaw output; algorithm quality,
   not RCD performance, is now the remaining Bayer release gate.
3. Select Markesteijn as the X-Trans candidate, but implement and benchmark a
   direct WGSL port before production. The handwritten CUDA control shows that
   the algorithm can be hundreds of milliseconds; the 6.94 s ONNX graph is not
   an inherent Markesteijn cost.
4. Do not use ONNX for black normalization, demosaic, matrices, transfer
   functions, LUT interpolation, or quantization. Reserve ONNX for actual
   learned networks where its model portability offsets runtime overhead.
5. Decide the numerical contract explicitly. If sparse provider-specific
   differences with the measured distribution pass blinded crop review, use a
   distribution plus perceptual gate. If every output must match the native
   Studio base within one code, neither float WGSL nor ONNX-WebGPU qualifies;
   the canonical algorithm must be revised to deterministic integer/fixed-point
   direction decisions on both native and browser implementations.
6. Treat hot-pixel repair and highlight reconstruction as separate algorithm
   decisions. Hot-pixel repair is a local stencil and a good WGSL candidate.
   Studio's segmented highlight method is a global connected-components
   algorithm; either port it and measure convergence, or adopt a GPU-friendly
   canonical replacement after image-quality review. Do not silently omit it.
7. Optimize TIFF compression next. The GPU RAW pipeline has moved the full
   export bottleneck to the CPU Deflate stage.

## Test Plan

- Validate the complete compact sensor mosaic and metadata for Bayer and
  X-Trans fixtures.
- Compare every quantized RGB16 sample at the demosaic and complete identity-LUT
  boundaries against Studio native references.
- Record one cold and at least four warm hardware WebGPU runs without reference
  validation overhead.
- Produce a readable full-resolution TIFF through the real Deflate and Blob
  path.
- Run TypeScript, browser unit, Rust, Clippy, production build, and standard
  browser end-to-end tests.
- Before production, add quality fixtures for low-light chroma, repeating
  detail, diagonal edges, saturated highlights, hot pixels, Bayer, and X-Trans.

## Open Questions

- What perceptual and sparse-error thresholds replace the current one-code
  native/WASM contract for GPU providers?
- Does direct WGSL Markesteijn retain the 0.31 s handwritten-kernel behavior on
  target consumer GPUs?
- Should segmented highlight reconstruction remain canonical, or should Studio
  and browser adopt a more local GPU-friendly algorithm?
- Which Deflate implementation and compression level meet the export target?

## Provenance

- Studio commit: `c9823146ba674be52d62f4c55b4c649f796bafd0`
- RCD model SHA-256:
  `d15dfdfa0d0a80646bee2e148cc0e5a07e6b2554008b1b3ee0458951bd8fabf4`
- Markesteijn model SHA-256:
  `d22747f383d898715541dfbf68d20b21c632179b152e9c8a52f3025116b32d40`
- Sony fixture SHA-256:
  `3b4dca9296944931a0deb4b6456685985e326aef884c32d9c5df4fc9f64d7e2c`
- Fujifilm fixture SHA-256:
  `e994a1fd6e87e392432fe146a35b0b88584dc2bd50bee2c8c7e886ac2b59fcde`
- AWS `g4dn.xlarge`, NVIDIA Tesla T4 15 GB, driver 595.71.05
- Ubuntu 24.04, Chrome for Testing 149.0.7827.55
- ONNX Runtime Web 1.27.0; native ONNX Runtime 1.25.1/1.27.0
