# LibRaw AAHD WebGPU Prototype

## Introduction

This prototype answers whether handwritten WGSL can reproduce the pinned
LibRaw AAHD path closely enough to replace its slow browser/WASM processing.
LibRaw remains the numerical reference. Studio, RCD, Markesteijn, and ONNX are
not reference implementations for this experiment.

The result is positive for AAHD itself and negative for direct productization
of the current full-frame implementation. On the 26 MP Sony fixture, WGSL
reproduces the two integer AAHD candidates almost exactly and reduces the AAHD
core from 7.07 seconds to about 79 milliseconds on an NVIDIA T4. The remaining
large local differences come from LibRaw's serial, stateful hot/dead-pixel scan,
not from demosaic interpolation. The prototype also uses 2.19 GiB of GPU
buffers and has a 417 MB maximum storage binding. A tiled implementation and an
explicit hot-pixel contract are therefore required before production use.

## Background

The production browser path asks pinned LibRaw to unpack the RAW, scale the
sensor values, run quality-12 AAHD, blend highlights, convert camera RGB to
linear ProPhoto, and create interleaved RGB16. The previous performance
diagnosis measured AAHD as the dominant full-resolution cost. Earlier native
WGSL work proved that GPU demosaic is fast, but used RCD and therefore could not
answer whether current LibRaw output can be preserved.

The reference build uses camera white balance, camera matrices, Blend
highlight mode, linear output, 16-bit ProPhoto, no automatic brightening,
signed `char`, defined signed-integer wrapping, disabled implicit floating-point
contraction, and the project's pinned AAHD power function. The WGSL port must
match those semantics rather than merely implement an algorithm also named
AAHD.

## Goals and Non-goals

Goals:

- Use LibRaw only for RAW unpack and sensor metadata.
- Reproduce LibRaw's scaled CFA, horizontal and vertical AAHD candidates,
  homogeneity decisions, selected camera RGB, Blend highlights, ProPhoto
  matrix, and RGB16 quantization in handwritten WGSL.
- Compare every output sample against values captured inside the real LibRaw
  execution.
- Measure cold and warm hardware WebGPU stages on the same RAW and machine as
  the LibRaw/WASM baseline.
- Identify any remaining difference by stage and source semantics.

Non-goals:

- Change the production decode path.
- Rank AAHD against RCD, Markesteijn, AHD, or DCB quality.
- Treat Studio output as a golden reference.
- Productize the prototype's full-frame GPU allocation.
- Include TIFF prediction, Deflate, or Blob creation in the demosaic timing.

## Detailed Design

The opt-in benchmark asks LibRaw for the visible packed sensor mosaic and exact
metadata. A persistent WebGPU workspace runs separate compute passes for sensor
scaling, AAHD hot/dead-pixel handling, horizontal and vertical interpolation,
gamma/YUV conversion, homogeneity accumulation, direction selection and
refinement, highlight blending, camera-to-ProPhoto conversion, and packed
RGB16 output.

All AAHD integer state uses 32-bit storage. Signed gradient arithmetic preserves
LibRaw's defined wrapping behavior. Candidate RGB values are clamped and stored
as 16-bit-domain integers. Gamma values are truncated to unsigned 16-bit values
before the YUV matrix, matching LibRaw's intermediate `ushort3`; omitting this
conversion changed about 120,000 direction decisions on the fixture.

The LibRaw oracle is opt-in. A build-owned patch adds capture hooks without
modifying the pinned vendor worktree. It records the scaled CFA, both AAHD
candidates, refined direction flags, selected camera RGB, final ProPhoto RGB16,
matrices, channel extrema, scale multipliers, and hot-pixel stage time. Capture
allocations are absent from normal decode.

The current workspace is intentionally simple and full-frame. It retains two
RGB candidates, two YUV candidates, two homogeneity planes, directions, input,
packed output, and readback. A production implementation must process bounded
tiles with AAHD's required halo and keep the final image GPU-resident through
color and LUT processing.

## Numerical Contract

The tested 6240 x 4168 Sony fixture contains 78,024,960 RGB channel samples.
The one-pass WGSL implementation produced these results:

