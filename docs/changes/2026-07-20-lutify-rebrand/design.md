# LUTify Rebrand Design

## Introduction

Brand identity is part of each public and operational interface. A complete rename must keep code and documentation aligned while preserving truthful third-party provenance.

## Detailed Design

LUTify is the only name for project-owned product surfaces. The lowercase `lutify` prefix identifies filesystem paths, Rust and npm packages, the CLI binary, the C ABI, WASM output, browser persistence, performance instrumentation, temporary files, and downloads. Rust-compatible identifiers use `lutify_`; C types use `Lutify`.

RAW Alchemy remains an upstream proper name. Its git submodule path and URL remain unchanged. Descriptions of decoder settings inherited from it explicitly say “upstream RAW Alchemy” so readers cannot mistake the baseline for LUTify ownership. V-Log Alchemy also retains its upstream name because it identifies the external LUT source.

No aliases or migration fallbacks retain former project-owned names. This keeps each interface single-purpose and makes stale integrations fail visibly.

## Trade-offs

The CLI, C ABI, Rust package names, generated WASM module name, browser storage keys, and instrumentation names change incompatibly. Compatibility aliases would preserve the exact ambiguity the rebrand removes, so they are excluded.

## Test Plan

Run Rust formatting, tests, Clippy, the C API smoke test, web unit tests, the production build, and browser end-to-end tests. Search tracked files for remaining Alchemy references and review each result as either RAW Alchemy or V-Log Alchemy upstream provenance.

## Open Questions

None.
