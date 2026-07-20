# Documentation

`docs/spec.md` and `docs/design.md` define the product-wide behavior and architecture. Domain source-of-truth documents live under `docs/ssot/`:

- `processing`: decode and color pipeline contracts.
- `web`: private browser workflow and interface behavior.
- `cli`: native command-line behavior.

`docs/changes/2026-07-16-browser-lutify/` records the initial migration. The same-day RAW decode, preview interaction performance, and uncompressed TIFF folders contain their benchmark evidence and scoped decisions. `docs/changes/2026-07-20-lutify-rebrand/` defines the boundary between LUTify-owned names and preserved upstream RAW Alchemy provenance. Product behavior belongs in `spec.md`, technical decisions in `design.md`, and one-sentence end-to-end cases in `test.md`.
