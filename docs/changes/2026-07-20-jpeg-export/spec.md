# TIFF and JPEG Export Specification

## Introduction

LUTify lets users choose TIFF or JPEG before exporting the current full-resolution recipe.

## Background

Export previously produced only uncompressed RGB16 TIFF. That format preserves 16-bit code values for editing but is unnecessarily large for review, sharing, and delivery workflows that accept JPEG.

## Goals

- Keep TIFF as the default 16-bit output.
- Add full-resolution JPEG output at fixed quality 95.
- Apply one selected format consistently to a single download or every entry in a batch ZIP.
- Preserve local-only, sequential, bounded-memory processing and explicit failures.

## Non-goals

- Exposing adjustable JPEG quality, chroma subsampling, metadata, or color profiles.
- Changing the CLI or C API from their TIFF contract.
- Inferring an output ICC profile from undocumented LUT files.

## Product Behavior

Output shows a labeled format selector with `TIFF · 16-bit` and `JPEG · Quality 95`. The primary action names the selected format. TIFF downloads use `.tif` and `image/tiff`; JPEG downloads use `.jpg` and `image/jpeg`. Batch ZIP entries use the selected extension. Format cannot change while export is active.

JPEG contains the same full-resolution corrected-v2 recipe as TIFF, rounded from RGB16 to RGB8 before quality-95 JPEG compression. A JPEG failure is reported as an export failure and never produces a successful placeholder file.
