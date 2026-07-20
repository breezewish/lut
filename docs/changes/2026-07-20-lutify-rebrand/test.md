# LUTify Rebrand Tests

- The production browser document title and top toolbar identify the product as LUTify.
- The `lutify` CLI exports a readable RGB16 TIFF and satisfies its text and JSON output contracts.
- A C client compiles against `lutify.h`, links `lutify_core`, calls the `lutify_*` ABI, and releases the returned buffer.
- Rust and web builds resolve only the renamed `lutify-*` crates and `lutify_core` WASM module.
- A tracked-file audit finds no former project-owned Alchemy identifiers while preserving upstream RAW Alchemy and V-Log Alchemy provenance.
