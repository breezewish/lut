# WebGPU AAHD Implementation Handoff

## Purpose

This document hands the WebGPU Bayer pipeline work to the next implementation
agent. It is self-contained and records the repository state, verified facts,
technical decisions, work sequence, and acceptance gates.

The immediate objective is not to add another demosaic experiment. It is to
turn the proven full-frame AAHD prototype into a deterministic, bounded-memory
pipeline that can later stay on the GPU through color processing and export.

Delete this temporary implementation document after the production work is
finished and its durable decisions have been incorporated into the SSOT design
and test documents.

## Repository State

Work only in this worktree:

```text
/home/ubuntu/lut-lab/lut-webgpu-demosaic
```

The branch is:

```text
codex/webgpu-demosaic-prototype
```

The current prototype commit is:

```text
0ae6395 perf: prototype LibRaw AAHD on WebGPU
```

The branch already contains the WebGPU color and 3D LUT prototype in its
history:

```text
0ae6395 perf: prototype LibRaw AAHD on WebGPU
2378ddc perf: prototype native WebGPU raw pipeline
c5b9f06 perf: prototype WebGPU demosaic
479f564 perf: compare ONNX color export
```

Do not cherry-pick or merge `479f564` from the retained
`/home/ubuntu/lut-lab/lut-webgpu-prototype` worktree. Its code is already an
ancestor of this branch. Leave that separate worktree untouched.

Do not switch or modify the shared main worktree. Commit complete phases on
this branch with Conventional Commit messages. Do not merge to main unless the
user explicitly requests it. If a merge is later requested, follow the
repository's temporary integration worktree, squash, and `ff-only` rules.

## Source Material

Read these files before changing the implementation:

- `docs/changes/2026-07-17-libraw-aahd-webgpu-prototype/design.md` contains the
  verified numerical and performance report.
- `docs/changes/2026-07-17-libraw-aahd-webgpu-prototype/test.md` contains the
  existing test design.
- `web/src/demosaic/libraw-aahd.wgsl` contains the full-frame WGSL AAHD port.
- `web/src/lib/libraw-aahd.ts` owns its WebGPU pipelines, buffers, dispatches,
  capture, and readback.
- `crates/alchemy-libraw/src/browser_wrapper.cpp` exposes the benchmark-only
  LibRaw oracle.
- `crates/alchemy-libraw/src/aahd_capture.patch` adds oracle capture hooks to
  the build without modifying the pinned vendor worktree.
- `web/src/workers/processing.worker.ts` dispatches the opt-in benchmark.
- `web/e2e/demosaic-performance.spec.ts` drives hardware measurements.
- `scripts/benchmark-libraw-algorithms.mjs` measures the CPU/WASM reference.
- `web/src/lib/webgpu-color.ts` and `web/src/lib/color-transform.wgsl` contain
  the retained WebGPU color and LUT prototype.
- `web/src/lib/tiff-export.ts` contains the current strip export boundary.

The LibRaw oracle can capture `horizontal`, `vertical`, `directions`, `aahd`,
and `final`. Keep it opt-in. Normal production decode must not pay for capture
allocations or copies.

## Test Baseline and Authority

“Correct” means matching the current production pipeline, not Studio and not a
new WGSL output. The normative end-to-end reference is:

```text
pinned project LibRaw AAHD
    -> LibRaw Blend highlight and linear ProPhoto RGB16
    -> Rust corrected-v2 exposure and 3D LUT
    -> decoded RGB16 pixels from the produced TIFF
```

The demosaic reference is the project's pinned LibRaw source and build
semantics. It is not a Python implementation. The independent Python float64
oracle mentioned in the browser change tests validates corrected-v2 color and
LUT processing only; it does not implement RAW scaling or AAHD.

Use this baseline matrix. A lower row does not replace the authority of an
earlier row.

