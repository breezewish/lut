# Preview Latency Round Two Design

## Introduction

This change reduces Preview latency at two independent boundaries: construction of the persistent display-sized RAW source and publication of completed interaction frames. The implementation keeps the existing single-worker model and adds no second scheduler or color pipeline.

## Background

The Preview decoder already resized LibRaw's half-size image before point color operations. For a 6240 × 4168 Bayer RAW, however, LibRaw still copied roughly 6.5 million half-size CFA cells and scanned the sensor for a per-photo maximum before retaining about 0.7 million display pixels. During editing, the worker completed many 384px renders, but React cleanup suppressed all intermediate results while new EV values continued to arrive.

## Goals and non-goals

The design must materially improve initial Bayer Preview and continuous EV feedback, preserve the 1024px settled size, satisfy the existing display-space quality contract across Bayer, rotated Bayer, linear DNG, and X-Trans fixtures, and leave export unchanged. It does not add GPU work, a custom RAW unpacker, or approximate LUT semantics.

## Detailed design

### Standard Bayer Preview construction

The Preview-only LibRaw subclass overrides the Bayer copy boundary. Once LibRaw has identified the active area and prepared black-level metadata, the override maps every target display cell through the final orientation to the exact half-size CFA cell used by the existing nearest-neighbor Preview. It reads only that cell's 2 × 2 Bayer samples, subtracts the corresponding channel black level, and writes a display-sized four-channel processing image.

The fast boundary is enabled only for standard Bayer, half-size processing, square pixels, ordinary geometry, and a valid unpacked Bayer plane. All other inputs retain LibRaw's normal sensor-specific copy and completion followed by the established display-size selection. This keeps X-Trans, linear DNG, non-square-pixel input, and special Fuji geometry outside assumptions that apply only to 2 × 2 Bayer cells.

Preview disables LibRaw's exposure-specific maximum adjustment and retains the camera white level. The full sensor scan existed to lower normalization for a particular photo; it is not required by the Preview quality contract and costs more than the display-sized CFA construction. Export never sets this Preview parameter and continues to use the exact default behavior.

### Continuous interaction publication

Every scheduled Preview recipe receives a monotonically increasing generation. The worker remains bounded to one active render and one latest waiting render. A completed 384px result may publish when its file and LUT still match the desired interaction and its generation is newer than the last painted generation. This permits visible progress through an EV burst without allowing a late older result to move the image backward.

Settled results retain strict current-recipe validation. Cleanup cancels pending refinement, file or LUT identity rejects results from another editing context, and export remains disabled until the exact current recipe reaches 1024px.

## Trade-offs

Using camera white level introduces a small Preview-only normalization difference for files whose measured sensor maximum would make LibRaw lower its working maximum. This is preferable to scanning every sensor sample because Preview explicitly permits bounded display error, and the measured signed channel drift remains within the product contract. Exact export remains the reference.

The scheduler deliberately permits bounded EV staleness during active input. Suppressing those completed frames produces a frozen editor even though useful work is available. Monotonic generation and strict file/LUT boundaries make the relaxed rule easy to reason about, while the final settled rule remains exact.

## Test plan

- Run the production initial-Preview benchmark for cold and warm selection.
- Run isolated EV, cold LUT, warm LUT, and continuous 60 Hz EV benchmarks through Canvas drawing.
- Compare Preview with full export at the same display size for linear, lossy linear, Bayer, rotated Bayer, Sony ARW, and Fujifilm X-Trans fixtures.
- Confirm legacy diagonal Fuji input still fails explicitly.
- Run native/WASM export parity, multi-browser production smoke, repository-subpath Pages tests, and failure-boundary tests.

## Unresolved questions

RAW unpack remains the largest warm LibRaw stage at about 193–195ms on the acceptance fixture. Reducing it requires a format-aware partial unpacker or a different decoder boundary and is intentionally outside this change.

## Appendix A: Production benchmark

The reference environment is the production Chromium bundle on the ARM64 VM with the repository Sony ILME-FX30 ARW (6240 × 4168, 31.8MiB). Times begin at the file-selection handler and end at Canvas drawing.

| Initial Preview            |    Before | Retained implementation |
| -------------------------- | --------: | ----------------------: |
| Cold 384px processed frame |    1443ms |                   927ms |
| Cold 1024px settled frame  |    1644ms |                  1128ms |
| Cold LibRaw Preview        |    1224ms |                   674ms |
| Warm 384px processed frame | 635–670ms |               429–445ms |
| Warm 1024px settled frame  | 835–872ms |               627–643ms |
| Warm LibRaw Preview        | 524–533ms |               292–301ms |

The retained implementation reduces warm LibRaw time by about 43–45%, warm first-frame wall time by 30–36%, and warm settled wall time by 23–28%. The cold run is more variable but improved by 31–36% at the visible boundaries and 45% inside LibRaw in the final five-sample run.

| Interaction                              |      Before | Retained implementation |
| ---------------------------------------- | ----------: | ----------------------: |
| Measured 60-event input duration         | about 980ms |                 985.9ms |
| Painted 384px frames during 60 inputs    |           1 |                      31 |
| First frame after burst start            |      1028ms |                  36.9ms |
| Final interaction frame after last input |        48ms |                  39.6ms |
| Exact settled frame after last input     |       378ms |                 375.6ms |
| Isolated EV first-frame p95              |  about 60ms |                  57.3ms |
| Isolated EV settled p95                  | about 400ms |                 395.2ms |
| Warm LUT p95                             | about 126ms |                 124.6ms |

The scheduler improves continuity without increasing isolated edit or LUT latency.

## Appendix B: Quality results

Preview and full export were rendered through the same display transform at 1024px. Linear fixtures remained exact. RGB8 results stayed within the existing mean ≤12, p99 ≤80, and absolute per-channel signed mean ≤2 contract.

| Fixture                    | Mean absolute | p99 absolute | Largest absolute signed-channel mean |
| -------------------------- | ------------: | -----------: | -----------------------------------: |
| Leica M8 Bayer DNG         |          7.18 |           60 |                                 1.30 |
| Rotated Leica M8 Bayer DNG |          7.19 |           60 |                                 1.30 |
| Sony ILME-FX30 Bayer ARW   |          5.86 |           33 |                                 0.49 |
| Fujifilm X-T1 X-Trans RAF  |          7.09 |           63 |                                 0.90 |

The X-Trans and legacy Fuji fixtures match the immutable raw.pixls.us hashes recorded by the first fast-preview design.

## Appendix C: Rejected candidates

Early Bayer selection while retaining LibRaw's full sensor maximum scan reduced warm LibRaw time only from about 532ms to 483–493ms and visible warm first-frame time from 635–670ms to 600–623ms. The 5–9% gain did not justify the specialized path alone, so that version was not retained. Removing the unnecessary Preview scan made the combined result material.

A 16,384-entry piecewise V-Log table with linear interpolation bounded encoding error to `1.22e-5`, but production timing did not improve: 1024px Base + LUT remained 193–198ms and warm LUT p95 changed from about 125.7ms to 126.7ms. The table and its added complexity were removed.
