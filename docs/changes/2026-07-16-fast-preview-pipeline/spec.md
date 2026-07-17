# Fast Preview Pipeline Specification

## Introduction

RAW selection must produce useful, processed feedback without performing export-quality work on pixels that cannot be displayed. Preview may trade local detail for speed, while export remains exact and independent.

## Requirements

- An embedded JPEG is a labeled immediate placeholder, never the processed result or LUT source.
- The first processed comparison has longest edge 384. The settled comparison has longest edge 1024.
- Preview may differ from export in edge detail, noise, moiré, and isolated pixels. It must preserve orientation, crop, frame coverage, exposure, white balance, highlight behavior, and LUT meaning.
- Full-resolution export sampled to the same size and Preview must have RGB8 mean absolute difference at most 12 codes, p99 absolute difference at most 80 codes, and per-channel mean signed difference within 2 codes on the accepted camera fixtures.
- The production Sony fixture must show an embedded JPEG within 0.3 seconds, a cold settled Preview within 2 seconds, a warm first processed Preview at p95 below 1 second, and a warm settled Preview at p95 below 1.5 seconds.
- EV first-frame p95 remains below 0.2 seconds. EV and first-access LUT settled p95 remain below 0.5 seconds. Cached LUT first-frame p95 remains below 0.2 seconds.
- Export rereads the original file and performs a fresh full-resolution decode. Preview pixels never enter export.
- Legacy diagonal Fujifilm Super CCD files fail explicitly because the pinned LibRaw full and half-size paths do not have compatible color output. Modern X-Trans RAF remains supported.

## Non-goals

- Preview is not a pixel-identical miniature export.
- Embedded JPEG color is not normalized to the RAW pipeline.
- Full RAW decompression is not avoided; LibRaw must still unpack the sensor data.
