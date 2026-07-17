# WebGPU Preview Specification

## Goal

Preview must provide fine visual feedback while exposure or Look controls move. A WebGPU-capable browser renders the existing longest-edge-1024 Preview contract directly instead of showing a 256px interaction proxy and waiting for idle refinement.

## Behavior

Initial RAW processing remains progressive: the embedded JPEG may appear first, followed by processed 384px and 1024px comparisons. Once the display-sized source is ready, every WebGPU EV or LUT response is a 1024px corrected-v2 Base or Look image. The latest recipe wins, stale work never grows into a queue, and export becomes ready only for the exact visible recipe.

Browsers without WebGPU fail with a visible compatibility error. Preview may still differ from full-resolution export under the established display-sized proxy contract.

## Performance

The production Chromium bundle on the branch-owned T4 must render EV changes at 1024px with p95 below 80 ms. Cold and warm LUT changes must remain below 200 ms. A nominal 60-event, one-second EV burst must paint at least 30 full-detail frames, with the first below 80 ms and the final exact frame below 100 ms after input ends.

These are evidence gates, not an instruction to continue optimizing after measured bottlenecks no longer offer material user value.