| Boundary under test                       | Normative reference                                                                                                               | Required comparison                                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Visible raw mosaic and sensor metadata    | The values returned by the same pinned LibRaw instance after unpack                                                               | Exact dimensions, CFA, levels, matrices, metadata, and packed samples                                                                                        |
| Scaled CFA before AAHD defect handling    | `aahdInputView` captured inside pinned LibRaw                                                                                     | Exact for every sample                                                                                                                                       |
| Horizontal and vertical AAHD candidates   | `aahdHorizontalView` and `aahdVerticalView` captured inside pinned LibRaw, including its serial hot/dead scan                     | Exact for every RGB channel if claiming LibRaw parity                                                                                                        |
| Refined direction flags                   | `aahdDirectionView` captured inside pinned LibRaw                                                                                 | Exact for every pixel if claiming LibRaw parity                                                                                                              |
| Selected camera-space AAHD RGB            | `aahdOutputView` captured immediately after LibRaw AAHD                                                                           | Exact for every RGB channel if claiming LibRaw parity                                                                                                        |
| Blend highlight and linear ProPhoto RGB16 | Pinned LibRaw `imageView` from the production parameters                                                                          | Exact is the target; at most one code value may be proposed only as an explicitly reported floating-point portability tolerance, with zero samples above one |
| Exposure and 3D LUT RGB16                 | Current Rust corrected-v2 CPU/WASM renderer for the same ProPhoto RGB16 input, independently covered by the Python float64 oracle | Use the existing WebGPU color contract: report every difference and reject any sample above two code values                                                  |
| Complete export                           | Decoded RGB16 samples from the current production browser/native CLI TIFF for the same RAW, EV, and LUT                           | Compare dimensions and every decoded RGB16 sample; do not use compressed TIFF byte identity as the image criterion                                           |

The tiled full-frame WGSL output is only a derived regression oracle. It proves
that tiling did not change already accepted math. It cannot prove that the math
matches LibRaw. A full-frame WGSL implementation must first pass the normative
stage references above before tiled output may use it as an oracle.

The current parallel defect experiment does not pass the normative LibRaw
baseline because some final differences exceed one code value. Its 0.00385%
difference rate and high PSNR do not make it a parity implementation.

A deterministic parallel defect policy has a different authority:

- Its independent scalar CPU implementation is normative only for that
  experimental policy.
- WGSL preprocessing, AAHD stages, and final RGB16 must match that CPU reference
  at every corresponding boundary.
- Passing this comparison proves faithful implementation of the proposed new
  policy. It does not prove compatibility with current LibRaw output.
- It may replace the production golden only after the user explicitly accepts
  the behavior change, including the localized high-code-value differences.

Until that decision exists, maintain two clearly named benchmark results:
`libraw-parity` and `deterministic-parallel-candidate`. Never mix their metrics
or describe the candidate's CPU oracle as the product baseline.

## Established Evidence

The 6240 x 4168 Sony fixture contains 78,024,960 RGB16 channel values. On an
AWS `g4dn.xlarge` with an NVIDIA T4, the verified medians were:

| Measurement                            | LibRaw/WASM | Full-frame WGSL |     Speedup |
| -------------------------------------- | ----------: | --------------: | ----------: |
| AAHD core                              |    7,070 ms |     about 79 ms |   about 90x |
| Worker through CPU-readable RGB16      |    8,729 ms |          572 ms | about 15.2x |
| Estimated worker with GPU-resident RGB |    8,729 ms |    about 400 ms |   about 21x |

The current full-frame POC is not shippable. It allocates about 2.19 GiB and
requires a 417 MB storage binding. The 156 MB RGB16 readback alone took about
165 ms.

Its final RGB16 differs from the pinned LibRaw result in 3,003 of 78,024,960
channel values, or 0.00385%. MAE is 0.001314 code values and the maximum local
difference is 1,033. These sparse large differences come from LibRaw's serial,
stateful hot/dead-pixel scan. They are not diffuse AAHD or color-matrix error.

The candidate-level evidence is:

| Boundary                 | Differing values | Maximum |
| ------------------------ | ---------------: | ------: |
| Horizontal candidate     |            1,027 |   1,237 |
| Vertical candidate       |            1,018 |   1,237 |
| Refined direction pixels |       528 pixels |     n/a |
| Selected AAHD RGB        |            1,430 |   1,743 |

A second parallel defect pass reduced horizontal differences from 1,027 to
526, but also repaired pixels that LibRaw's forward scan had already passed.
Repeated passes therefore do not reproduce the serial algorithm and must not
be used as an empirical convergence trick.

## Product Direction

Use handwritten WGSL for the browser Bayer path:

