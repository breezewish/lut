# Uncompressed TIFF Export Specification

## Introduction

LUTify exports uncompressed interleaved RGB16 TIFF files. The change minimizes local export latency without changing corrected-v2 color values, quantization, dimensions, or TIFF compatibility.

## Requirements

- Selected and batch export use the same uncompressed TIFF representation in the browser and CLI.
- Batch ZIP entries remain pass-through and do not reintroduce compression.
- Export diagnostics report TIFF encoding rather than a compression implementation.
- The 6240 × 4168 Sony acceptance fixture produces 156,051,306 TIFF bytes and completes browser TIFF encoding below 1 second on the benchmark host.
- Decoded browser and native output remain within one code value of each other.

## Non-goals

- No compression-level setting is exposed.
- No alternative compressed export mode is retained.
- RAW decoding and color processing algorithms do not change.