| Boundary                 |  Differing values | Fraction |      MAE | Maximum |      PSNR |
| ------------------------ | ----------------: | -------: | -------: | ------: | --------: |
| Horizontal candidate     |             1,027 | 0.00132% | 0.000716 |   1,237 | 104.54 dB |
| Vertical candidate       |             1,018 | 0.00130% | 0.000726 |   1,237 | 104.37 dB |
| Refined direction pixels | 528 of 26,008,320 | 0.00203% |      n/a |     n/a |       n/a |
| Selected AAHD RGB        |             1,430 | 0.00183% | 0.001006 |   1,743 | 102.96 dB |
| Final ProPhoto RGB16     |             3,003 | 0.00385% | 0.001314 |   1,033 | 102.21 dB |

The large maxima are not diffuse floating-point error. At sensor coordinate
`(1919, 421)`, for example, LibRaw first repairs the dead pixel two columns to
the left and then uses that changed value to classify the current pixel. The
parallel pass observes the old zero and does not make the second repair. A
second parallel pass reduced horizontal candidate differences from 1,027 to
526, but also repaired pixels that LibRaw's one-way row scan had already passed.
Iteration therefore cannot reproduce the serial reference.

The AAHD interpolation formulas are feasible in WGSL. Bitwise reproduction of
LibRaw's hot/dead-pixel side effects is a separate, inherently ordered problem.
Product code must choose one explicit contract:

1. Preserve LibRaw RGB16 exactly by running the extracted hot/dead scan in
   CPU/WASM before tiled WGSL AAHD.
2. Use a deterministic parallel hot/dead algorithm, accept sparse local
   differences from LibRaw, and create new reviewed golden output.

The second option is recommended. The serial LibRaw scan took 434 ms on the
local WASM host while the parallel T4 pass took about 3.6 ms. Its order-dependent
behavior is not a desirable image-quality invariant.

## Performance Evidence

Hardware measurements used Chrome WebGPU on an AWS `g4dn.xlarge` with an
NVIDIA T4. CPU and GPU measurements used the same VM, the same 31.8 MB Sony RAW,
the same pinned LibRaw/WASM build, one warm-up where applicable, and full
6240 x 4168 output.

LibRaw/WASM medians across three measured runs:

| Stage                        |   Median |
| ---------------------------- | -------: |
| Input, open, and unpack      |   195 ms |
| Pre-demosaic processing      |   510 ms |
| AAHD                         | 7,070 ms |
| Post-demosaic highlight work |    98 ms |
| ProPhoto conversion          |   749 ms |
| RGB16 copy                   |   107 ms |
| Complete decode              | 8,729 ms |

WGSL medians across four warm runs after one cold run:

| Stage                                          |  Median |
| ---------------------------------------------- | ------: |
| LibRaw input, open, unpack, and visible mosaic |  205 ms |
| Upload, scale, and candidate initialization    |  112 ms |
| Hot/dead pass                                  |  3.6 ms |
| Candidate interpolation                        | 52.4 ms |
| Homogeneity and direction choice               | 13.6 ms |
| Direction refinement and combine               | 10.0 ms |
| Highlight and ProPhoto RGB16 write             |  5.6 ms |
| 156 MB RGB16 readback                          |  165 ms |
| GPU function including readback                |  366 ms |
| Worker total including LibRaw unpack           |  572 ms |
| File-input benchmark wall time                 |  905 ms |

The corresponding AAHD core is about 79 ms versus 7,070 ms, approximately
90 times faster. Worker time to CPU-readable RGB16 is approximately 15.2 times
faster than the complete LibRaw decode. If the result remains GPU-resident for
color and LUT processing, the measured worker stages total approximately
0.40 seconds, about 21 times faster than LibRaw. These ratios are T4 evidence,
not universal client-GPU guarantees.

The cold run spent 179 ms creating the device and pipelines, 210 ms initializing
the first workspace use, and 286 ms on the first readback. Runtime and workspace
caching remove the device cost and reduce initialization and readback on warm
runs.

### Phase 0 Reproduction After Main Integration

The prototype was reproduced again at commit `315e4ea` after integrating the
current `main`. The run used Ubuntu 24.04 on an AWS `g4dn.xlarge`, NVIDIA Tesla
T4 with driver 595.71.05, and Playwright Chrome 149.0.7827.55. The adapter
reported NVIDIA Turing and `isFallbackAdapter: false`. The input was the same
31,793,152-byte Sony fixture with 6240 x 4168 visible pixels.