```text
LibRaw unpack and metadata
    -> deterministic WGSL sensor preprocessing
    -> tiled WGSL AAHD
    -> WGSL highlight, color matrix, grading, 3D LUT, and RGB16 quantization
    -> bounded CPU readback
    -> TIFF predictor, Deflate, and Blob
```

LibRaw remains responsible for RAW unpack and metadata. Current pinned LibRaw
output remains the product image reference, including its serial defect-scan
effects. A deterministic parallel policy is a performance and image-semantics
candidate, not an accepted replacement baseline.

Do not introduce ONNX. AAHD depends on mutable integer neighborhoods, defined
integer wrapping, atomic homogeneity accumulation, and discrete refinements.
An ONNX graph would add dispatches and tensors without providing useful browser
or CLI portability.

Do not use WebGL. Do not match Studio, RCD, or Markesteijn. Do not add X-Trans.
Do not change the production default during the implementation phases below.

## Correctness Problems in the Current POC

### Defect scan race

`hide_hot_pixels` reads and writes the horizontal and vertical candidates in
the same dispatch. Invocation order is not defined. This is both the source of
the LibRaw mismatch and a cross-device nondeterminism risk.

Evaluate an immutable-neighborhood rule as the fully parallel candidate:

1. Read every center and neighbor from the original scaled mosaic.
2. Classify the center once.
3. Write the corrected mosaic to a separate output.
4. Write a packed defect bit for every replaced sample.
5. Never iterate the pass.

Preserve the useful LibRaw semantic in the AAHD `combine` stage: interpolation
uses corrected values so defects do not propagate, but a known CFA sample that
was marked as defective is restored from its original scaled value in the
final selected camera RGB. This separates neighbor reconstruction from sensor
sample ownership.

The WGSL implementation is not its own oracle. First implement the same
immutable-neighborhood rule as a small independent CPU reference. The CPU
reference must cover every downstream AAHD boundary affected by the changed
mosaic, not only the defect mask. The WGSL corrected mosaic, packed defect
mask, candidates, directions, selected AAHD, and final ProPhoto RGB16 must
match the corresponding candidate reference contract.

Separately retain a LibRaw-parity route for the feasibility decision. That
route must preserve the serial `hide_hots` result, either by extracting that
bounded pass into CPU/WASM before GPU AAHD or by another implementation proven
exact against the internal LibRaw candidate captures. The measured 434 ms CPU
cost is part of this route's performance result and must not be omitted.

Avoid a full separate unpacked/scaled `u32` full-frame buffer. The defect pass
can scale the packed raw center and neighbors directly, then write a packed
corrected mosaic and packed defect bitset. At 26 MP, each 16-bit packed mosaic
is about 52 MB and a one-bit-per-pixel mask is about 3.25 MB.

### Direction refinement race

`refine_isolated` also reads and writes `directions` in one dispatch. A local
experiment that disabled it changed only 169 channel values, but the pass is
still nondeterministic by contract. For the deterministic parallel candidate,
convert it to out-of-place ping-pong storage and validate it against the
candidate CPU reference. For the LibRaw-parity route, preserve and verify the
pinned row-major result; out-of-place refinement is not equivalent merely
because it is deterministic.

`refine_checker_even` and `refine_checker_odd` are intentionally separate and
parity-safe. Each pass writes one checker parity and reads orthogonal neighbors
of the opposite parity. The odd pass intentionally observes the completed even
pass. Keep this ordering.

Homogeneity accumulation uses integer atomics and is deterministic. Do not
replace it merely to make the shaders look uniform.

## Tiled AAHD Design Constraints

The full-frame deterministic WGSL result becomes the tile oracle. Every tiled
output sample must match it exactly, including samples adjacent to tile seams.
Do not use visual inspection or a low aggregate error as the seam test.

Do not assume LibRaw's `nr_margin = 4` is the required tile halo. It is image
padding, not a complete dependency proof. Candidate interpolation reaches
radius two. Homogeneity contributions and 3 x 3 direction sums extend the
dependency. Checker refinement and deterministic isolated refinement extend it
again. The effective raw dependency may reach roughly nine pixels.

Start with a conservative 12-pixel halo. Prove the minimum safe halo by
comparing every tiled output sample against the deterministic full-frame
result on real and adversarial synthetic images. Shrink it only with evidence.

