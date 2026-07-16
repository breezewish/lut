# Preview Latency Round Two Specification

## Background

The first fast-preview change separated display-sized Preview from full-resolution export and made isolated EV and LUT changes meet editor latency budgets. Two gaps remained: standard Bayer import still copied and scanned millions of half-size CFA cells that could never reach the 1024px Preview, and latest-wins scheduling hid every completed EV frame except the final one during continuous input.

## Requirements

- Standard Bayer import must avoid full-frame Preview-only work when the displayed source is at most 1024px on its longest edge.
- Preview may use camera white level instead of scanning the complete sensor for an exposure-specific maximum, provided the multi-camera display quality contract remains satisfied.
- Export must keep its fresh, full-resolution, exact LibRaw path and must not read Preview pixels.
- Continuous EV input must keep publishing monotonically newer exact-color 384px interaction frames for the same file and LUT. A frame may briefly trail the latest control value, but it must never replace a newer generation.
- A file or LUT change must invalidate older interaction results. Only the exact current 1024px settled recipe may enable export.
- The production Chromium acceptance fixture must meet the initial, isolated edit, LUT, and continuous-input budgets in the web SSOT.
- An optimization is retained only when a repeatable production benchmark shows material benefit.

## Non-goals

- GPU rendering is outside this change.
- Preview color does not use a V-Log approximation unless a later benchmark demonstrates material end-to-end benefit.
- This change does not replace LibRaw RAW unpacking or add a custom X-Trans demosaic.
