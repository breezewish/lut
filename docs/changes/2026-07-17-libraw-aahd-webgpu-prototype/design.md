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

### Deterministic Candidate Reference

The parallel candidate now has an explicit contract separate from LibRaw
parity. Defect classification and replacement read one immutable scaled CFA
plane and write corrections to a second plane. A packed one-bit-per-pixel mask
records the classified defects. The isolated-direction refinement similarly
reads one direction plane and writes a second plane before copying it back.
The two checkerboard refinement passes remain ordered by parity because each
dispatch only reads the opposite parity.

An independent scalar TypeScript implementation defines both changed
boundaries. It deliberately reads only its immutable input and does not share
the WGSL implementation. On the 6240 x 4168 Sony fixture, T4 hardware tests
compared all 78,024,960 expanded channel samples at each boundary. The
corrected CFA, packed defect classification, and isolated-direction result all
matched their scalar references exactly. Two complete candidate runs were also
bitwise repeatable in the tested browser and driver environment.

The candidate still differs from pinned LibRaw at 2,942 final ProPhoto RGB16
samples, with maximum difference 1,033. That difference is expected evidence
of the new immutable-neighborhood policy, not a LibRaw parity result. The
broader camera and device repeatability matrix remains required before the
candidate can be considered for product use.

### LibRaw Parity Route

The separate `libraw-parity` contract preserves the three order-sensitive or
numerically non-portable boundaries outside WGSL:

- A scalar CPU scan reproduces LibRaw's row-ordered hot/dead correction and
  uploads the corrected packed CFA plus defect mask.
- The checker refinement remains on the GPU, while the final isolated-direction
  scan reads back a packed 16-bit direction plane, applies LibRaw's row order on
  the CPU, and uploads the refined plane.
- The GPU compacts only pixels that require Blend highlight processing. A
  scalar CPU transform applies LibRaw's exact `float` statement order to those
  records and uploads them for sparse GPU writeback. The 49,408-record Sony
  result avoids a full RGB readback at this boundary.

LibRaw's YUV matrix affects discrete homogeneity decisions. The parity route
therefore stores every multiply and add through an existing `f32` storage slot
between dispatches. This prevents driver contraction without allocating
another full-frame buffer. The deterministic candidate retains its shorter
single-dispatch conversion.

On the 6240 x 4168 Sony fixture, the scaled CFA, horizontal and vertical
candidates, YUV values, homogeneity, chosen and refined directions, selected
AAHD RGB, Blend highlight RGB, and final ProPhoto RGB16 all matched the pinned
LibRaw captures exactly. The final cold run and two warm runs each compared all
78,024,960 channel values with zero differences. Warm demosaic totals were
2,434-2,577 ms. The serial defect scan took 710-735 ms, direction refinement
100-106 ms, and compact highlight transform 36-49 ms. These full-frame numbers
establish feasibility and numerical authority; they are not the final tiled
performance target.

### Bounded Tiled Parity Route

The accepted parity math now runs in a serial 512 x 512 core tile loop with a
12-pixel input halo. Shader coordinates distinguish local workspace positions
from global sensor positions. CFA phase and packed corrected-CFA reads use
global coordinates, while each tile writes only its rectangular core.

The row-ordered direction contract requires two tile sweeps. The first sweep
assembles checker-refined directions into one CPU `u16` plane. The existing
scalar LibRaw scan refines that plane. The second sweep recomputes bounded
candidates, loads the refined directions for the halo region, combines the
selected camera RGB, applies compact CPU Blend highlights, and reads back only
the final core. The GPU keeps one full corrected packed CFA and one full defect
bitset; the original CFA is uploaded per tile. Candidate, YUV, homogeneity,
direction, output, and readback buffers are reused.

On the 6240 x 4168 Sony fixture, 117 tiles produced zero differences across all
78,024,960 final ProPhoto RGB16 channels in one cold and four warm oracle runs.
The generalized full-frame route also retained zero differences after the
coordinate change. The measured tiled buffer allocation was 87,789,308 bytes,
and the largest binding was the 52,016,640-byte corrected CFA. This replaces
the prototype's 2.19 GiB allocation and 417 MB binding without a full-frame
runtime fallback.

An adversarial 546 x 530 synthetic fixture crosses both 512-pixel seams, ends
in rectangular edge tiles, places clustered extreme defects around the seam,
and exercises all four Bayer phases. Each tiled result bit-matched the accepted
full-frame result. A 64 x 46 fixture covers the single-tile path. The 12-pixel
halo remains deliberately conservative; it was not reduced based on these
tests.