Start with a 1024 x 1024 output core, but treat tile size as an empirical
resource choice. Edge tiles are rectangular. Use global image coordinates for
CFA phase and image-edge padding. Dispatch the halo but write only the tile
core.

The full-frame implementation remains a correctness oracle for the same
deterministic math. It must not become a runtime fallback when tiling fails or
an adapter limit is too small. Reject unsupported hardware or geometry
explicitly.

The initial memory budget is:

| Resource                     | Approximate 26 MP size |
| ---------------------------- | ---------------------: |
| Original packed raw mosaic   |                  52 MB |
| Corrected packed mosaic      |                  52 MB |
| Packed defect mask           |                3.25 MB |
| One 1 MP AAHD tile workspace |              80-100 MB |
| Tile output and readback     |            about 12 MB |

Target peak WebGPU allocation is at most 256 MB. The stretch target is 128 MB.
Reaching the stretch target may require a 768 or 512 pixel tile and more
aggressive buffer lifetime reuse. Measure actual allocations rather than
inferring them only from the table.

## Shared WebGPU Runtime

Create one explicit runtime object that owns the adapter, device, immutable
pipelines, and reusable buffers for preprocessing, AAHD, color, and LUT work.
It should have one responsibility: manage shared WebGPU execution resources and
their lifetime.

`WebGpuColorRenderer.create()` currently requests its own adapter and device.
`renderStrip(source: Uint16Array, ev)` also uploads CPU RGB16 for every strip.
Refactor this boundary only after tiled AAHD is correct. The color stage must
accept a GPU buffer and range produced by AAHD on the same device. There must
be no AAHD-to-CPU-to-color round trip.

Do not allocate a full-frame 156 MB final RGB16 output. Process highlight,
camera-to-ProPhoto, grading, and LUT for each tile or export strip. Read back
only the final quantized region needed by the CPU encoder. Preview should
remain as a GPU texture and be downsampled there.

Start with a serial tile loop because it is easiest to prove correct. After all
numeric gates pass, add two bounded readback buffers so GPU work for tile N + 1
can overlap CPU TIFF prediction and Deflate for tile N. Keep queue depth and
memory ownership explicit.

## Implementation Sequence and Gates

Complete the phases in order. Do not begin a later phase merely because an
earlier one looks visually correct.

### Phase 0: Reproduce the existing evidence

- Build and run the current opt-in POC without changing its math.
- Confirm the known Sony fixture counts and stage timing shape.
- Confirm normal application decode still uses production LibRaw.

Gate: record a fresh baseline with environment, adapter, fixture, commit, cold
run, and at least four warm runs. Investigate material deviations before
proceeding.

### Phase 1: Establish parity and candidate references

- Make the internal pinned LibRaw captures the executable stage-by-stage parity
  tests described in the baseline matrix.
- Implement and measure the LibRaw-parity route, including the exact serial
  defect and isolated-direction semantics wherever parallel WGSL cannot
  reproduce them.
- Add an independent scalar CPU reference for the immutable-neighborhood
  parallel candidate.
- Replace in-place defect and isolated-direction writes in that candidate with
  immutable or ping-pong storage.
- Keep candidate interpolation, checker refinement, homogeneity selection,
  highlight behavior, matrix conversion, and quantization semantically
  identical to pinned LibRaw unless a reference test proves an existing port
  error.
- Report the two routes separately. Do not regenerate or rename the production
  golden in this phase.

Gate: the `libraw-parity` route exactly matches all integer LibRaw boundaries
and has no final ProPhoto RGB16 difference above one code value. The
`deterministic-parallel-candidate` is bitwise repeatable and matches its
independent CPU reference at every affected stage. Any difference between the
candidate and LibRaw is reported separately with counts, maxima, coordinates,
and affected images. Passing the candidate reference does not pass the product
parity gate.

### Phase 2: Tile the accepted AAHD math

- Add bounded halo input and core output coordinates to every dependent pass.
- Reuse a bounded workspace across tiles.
- Cover rectangular image edges and every Bayer CFA phase.
- Add synthetic seam and dependency fixtures.
- Measure live allocation and maximum binding size.

