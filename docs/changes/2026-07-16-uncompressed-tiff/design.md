# Uncompressed TIFF Export Design

## Introduction

TIFF encoding writes RGB16 strips without compression or a horizontal predictor. This removes the former dominant non-LibRaw export cost while preserving the bounded-memory strip pipeline shared by native and WASM callers.

## Background

On the 6240 × 4168 Sony fixture, Deflate level 6 spent 8.15 seconds to reduce the TIFF from 156.05 MB to 122.55 MB. Deflate level 1 spent 4.32 seconds and produced 161.87 MB, making it slower and larger than uncompressed output. Uncompressed TIFF encoding took 0.53 seconds and reduced the measured Chromium export from 26.79 seconds to 19.23 seconds. WebKit TIFF encoding fell from 8.89 seconds to 0.40 seconds.

## Goals and Non-goals

### Goals

- Remove TIFF compression work from browser and native export.
- Keep approximately 1 MB source and quantized strips.
- Keep one product behavior and one diagnostic vocabulary across browser, CLI, Rust, and C callers.
- Remove project-owned Deflate, predictor, and zlib configuration and tests.

### Non-goals

- This change does not alter RAW decoding or color output.
- This change does not introduce an encoding adapter seam; only one TIFF representation remains.
- This change does not compress batch ZIP entries.

## Detailed Design

`Rgb16TiffWriter` declares TIFF compression code 1 and writes each little-endian RGB16 strip directly. `ColorPipeline` still fuses color calculation and quantization into bounded strips, and the WASM encoder still separates strip rendering from TIFF writing so each phase remains measurable. Export timings name the latter phase `tiffEncodingMs`.

The final TIFF is larger, so the Rust-owned encoded output and browser Blob grow by about 33.5 MB for the Sony fixture. The existing transfer-of-ownership and streaming pass-through ZIP design remains unchanged; no additional full-image allocation is introduced.

## Tradeoffs

Uncompressed output favors local latency over disk and batch archive size. It also removes compression-level tuning and produces the simplest, most widely readable TIFF representation. Retaining level 1 would add implementation and interface complexity while performing worse than uncompressed output on the acceptance fixture.

`tiff-writer` still contains unused codec support internally. Forking it only to remove transitive codec code would add ownership without changing the project interface or linked export path, so the project removes only its direct `flate2` configuration.

## Test Plan

- Decode core TIFF output and assert compression code 1, RGB16 samples, dimensions, and bounded strip traversal.
- Build and test the native CLI, C interface, and WASM package.
- Decode browser single and batch output as uncompressed TIFF.
- Compare full-resolution Sony browser and native samples within one code value.
- Record the production Chromium TIFF encoding phase, total export time, Blob size, and exact output size.

## Unresolved Questions

None.

## Appendix: Measured Fixture

The performance evidence uses `vendor/LibRaw-Wasm/example-sony.ARW`, SHA-256 `3b4dca9296944931a0deb4b6456685985e326aef884c32d9c5df4fc9f64d7e2c`, at 6240 × 4168 pixels.