Tiling trades memory for dispatch and bounded-readback overhead. Tiled demosaic
totals were 4.64-6.26 seconds in the five-run oracle process, compared with
2.43-2.58 seconds for the full-frame route. The tiled route performs 117 small
direction and RGB readbacks and recomputes interpolation after serial direction
refinement. Phase 3 must remove the final RGB core readback and combine work on
one shared device before performance is judged against the post-unpack product
target.

### GPU-Resident Color and Streamed Export

The productized experimental route uses 1024 x 1024 cores and one shared
WebGPU adapter and device. AAHD writes its selected, highlighted ProPhoto RGB16
core into a GPU buffer consumed directly by the existing corrected-v2 exposure
and 3D LUT shader. Only the final quantized RGB16 core is read back. A bounded
band assembler adapts core rows to the TIFF encoder's fixed strips without a
full-frame JavaScript RGB allocation.

Two reusable output readbacks form an explicit depth-two pipeline. While CPU
prediction and Deflate consume one mapped result, the next tile can execute and
transfer into the other. The exact compact Blend-highlight transform keeps a
separate scratch buffer because its CPU row-order statement semantics are part
of the accepted parity contract. The complete live WebGPU allocation is
212,768,508 bytes and the largest binding is 52,016,640 bytes.

On the 6240 x 4168 Sony fixture, the complete experimental TIFF differed from
the default production export in 51,361 of 78,024,960 channel samples. Every
difference was one code value, no sample exceeded the two-code corrected-v2
contract, and MAE was 0.0006583. One cold and four warm T4 runs measured warm
Worker totals of 4.05-4.72 seconds, GPU pipeline totals of 3.66-4.33 seconds,
color of 129-144 ms, final readback waits of 234-239 ms, and TIFF work of
308-338 ms.

The route is selected only by `rawBackend=webgpu-aahd`. It rejects missing
WebGPU, unsupported sensors, and insufficient adapter limits without changing
decoder. Production export and Preview remain unchanged.

Preview retains the display-sized proxy pipeline integrated from `main`.
Full-resolution parity AAHD is slower than that first-feedback path and would
add an unnecessary dependency. On the same T4, the production Preview measured
60.8 ms EV first-frame p95, 448.9 ms settled p95, 137.2 ms warm-LUT first-frame
p95, and 17 frames during a 60-event input burst. These results satisfy the
Preview behavior contract without routing interactive feedback through the
full-resolution export backend.

## Resource Trade-offs

The full-frame workspace allocates approximately 2.19 GiB and its largest
buffer is 417 MB. The bounded 512-core parity route instead measures 87.8 MB of
live WebGPU buffers with a 52.0 MB maximum binding. This count includes its
reusable readback buffer and excludes CPU direction and final output arrays.

Handwritten WGSL is required for this path. AAHD uses mutable neighborhoods,
integer wrapping, atomic homogeneity accumulation, and discrete refinements.
Representing it as ONNX would add graph dispatches and intermediate tensors
without improving numerical portability or CLI reuse. Native CLI support should
keep LibRaw or use a separate native compute backend; it should not constrain
the browser's performance-critical implementation.

## Recommendation

Continue with tiled handwritten WGSL AAHD. The hybrid full-frame parity route
is now a bitwise LibRaw reference implementation on the tested Sony/T4 case,
but its approximately 2.19 GiB workspace is still unsuitable for product use.

Before production:

- Decide whether product output keeps the proven hybrid parity contract or
  explicitly adopts the faster deterministic defect policy with a new golden.
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
`demosaicBackend=libraw-aahd-wgsl`. `demosaicContract` selects
`libraw-parity` or `deterministic-parallel-candidate`. Diagnostic stages cover
the scaled and corrected CFA, defects, candidates, YUV, homogeneity, chosen and
refined directions, selected AAHD, Blend highlight, and final ProPhoto output.
Setting `librawReference=1` captures and compares the matching internal LibRaw
stage. Setting `candidateReference=1` compares the candidate-only boundaries
with their independent scalar reference. Normal application and end-to-end
paths continue to use production LibRaw.

The CPU baseline is reproducible with:

```text
node scripts/benchmark-libraw-algorithms.mjs --algorithm=AAHD --warmups=1 --samples=3
```

The hardware report requires `WEBGPU_HARDWARE=1`, the AAHD benchmark backend,
the final output stage, and at least five samples so the first run is reported
separately from four warm runs.