Gate: every RGB16 channel in the tiled output bit-matches the corresponding
accepted full-frame route. There are zero seam differences. The full-frame
route must also still pass its normative LibRaw or candidate CPU reference;
tiled/full-frame equality alone is insufficient. Peak GPU allocation is at
most 256 MB and no storage binding exceeds the intended browser limit.

This is the immediate required deliverable. Do not start Phase 3 until this
gate is met and reported.

Phase 2 completed on 2026-07-17. The `libraw-aahd-wgsl-tiled` benchmark route
uses 512 x 512 cores, a conservative 12-pixel halo, two bounded tile sweeps
around the exact CPU row-order direction refinement, and reusable buffers.
The 26 MP Sony oracle had zero final-channel differences in one cold and four
warm runs. Peak WebGPU buffer allocation was 87,789,308 bytes and the maximum
binding was 52,016,640 bytes. The full-frame parity oracle remained exact.
Hardware synthetic tests covered both seam axes, rectangular edges, all four
Bayer phases, clustered seam defects, and an image smaller than one tile with
zero tiled/full-frame differences. Phase 3 may now begin; it remains
unimplemented in this change.

### Phase 3: Keep color and LUT processing on the GPU

- Introduce the shared WebGPU runtime.
- Pass tile output buffers directly into highlight, matrix, grading, and 3D LUT
  pipelines.
- Preserve the existing WebGPU LUT code and its oracle tests.
- Quantize once, after the final color operation.

Gate: there is no intermediate CPU RGB16 transfer. For operations that are
defined in integer code values, require exact output. Compare color and LUT
output against the current Rust corrected-v2 CPU/WASM renderer for the same
accepted ProPhoto input. Reject any sample above the existing two-code-value
contract and report the count, maximum, and location of every nonzero
difference. Never hide a large local error behind PSNR.

### Phase 4: Stream export

- Feed final tile or strip readback into TIFF prediction and Deflate.
- Bound readback to two buffers.
- Add overlap only after the serial version is correct.
- Include Blob construction in complete-export timing.

Gate: the exported TIFF decodes to the accepted RGB16 golden, output bytes are
stable where the encoder is deterministic, and peak GPU plus JS/WASM memory
stays bounded across repeated exports.

### Phase 5: Integrate as an experimental product backend

- Expose one explicit opt-in Bayer backend.
- Fail clearly on unsupported sensors, adapter limits, or missing WebGPU.
- Keep the production default unchanged until fixture coverage and client-GPU
  evidence are sufficient for a separate product decision.
- Remove benchmark-only surfaces that are no longer useful, but retain focused
  numerical diagnostics.

Gate: unit, build, native workspace, and full browser end-to-end suites pass.
The experimental path is covered by behavior-driven E2E tests on supported
hardware and cannot silently fall back to a different decoder.

## Correctness Matrix

At minimum, fixtures must cover:

- Multiple Bayer cameras and every CFA phase.
- Unequal per-channel black levels and white levels.
- Image borders and rectangular edge tiles.
- Clipped highlights and Blend highlight behavior.
- Isolated hot pixels, isolated dead pixels, adjacent defects, and defect
  clusters near tile seams.
- Very dark gradients, sharp color edges, checker patterns, and saturated
  primary colors.
- Dimensions smaller than one tile and dimensions not divisible by tile size.
- Repeated execution on the same device and execution after workspace reuse.

For each relevant fixture, compare intermediate boundaries, not only final
RGB16. The minimum useful boundaries are corrected mosaic, defect mask,
horizontal candidate, vertical candidate, refined directions, selected AAHD,
and final color output.

Unsupported non-Bayer formats, including X-Trans, must produce an explicit
error in the experimental backend. They are not part of this project.

## Performance Contract

Report these three product metrics separately:

- Processing preview: time from an already unpacked RAW or cached sensor source
  to the first usable interactive preview. Target at most 200 ms. A dedicated
  proxy path may be required; do not claim this target from full-resolution
  AAHD timing alone.
- Complete decode: input copy, LibRaw open/unpack, preprocessing, AAHD, highlight,
  color, LUT, final RGB16 production, and required readback. Target the 26 MP
  post-unpack GPU portion at at most 500 ms on the reference T4.
- Complete export: complete decode plus TIFF prediction, Deflate, and Blob.
  Report it separately because CPU compression may dominate after AAHD moves to
  the GPU.

