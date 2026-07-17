# Fast Preview Pipeline Design

## Introduction

The Preview decoder reduces LibRaw's half-size processing image to display size before work that scales with output pixels. Export retains the existing full-resolution path.

## Background

LibRaw `half_size` reduces a Bayer RAW by only two in each dimension. The Sony acceptance fixture therefore produced a 3120 × 2084 RGB16 image, even though the settled UI uses only 1024 × 684 pixels. Full-image highlight, color conversion, RGB16 creation, and later sampling consumed time and memory for discarded pixels.

## Goals and Non-goals

The design improves initial processed feedback and settled Preview wall time, preserves the 1024px cache and editing budgets, establishes a measured Preview quality contract across sensor families, and keeps export pixels unchanged. It does not replace LibRaw RAW unpacking or create a new demosaic implementation.

## Detailed Design

The browser LibRaw wrapper exposes `openPreview(bytes, maxEdge)`. This entry point enables LibRaw half-size processing and records the requested display edge. LibRaw completes format identification, unpack, active-area handling, black subtraction, camera white balance scaling, and sensor-specific half-size CFA completion. A callback then selects the source samples needed by the oriented display result and replaces the larger four-channel image. Highlight blending, camera-to-ProPhoto conversion, histogram work, and RGB16 creation operate on that bounded image.

The sampler maps output coordinates through LibRaw's flip and transpose rules for both the original and reduced dimensions. This preserves orientation and the same nearest-neighbor sample set used by the previous Preview. Non-square-pixel images retain LibRaw's later geometric processing and are sampled by the Rust renderer.

Legacy diagonal Fujifilm Super CCD is rejected immediately after identification. Cross-checking a real S5Pro RAF showed that the pinned LibRaw full-resolution path loses its blue channel while half-size output does not, so a color-consistent Preview cannot be defined from those two paths. Explicit failure is safer than presenting a misleading edit or performing an export-only full decode during selection.

The Worker copies the bounded RGB16 rows into the existing Rust Preview renderer, publishes a 384px Base/LUT frame, then publishes the export-ready 1024px frame. EV and LUT edits continue to use the persistent cache and latest-wins scheduling.

Export calls the unchanged non-Preview LibRaw entry point with `half_size=false`, receives fresh bytes from the original `File`, and streams the full RGB16 result into the TIFF encoder. No Preview allocation or identifier can supply export pixels.

## Tradeoffs

Nearest-neighbor display sampling preserves the previous Preview exactly on the tested Bayer, X-Trans, linear RGB, and rotated inputs. Compared with full AAHD or X-Trans export, local texture can differ. Display-space fixture statistics constrain overall color and exposure drift while allowing these localized differences.

The Worker remains shared. Splitting it would instantiate the same LibRaw and color WASM modules again only after export is clicked, while the UI intentionally locks editing during export. Current measurements show output-pixel work, not Worker initialization, as the initial bottleneck, so a second Worker would add scheduling and memory ownership without a demonstrated Preview gain.

Generic LibRaw WASM SIMD remains rejected. The prior production experiment improved warm isolated decode by about 7% and changed cold page feedback from 3.06 seconds to 3.04 seconds, which is not material.

## Test Plan

- Compare fast Preview against full export at the same display size for linear, lossy linear, Bayer DNG, rotated Bayer DNG, Bayer ARW, and X-Trans RAF inputs.
- Record linear and rendered RGB8 distributions and emit fixed exact/Preview crops.
- Run cold and warm production Chromium initial Preview benchmarks with real Canvas boundaries.
- Re-run the EV and LUT interaction benchmark.
- Prove native/WASM full-decode and browser/native export parity.
- Run Chromium, Firefox, WebKit, Pages-subpath, decode-failure, and export-failure journeys.

## Appendix: Benchmark Evidence

Environment: production Chromium bundle on the ARM64 reference host, repository Sony ILME-FX30 ARW, five runs with the first cold and four warm.

| Boundary                   | Before |  After | Change |
| -------------------------- | -----: | -----: | -----: |
| Cold settled page wall     | 2.61 s | 1.94 s |   −26% |
| Warm settled page median   | 1.43 s | 0.93 s |   −35% |
| Warm first processed frame | 1.43 s | 0.67 s |   −53% |
| Cold LibRaw Preview        | 2.00 s | 1.16 s |   −42% |
| Warm LibRaw Preview median | 0.82 s | 0.52 s |   −37% |

The final acceptance run drew the cold embedded JPEG at 192 ms, cold first processed frame at 1.42 seconds, and cold settled frame at 1.62 seconds. Warm p95 was 123 ms for the embedded JPEG, 666 ms for the processed frame, and 865 ms for the settled frame. A separate after run observed a 1.66-second cold page wall, confirming normal cold-run variability while remaining below the 2-second settled boundary.

The final interaction run measured EV first-frame p95 57.3 ms and settled p95 380.5 ms, first-access LUT settled p95 126.3 ms, and cached LUT first-frame p95 125.7 ms.

The display-space quality run observed RGB8 mean absolute differences from 5.86 to 7.15 codes, p99 differences from 33 to 63 codes, and absolute per-channel mean signed differences below 1.03 codes across the real Bayer and X-Trans fixtures. Linear inputs were exact. Fixed crop coordinates are Sony `(2400, 1500, 1400, 1000)`, Fujifilm X-Trans `(1800, 1100, 1200, 900)`, and the fixture-specific Leica crops encoded by the verifier.

The external X-Trans fixture is the raw.pixls.us CC0 Fujifilm X-T1 RAF at `https://raw.pixls.us/data/Fujifilm/X-T1/20171229_110916.RAF`, SHA-256 `e994a1fd6e87e392432fe146a35b0b88584dc2bd50bee2c8c7e886ac2b59fcde`. The rejected legacy-layout audit uses the raw.pixls.us CC0 Fujifilm S5Pro RAF at `https://raw.pixls.us/data/Fujifilm/FinePix%20S5Pro/2018_06150003.RAF`, SHA-256 `aca2b2ebcf90d248b4f822ed78bfeb73e79f1b64164a87dc2051a96726cdfa0c`.
