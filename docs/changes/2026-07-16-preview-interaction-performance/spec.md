# Preview Interaction Performance

## Introduction

The processed comparison behaves like an interactive image editor after RAW decode. Exposure and look changes show exact recipe color promptly and retain a detailed final preview.

## Requirements

- EV input shows a recipe-correct preview frame with p95 below 0.2 seconds.
- LUT selection updates the settled preview with p95 below 0.5 seconds.
- The settled comparison remains longest-edge 1024 and completes with p95 below 0.5 seconds for EV input.
- Interaction frames may use longest-edge 384, but may not approximate color.
- Obsolete recipes never update a canvas.
- Export remains disabled until the current recipe reaches settled resolution.
- Full-resolution export color and precision do not change.

The performance fixture, sample count, and measured boundary are defined in `docs/ssot/web/spec.md`.
