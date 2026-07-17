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

LibRaw remains responsible for RAW unpack and metadata. It also remains the
legacy image reference, except where its result depends on the rejected serial
defect-scan order. For that boundary, an independent deterministic CPU
implementation must define the new golden output.

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

Replace it with an immutable-neighborhood rule:

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
immutable-neighborhood rule as a small independent CPU reference. The WGSL
scaled corrected mosaic and packed defect mask must match that CPU reference
exactly.

Avoid a full separate unpacked/scaled `u32` full-frame buffer. The defect pass
can scale the packed raw center and neighbors directly, then write a packed
corrected mosaic and packed defect bitset. At 26 MP, each 16-bit packed mosaic
is about 52 MB and a one-bit-per-pixel mask is about 3.25 MB.

### Direction refinement race

`refine_isolated` also reads and writes `directions` in one dispatch. A local
experiment that disabled it changed only 169 channel values, but the pass is
still nondeterministic by contract. Convert it to out-of-place ping-pong
storage and validate it against an independent CPU reference.

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

### Phase 1: Make the full-frame math deterministic

- Add the independent CPU preprocessing reference.
- Replace the in-place serial-like defect emulation with the immutable
  corrected-mosaic and defect-mask contract.
- Make isolated direction refinement out-of-place.
- Keep candidate interpolation, checker refinement, homogeneity selection,
  highlight behavior, matrix conversion, and quantization semantically
  unchanged unless a reference test proves an existing error.
- Review and record the new golden output. Do not describe expected
  defect-policy differences as LibRaw regressions.

Gate: repeated WGSL runs are bitwise identical. The corrected mosaic, defect
mask, and direction refinements bit-match their independent CPU references.
Ordinary, non-defect pixels retain the established LibRaw parity. All remaining
differences are localized and explained by the documented defect contract.

### Phase 2: Tile AAHD

- Add bounded halo input and core output coordinates to every dependent pass.
- Reuse a bounded workspace across tiles.
- Cover rectangular image edges and every Bayer CFA phase.
- Add synthetic seam and dependency fixtures.
- Measure live allocation and maximum binding size.

Gate: every RGB16 channel in the tiled output bit-matches the deterministic
full-frame WGSL oracle. There are zero seam differences. Peak GPU allocation is
at most 256 MB and no storage binding exceeds the intended browser limit.

This is the immediate required deliverable. Do not start Phase 3 until this
gate is met and reported.

### Phase 3: Keep color and LUT processing on the GPU

- Introduce the shared WebGPU runtime.
- Pass tile output buffers directly into highlight, matrix, grading, and 3D LUT
  pipelines.
- Preserve the existing WebGPU LUT code and its oracle tests.
- Quantize once, after the final color operation.

Gate: there is no intermediate CPU RGB16 transfer. For operations that are
defined in integer code values, require exact output. For floating-point color
operations, require exact output where feasible; otherwise document the count,
maximum, and location of every nonzero code-value difference and obtain an
explicit acceptance threshold. Never hide a large local error behind PSNR.

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

- Defect preprocessing and isolated direction refinement are deterministic and
  match independent CPU references.
- The new defect-policy golden is documented and reviewed rather than inferred
  from one GPU output.
- Tiled AAHD bit-matches deterministic full-frame AAHD for every tested sample,
  with zero tile-seam differences.
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
