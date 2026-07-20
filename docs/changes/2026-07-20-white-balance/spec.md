# Relative White Balance

## Goal

Let users correct capture white balance before applying a Look, without leaving the local WebGPU workflow.

## Behavior

- Each photo stores relative Temperature and Tint in `[-100, 100]`.
- Zero on both axes is labeled As Shot and preserves the previous output exactly.
- A compact White Balance section follows Exposure. Temperature uses a blue-to-amber track; Tint uses a green-to-magenta track.
- One reset returns both axes to zero.
- Adjustments apply to every selected photo and identify mixed values.
- Preview, Look thumbnails, browser TIFF export, native CLI, and C API use the same recipe.

## Non-goals

- Display absolute Kelvin values.
- Re-run camera-native RAW white balance or interpolate camera profiles.
- Add an eyedropper or automatic neutral-point detector.
