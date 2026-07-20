# Automatic Exposure Baseline Design

## Background

The browser previously treated user EV zero as absolute exposure. LibRaw intentionally disables auto-brightening, so camera normalization headroom made many LUT results too dark. Capture metadata cannot solve this reliably because acquisition settings describe how light reached the sensor, not the desired output brightness after RAW normalization.

## Detailed design

The longest-edge-1024 linear RGB16 source remains resident in WebGPU. One compute pass reduces it into 49 zone luminance sums, 49 zone counts, and a 1024-bin max-RGB histogram. The Worker reads back 4,488 bytes and applies matrix metering: center-weighted zone luminance targets 18% gray, p10 and p90 zone weights reduce outlier influence, and max-RGB p99 limits highlights to 6.0 linear. The resulting gain is bounded to `[0.1, 100]` and stored as EV.

Each photo owns `baseEv` and user `ev`. Every render receives `baseEv + ev`; no interaction reruns metering. An unpreviewed batch item builds and meters a display-sized source before full-resolution export. Performance marks expose the three exposure values so browser output can be compared with an explicit-EV native oracle.

Base display uses a hue-preserving Reinhard shoulder, `1 / (1 + Y)`. This keeps the metered 18% reference near its expected neutral display brightness. LUT processing is otherwise unchanged.

## Trade-offs

Image-derived metering costs one small GPU dispatch and one 4,488-byte readback during initial decode. It is more stable than metadata-derived compensation and is paid only once per photo. The CLI remains deterministic and explicit rather than silently acquiring application policy.

## Test plan

Unit tests freeze uniform-scene targeting, highlight protection, black-scene behavior, and exposure bounds. SwiftShader production E2E proves that the WGSL compiles, the baseline is visible, and browser TIFF output still matches the native oracle when given the reported effective EV.

## Open questions

None.