Across four warm runs, LibRaw unpack plus mosaic copy took 208-210 ms, the AAHD
core took 78-79 ms, final GPU processing including RGB16 readback took 370-407
ms, and Worker time took 580-616 ms. The separate production LibRaw AAHD run
measured a 7,257 ms demosaic median and an 8,958 ms complete-decode median.
These results reproduce the established warm performance shape.

Chrome 149 spent 3,489 ms creating the device and pipelines in the first
hardware run, compared with 179 ms in the earlier report. A separate process
that also captured the LibRaw oracle spent 258 ms at the same boundary, while
all warm runs spent effectively zero. The current evidence therefore treats
pipeline creation as a cold-browser cost with substantial cache variance; it
does not attribute that difference to AAHD execution.

Two repeated final-stage oracle runs were stable within this environment but
reported 2,942 differing RGB16 samples, rather than the earlier 3,003. Both
runs had 2,452 samples above one code, maximum difference 1,033 at sample index
1,291,537, and 102.22 dB PSNR. No relevant AAHD shader math changed between
the reports. This runtime-dependent result reinforces that the in-place defect
and isolated-direction dispatches are not a portable deterministic contract,
even when one browser and driver happen to repeat a result.

## Resource Trade-offs

The full-frame workspace allocates approximately 2.19 GiB and its largest
buffer is 417 MB. It is unsuitable for product use and will be rejected by
adapters whose storage-binding limit is below 417 MB. A roughly 1024-square
tile with the required halo would reduce live AAHD storage to roughly 100 MB.
Tiling must preserve candidate and homogeneity neighborhoods and must occur
after the hot/dead-pixel contract is resolved.

Handwritten WGSL is required for this path. AAHD uses mutable neighborhoods,
integer wrapping, atomic homogeneity accumulation, and discrete refinements.
Representing it as ONNX would add graph dispatches and intermediate tensors
without improving numerical portability or CLI reuse. Native CLI support should
keep LibRaw or use a separate native compute backend; it should not constrain
the browser's performance-critical implementation.

## Recommendation

Continue with tiled handwritten WGSL AAHD as the browser parity candidate. Do
not adopt the current full-frame prototype and do not claim bitwise LibRaw
parity yet.

Before production:

- Choose and document the hot/dead-pixel contract. Prefer a deterministic
  parallel algorithm and new golden output; use the 434 ms CPU scan only if
  exact legacy RGB16 is a hard requirement.
- Implement bounded tiling and keep candidate/final data GPU-resident through
  white balance, matrices, grading, and 3D LUT.
- Replace full-frame RGB16 readback with export strips so Deflate can overlap
  bounded GPU readback.
- Validate multiple Bayer cameras, CFA phases, black-level layouts, clipped
  highlights, borders, and synthetic hot/dead clusters.
- Set product acceptance thresholds separately for ordinary pixels and the
  explicitly chosen defect-pixel policy.

## Open Questions

- Whether product compatibility requires the order-dependent LibRaw defect
  policy or only equivalent visible quality.
- The best tile size across integrated and discrete browser GPUs.
- Whether color-matrix arithmetic should target bitwise CPU output or a bounded
  one-code-value contract after defect pixels are excluded.
- How much strip readback can overlap TIFF prediction and Deflate on typical
  client hardware.

## Appendix: Reproduction

The opt-in Playwright benchmark selects
`demosaicBackend=libraw-aahd-wgsl`. `demosaicOutputStage` accepts
`horizontal`, `vertical`, `directions`, `aahd`, or `final`; setting
`librawReference=1` captures and compares the matching internal LibRaw stage.
Normal application and end-to-end paths continue to use production LibRaw.

The CPU baseline is reproducible with:

```text
node scripts/benchmark-libraw-algorithms.mjs --algorithm=AAHD --warmups=1 --samples=3
```

The hardware report requires `WEBGPU_HARDWARE=1`, the AAHD benchmark backend,
the final output stage, and at least five samples so the first run is reported
separately from four warm runs.