Every hardware report must include:

- Browser, OS, GPU, adapter name, driver, commit, fixture, and dimensions.
- Whether the adapter is a fallback adapter. A fallback adapter is not an
  accepted hardware result.
- One cold run and at least four warm runs.
- Input and upload, LibRaw unpack, preprocessing, tiled AAHD, highlight and
  color, 3D LUT, readback, Deflate, Blob, and wall time.
- Peak GPU allocation, maximum binding size, JS/WASM memory where measurable,
  and tile size.
- Complete numerical comparison statistics for the same output.

Performance gains do not relax correctness gates. Likewise, a correct POC that
exceeds the memory limit is not production-feasible.

## Commands

Run the ordinary repository checks after each completed phase:

```text
npm test -- --run
npm run check
npm run test:e2e
```

Run the CPU/WASM AAHD reference with:

```text
node scripts/benchmark-libraw-algorithms.mjs --algorithm=AAHD --warmups=1 --samples=3
```

Run the warm hardware final-output benchmark with:

```text
WEBGPU_HARDWARE=1 \
DEMOSAIC_PERF=1 \
DEMOSAIC_PERF_BACKEND=libraw-aahd-wgsl \
DEMOSAIC_PERF_OUTPUT_STAGE=final \
DEMOSAIC_PERF_SAMPLES=5 \
PLAYWRIGHT_HTTP_PORT=46731 \
npx playwright test web/e2e/demosaic-performance.spec.ts --project=chromium
```

Add `DEMOSAIC_PERF_LIBRAW_REFERENCE=1` and use one sample when capturing the
expensive internal LibRaw oracle. Do not enable it in routine production E2E
runs.

If package scripts or environment names change, update this document and the
test design in the same commit. Never report a command as passing unless it was
actually run in the current worktree.

## GPU Development VM

The VM used for the original measurements was terminated and deleted. No
active machine or reusable branch credentials remain.

If hardware testing is required, create a VM dedicated to this branch and
follow `AGENTS.md` and `docs/local_dev/ref.md` exactly:

- AWS `g4dn.xlarge`.
- Ubuntu 24.04 and 100 GB gp3.
- Name `lut-dev-codex-webgpu-demosaic-prototype` or the branch-equivalent name
  required by the repository convention.
- Record connection details in `docs/local_dev/dev_vm.md`.
- Store the generated local key in `docs/local_dev/id` and never commit it.
- Change SSH to port 2222 and allow inbound port 2222 as required by the
  project instructions.
- Never use a VM belonging to another branch.
- Stop the VM whenever active testing is finished.
- Terminate and delete it if this worktree is removed or merged.

Environment-specific connection data and credentials must never be committed.

## Failure Policy

Do not add silent fallbacks. In particular:

- Do not fall back to the 2.19 GiB full-frame POC when tiling fails.
- Do not fall back to CPU AAHD inside the experimental backend.
- Do not silently select another demosaic algorithm.
- Do not accept an unknown CFA layout as Bayer.
- Do not turn a numerical mismatch into a broad tolerance without locating and
  explaining it.

Fail clearly and keep unsupported cases visible. This project values a small,
provable supported surface over a complex path that sometimes produces an
unidentified result.

## Definition of Done

The immediate assignment is complete only when all of the following are true:

- The LibRaw-parity route passes the pinned internal LibRaw references at every
  AAHD boundary and has no final ProPhoto RGB16 difference above one code.
- The deterministic parallel candidate, if retained, matches its independent
  CPU reference and is clearly reported as a separate behavior proposal rather
  than a new production golden.
- Tiled AAHD bit-matches its accepted full-frame route for every tested sample,
  with zero tile-seam differences; that full-frame route independently passes
  its normative algorithm reference.
- Peak GPU allocation is at most 256 MB and the implementation does not depend
  on the current 417 MB binding.
- A non-fallback hardware WebGPU run records cold and warm timings plus stage
  and memory data.
- Normal production decoding remains unchanged and all ordinary checks pass.
- The change design and test documents reflect the final verified contract.

Phases 3 through 5 are the subsequent productization assignment. They are done
only when AAHD output stays on one WebGPU device through color and LUT, export
uses bounded strip readback, the accepted numeric contracts pass, and the path
is exposed as an explicit experimental backend without fallback.
