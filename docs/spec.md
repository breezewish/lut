# LUTify Product Specification

## Introduction

LUTify is a static browser application for local camera RAW processing. It provides an approachable GUI and a reusable Rust computation core while keeping photographs off servers.

## Goals

- Process one or many RAW files entirely on the user's device.
- Compare a neutral base rendering with a selected built-in V-Log Alchemy look.
- Establish a useful per-photo exposure automatically, preserve manual EV adjustment, and export full-resolution 16-bit TIFF files.
- Provide the same corrected color pipeline to browser WASM and a native CLI.
- Make numerical assumptions, unsupported inputs, and failures explicit.

## Non-goals

- Lens profile correction.
- Camera-specific Panasonic Standard adapter LUTs.
- Server storage, accounts, or sharing.
- Claiming verified output color management for CUBE files without output metadata.

## User journey

The user selects or drops RAW files, sees an embedded camera preview while the selected file decodes, receives a useful scene-metered rendering, searches or chooses a built-in look, adjusts EV, compares Base and LUT previews, and exports either the selected file or the queue. Batch export processes one eligible file at a time, reports progress, can stop after the current file, and downloads one ZIP with completed files.

Invalid RAW files, malformed LUTs, hash mismatches, and encoding failures stop the affected operation with a visible error. They never produce a successful placeholder output.

## Requirements

- The application is deployable as static files and does not make photo upload requests.
- The browser computes and caches one matrix-metered automatic EV baseline per photo; the visible adjustment is relative to that baseline.
- Base preview is `LibRaw ProPhoto D65 Linear → automatic baseline + relative EV → neutral Reinhard shoulder → sRGB display`.
- LUT preview and export are `LibRaw ProPhoto D65 Linear → automatic baseline + relative EV → V-Gamut D65 → V-Log → LUT → display or RGB16 TIFF`.
- V-Log preserves negative values; only LUT lookup clamps to its declared domain.
- Camera-Match Boost is off in corrected-v2.
- Full-resolution export writes uncompressed RGB16 TIFF to minimize local export latency.
- The 27 creative LUTs are pinned by source commit and SHA-256, grouped by source camera family, and requested concurrently at startup through the browser cache.
- Unknown LUT output semantics remain labeled as unverified.
- The CLI supports `--output text|json`, `--json`, and `--color auto|always|never`.

Domain details are normative in `docs/ssot/processing/spec.md`, `docs/ssot/web/spec.md`, and `docs/ssot/cli/spec.md`.
