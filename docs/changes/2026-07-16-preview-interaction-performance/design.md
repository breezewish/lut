# Preview Interaction Performance Design

## Introduction

Preview editing uses progressive spatial refinement, layer-scoped work, compact cached LUT assets, and a preview-only transfer table. The final image recipe and 1024px spatial resolution remain unchanged.

## Detailed Design

The persistent Rust renderer retains a longest-edge-1024 RGB16 source. It can render any smaller edge directly from this source and can omit Base output when only the selected LUT changes.

An edit requests a longest-edge-384 interaction frame first. EV refinement waits for 120 ms of idle time before requesting longest-edge 1024, while discrete LUT selection refines immediately. One active plus one latest queued request bounds scheduling state. React accepts results only from the current effect generation. Settled recipe state is separate from displayed interaction state and solely controls export readiness.

Build-time conversion turns each verified CUBE source into a compact binary header, domain, and float32 sample payload. The runtime manifest hashes the binary payload. Parsed LUTs remain cached by identifier for the Worker session.

Base preview quantization uses a 65,536-entry sRGB table. The table is derived from the canonical transfer function and affects only RGBA8 preview output. LUT preview and RGB16 export keep their existing arithmetic.

## Tradeoffs

The transient 384px frame sacrifices spatial detail for latency but preserves exact exposure and LUT color. The 1024px frame follows automatically and remains the only export-ready state.

Caching all LUTs the user touches retains about 17 MiB if every built-in look is selected. This bounded cost avoids repeated fetch, hashing, allocation, and parse work without downloading all assets at startup.

The Base table adds about 64 KiB and at most one 8-bit display-code difference. The measured latency improvement and explicit error bound justify this preview-only approximation; export remains exact.

## Test Plan

- Verify compact binary domain, sample count, finite values, and interpolation against CUBE fixtures.
- Verify LUT-only rendering omits Base allocation and output.
- Exhaustively compare the preview sRGB table with direct transfer evaluation.
- Verify progressive request order, latest-wins behavior, stale-result rejection, and export readiness.
- Run the production Chromium interaction benchmark over EV, every cold LUT, and cached LUT changes.
- Run real-RAW browser/native export parity to prove export output is unchanged.

## Appendix: Benchmark Evidence

Environment: production Chromium build on the project ARM64 reference VM, Sony ILME-FX30 ARW at 6240 × 4168, longest-edge-1024 settled preview.

Before optimization, one measured run produced EV 642 ms, 33³ LUT 867 ms, first 65³ LUT 1194 ms, and a repeated 33³ LUT 823 ms. Every operation waited 200 ms and rendered both 1024px panes.

The acceptance run after optimization measured 20 EV edits, 26 first-access LUTs, and 20 cached LUT changes:

| Operation        | Samples | First frame p95 | Settled frame p95 |
| ---------------- | ------: | --------------: | ----------------: |
| EV               |      20 |           62 ms |            400 ms |
| First-access LUT |      26 |          339 ms |            474 ms |
| Cached LUT       |      20 |          148 ms |            288 ms |

The two 65³ first-access LUTs were the slowest assets. Their load stages were 200 ms and 202 ms, and their complete settled samples were 474 ms and 479 ms. Cached LUT load p95 was below 0.1 ms. The 1024px LUT-only color stage had p95 below 162 ms. Results are stored as Playwright benchmark artifacts and are not committed build output.
